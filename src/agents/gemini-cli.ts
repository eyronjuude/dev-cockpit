import 'server-only';

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, runArtifactDir } from '@/core/paths';
import { redactText } from '@/core/redact';
import { describeUnavailable, planSpawn } from '@/process/exec';
import { killTree } from '@/process/spawn';
import { resolvePermissionMode, geminiPermissionArgs } from './permissions';
import { agentProcessEnv } from './spawn-env';
import type { AgentAvailability, AgentContinueInput, AgentOutcome, AgentRunStatus, AgentStartInput, AgentStreamEvent, ImplementationAgent } from './types';

export const geminiBinary = (): string => process.env.DEV_COCKPIT_GEMINI_BIN?.trim() || 'gemini';
const globalProcesses = globalThis as typeof globalThis & { __cockpitGemini?: Map<string, { child: ChildProcess; startedAt: string; sessionId: string | null }> };
const processes = () => globalProcesses.__cockpitGemini ??= new Map();

export async function checkGeminiAvailable(): Promise<AgentAvailability> {
  let child: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const plan = planSpawn(geminiBinary(), ['--version']);
    child = spawn(plan.file, plan.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: plan.windowsVerbatimArguments });
    let output = '';
    child.stdout?.on('data', (chunk) => { output = (output + chunk).slice(-8_000); });
    timer = setTimeout(() => killTree(child!, 'SIGKILL'), 20_000);
    const [code] = await once(child, 'close');
    if (code !== 0 || !/\d+\.\d+\.\d+/.test(output)) throw new Error('Gemini CLI version check failed');
    return { available: true, detail: `${geminiBinary()} — ${output.trim()}. Requires a prior Google login in Gemini CLI.`, version: output.trim() };
  } catch (error) {
    return { available: false, detail: describeUnavailable(geminiBinary(), error, 'npm install -g @google/gemini-cli, then run gemini and sign in with Google'), version: null };
  } finally { clearTimeout(timer); }
}

interface GeminiInput {
  prompt: string; cwd: string; model?: string | null; signal?: AbortSignal;
  timeoutMs: number; permissionMode?: string; sessionId?: string | null;
  additionalDirs?: readonly string[]; env?: Record<string, string>;
  readOnly?: boolean; iterationId?: string; rawLogPath?: string;
  onEvent?: (event: AgentStreamEvent) => void | Promise<void>;
}

/** Local CLI OAuth only; prompts are sent through stdin, never shell arguments. */
async function executeGemini(input: GeminiInput): Promise<AgentOutcome> {
  input.signal?.throwIfAborted();
  const start = Date.now();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-gemini-'));
  let child: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let timedOut = false;
  let sessionId = input.sessionId ?? null;
  let finalText = '';
  let stderr = '';
  let streamError: string | null = null;
  let completed = false;
  let exitCode: number | null = null;
  let callbackError: unknown;
  let chain = Promise.resolve();
  const emit = (event: AgentStreamEvent) => {
    chain = chain.then(async () => { if (!callbackError) await input.onEvent?.(event); }).catch((error) => {
      callbackError = error;
      if (child) killTree(child, 'SIGKILL');
    });
  };
  const onAbort = () => { cancelled = true; if (child) killTree(child, 'SIGKILL'); };
  try {
    const settingsPath = path.join(scratch, 'settings.json');
    // Retain cached OAuth in the real home directory, with per-call settings.
    fs.writeFileSync(settingsPath, JSON.stringify({
      security: { auth: { selectedType: 'oauth-personal', enforcedType: 'oauth-personal' } },
      ...(input.readOnly ? {
        tools: { core: ['__dev_cockpit_no_tools__'] },
        admin: { mcp: { enabled: false }, extensions: { enabled: false }, skills: { enabled: false } },
        hooksConfig: { enabled: false },
        context: { fileName: [], includeDirectories: [], includeDirectoryTree: false },
      } : {}),
    }));
    const args = ['--output-format', 'stream-json', ...geminiPermissionArgs(input.readOnly ? 'default' : resolvePermissionMode(input.permissionMode))];
    if (input.readOnly) args.push('--extensions', 'none');
    if (input.model) args.push('--model', input.model);
    if (sessionId) args.push('--resume', sessionId);
    for (const dir of input.additionalDirs ?? []) args.push('--include-directories', dir);
    const plan = planSpawn(geminiBinary(), args);
    const env = agentProcessEnv(input.env);
    // Never consume API keys/Vertex credits even if inherited from the server.
    for (const key of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS']) delete env[key];
    env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = settingsPath;
    child = spawn(plan.file, plan.args, {
      cwd: input.readOnly ? scratch : input.cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true, windowsVerbatimArguments: plan.windowsVerbatimArguments, detached: process.platform !== 'win32',
    });
    if (input.iterationId) processes().set(input.iterationId, { child, sessionId, startedAt: new Date().toISOString() });
    const handleLine = (line: string) => {
      if (!line.trim()) return;
      if (input.rawLogPath) fs.appendFileSync(input.rawLogPath, `${redactText(line)}\n`);
      let event: Record<string, unknown>;
      try { event = JSON.parse(line); } catch { return; }
      if (!event || typeof event !== 'object') return;
      if (event.type === 'init' && typeof event.session_id === 'string') {
        sessionId = event.session_id;
        const active = input.iterationId ? processes().get(input.iterationId) : null;
        if (active) active.sessionId = sessionId;
        emit({ kind: 'session', sessionId, model: typeof event.model === 'string' ? event.model : input.model ?? null, permissionMode: input.permissionMode ?? null });
      }
      if (event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string') {
        const text = redactText(event.content);
        finalText = (finalText + text).slice(-2_000_000);
        emit({ kind: 'text', text });
      }
      if (event.type === 'tool_use') emit({ kind: 'tool_start', toolUseId: String(event.tool_id ?? ''), tool: String(event.tool_name ?? 'tool'), input: event.parameters });
      if (event.type === 'tool_result') emit({ kind: 'tool_end', toolUseId: String(event.tool_id ?? ''), tool: String(event.tool_name ?? 'tool'), isError: event.status === 'error', summary: redactText(String(event.output ?? '')).slice(-4_000) });
      if (event.type === 'error' && event.severity !== 'warning') streamError = redactText(String(event.message ?? 'Gemini CLI error'));
      if (event.type === 'result') {
        completed = event.status === 'success';
        if (!completed) streamError = redactText(JSON.stringify(event.error ?? 'Gemini CLI did not succeed'));
      }
    };
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      }
      if (buffer.length > 4_000_000) { streamError = 'Gemini CLI output exceeded the stream limit'; killTree(child!, 'SIGKILL'); buffer = ''; }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr = (stderr + redactText(chunk)).slice(-16_000); });
    child.stdin?.on('error', () => { /* Process exit reports early stdin closure. */ });
    const closed = once(child, 'close');
    child.stdin?.end(input.prompt, 'utf8');
    timer = setTimeout(() => { timedOut = true; killTree(child!, 'SIGKILL'); }, input.timeoutMs);
    input.signal?.addEventListener('abort', onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
    [exitCode] = await closed as [number | null];
    if (buffer.trim()) handleLine(buffer);
    await chain;
    if (callbackError) throw callbackError;
    const errorMessage = cancelled ? 'Cancelled' : timedOut ? 'Gemini CLI timed out' : streamError ??
      (exitCode !== 0 ? stderr.trim() || `Gemini CLI exited with code ${exitCode}` : !completed || !finalText.trim() ? 'Gemini CLI produced no completed answer' : null);
    return { ok: !errorMessage, errorMessage, sessionId, finalText: finalText.trim() || null,
      exitCode, numTurns: null, durationMs: Date.now() - start, costUsd: null, usage: null,
      cancelled, timedOut, deniedTools: [], rawLogPath: input.rawLogPath ?? null };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
    if (input.iterationId) processes().delete(input.iterationId);
    if (child && child.exitCode === null && child.signalCode === null) killTree(child, 'SIGKILL');
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export async function geminiQuery(input: { prompt: string; instructions: string; jsonSchema: unknown; model?: string | null; timeoutMs: number; signal: AbortSignal }) {
  const result = await executeGemini({ ...input, cwd: os.tmpdir(), readOnly: true,
    prompt: `${input.instructions}\n\nReturn only JSON matching this schema (no Markdown fences):\n${JSON.stringify(input.jsonSchema)}\n\nSupplied evidence:\n${input.prompt}`,
  });
  if (!result.ok) return { ok: false, structured: null, error: result.errorMessage, costUsd: null };
  try {
    const text = result.finalText!.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
    return { ok: true, structured: JSON.parse(text) as unknown, error: null, costUsd: null };
  } catch { return { ok: false, structured: null, error: 'Gemini CLI returned invalid JSON', costUsd: null }; }
}

export class GeminiCodeAgent implements ImplementationAgent {
  readonly id = 'gemini-cli';
  readonly label = 'Gemini CLI';
  checkAvailability = checkGeminiAvailable;
  startRun(input: AgentStartInput): Promise<AgentOutcome> { return this.execute(input); }
  continueRun(input: AgentContinueInput): Promise<AgentOutcome> { return this.execute(input, input.sessionId); }
  private execute(input: AgentStartInput, sessionId?: string) {
    const logDir = ensureDir(path.join(runArtifactDir(input.runId), 'agent'));
    return executeGemini({ ...input, cwd: input.worktreePath, sessionId, timeoutMs: input.timeoutMs ?? 45 * 60_000,
      rawLogPath: path.join(logDir, `${input.iterationId}.gemini-cli.jsonl`),
    });
  }
  async cancelRun(iterationId: string): Promise<boolean> {
    const active = processes().get(iterationId);
    if (!active) return false;
    killTree(active.child, 'SIGKILL'); return true;
  }
  getStatus(iterationId: string): AgentRunStatus {
    const active = processes().get(iterationId);
    return { iterationId, running: !!active, pid: active?.child.pid ?? null, startedAt: active?.startedAt ?? null, sessionId: active?.sessionId ?? null };
  }
}
