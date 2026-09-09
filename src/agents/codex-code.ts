import 'server-only';

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { redactText } from '@/core/redact';
import { ensureDir, runArtifactDir } from '@/core/paths';
import { planSpawn } from '@/process/exec';
import { killTree } from '@/process/spawn';
import { codexPermissionArgs, resolvePermissionMode } from './permissions';
import { checkCodexAvailable, codexBinary } from './codex-query';
import type {
  AgentAvailability,
  AgentContinueInput,
  AgentOutcome,
  AgentRunStatus,
  AgentStartInput,
  AgentStreamEvent,
  ImplementationAgent,
} from './types';

interface ActiveProcess {
  child: ChildProcess;
  iterationId: string;
  startedAt: string;
  sessionId: string | null;
}

const GLOBAL_KEY = '__devCockpitCodexProcesses__' as const;
type GlobalWithProcs = typeof globalThis & { [GLOBAL_KEY]?: Map<string, ActiveProcess> };

function activeProcesses(): Map<string, ActiveProcess> {
  const g = globalThis as GlobalWithProcs;
  g[GLOBAL_KEY] ??= new Map();
  return g[GLOBAL_KEY];
}

const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * Codex CLI as an implementation agent.
 *
 * Dev Cockpit already uses Codex for read-only transformer and reviewer calls.
 * This adapter is the write-capable counterpart used as a fallback when the
 * primary implementer is out of provider capacity.
 */
export class CodexCodeAgent implements ImplementationAgent {
  readonly id = 'codex-code';
  readonly label = 'Codex CLI';

  async checkAvailability(): Promise<AgentAvailability> {
    return checkCodexAvailable();
  }

  startRun(input: AgentStartInput): Promise<AgentOutcome> {
    return this.execute(input, null);
  }

  continueRun(input: AgentContinueInput): Promise<AgentOutcome> {
    return this.execute(input, input.sessionId);
  }

  async cancelRun(iterationId: string): Promise<boolean> {
    const active = activeProcesses().get(iterationId);
    if (!active) return false;
    killTree(active.child, 'SIGTERM');
    setTimeout(() => {
      if (activeProcesses().has(iterationId)) killTree(active.child, 'SIGKILL');
    }, 8_000).unref();
    return true;
  }

  getStatus(iterationId: string): AgentRunStatus {
    const active = activeProcesses().get(iterationId);
    return {
      running: active !== undefined,
      iterationId,
      pid: active?.child.pid ?? null,
      startedAt: active?.startedAt ?? null,
      sessionId: active?.sessionId ?? null,
    };
  }

  private buildArgs(
    input: AgentStartInput,
    resumeSessionId: string | null,
    outPath: string,
  ): string[] {
    const args: string[] = ['exec'];
    if (resumeSessionId) args.push('resume');

    args.push(
      '--cd',
      input.worktreePath,
      '--skip-git-repo-check',
      '--json',
      '--color',
      'never',
      '--output-last-message',
      outPath,
    );
    args.push(...codexPermissionArgs(resolvePermissionMode(input.permissionMode)));

    if (input.model) args.push('--model', input.model);
    if (input.effort) args.push('-c', `model_reasoning_effort=${input.effort}`);

    for (const dir of input.additionalDirs ?? []) {
      if (dir.trim()) args.push('--add-dir', dir);
    }

    if (resumeSessionId) args.push(resumeSessionId);
    args.push('-');
    return args;
  }

  private async execute(
    input: AgentStartInput,
    resumeSessionId: string | null,
  ): Promise<AgentOutcome> {
    const { iterationId, worktreePath, onEvent, signal } = input;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = new Date().toISOString();
    const start = Date.now();

    const logDir = ensureDir(path.join(runArtifactDir(input.runId), 'agent'));
    const rawLogPath = path.join(logDir, `${iterationId}.${this.id}.jsonl`);
    const outPath = path.join(logDir, `${iterationId}.${this.id}.last-message.md`);
    const logStream = fs.createWriteStream(rawLogPath, { flags: 'a' });

    let sessionId: string | null = resumeSessionId;
    let finalText: string | null = null;
    let timedOut = false;
    let cancelled = false;
    let spawnError: string | null = null;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const emit = async (event: AgentStreamEvent) => {
      await onEvent(event);
    };

    let chain: Promise<void> = Promise.resolve();
    const handleLine = (line: string) => {
      logStream.write(`${line}\n`);
      const trimmed = line.trim();
      if (!trimmed) return;

      stdoutChunks.push(redactText(trimmed));
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        chain = chain.then(() => emit({ kind: 'notice', text: redactText(trimmed), level: 'info' }));
        return;
      }

      const foundSession = sessionIdFromEvent(parsed);
      if (foundSession) {
        sessionId = foundSession;
        chain = chain.then(() =>
          emit({
            kind: 'session',
            sessionId: foundSession,
            model: input.model ?? null,
            permissionMode: input.permissionMode ?? null,
          }),
        );
      }

      for (const event of eventsFromCodexEvent(parsed)) {
        chain = chain.then(() => emit(event));
      }
    };

    let buffer = '';
    const pushStdout = (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        handleLine(line);
        newline = buffer.indexOf('\n');
      }
    };

    const args = this.buildArgs(input, resumeSessionId, outPath);
    const plan = planSpawn(codexBinary(), args);

    let child: ChildProcess;
    try {
      child = spawn(plan.file, plan.args, {
        cwd: worktreePath,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
        detached: process.platform !== 'win32',
        env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
      });
    } catch (err) {
      logStream.end();
      return {
        ok: false,
        sessionId: resumeSessionId,
        exitCode: null,
        finalText: null,
        numTurns: null,
        durationMs: Date.now() - start,
        costUsd: null,
        errorMessage: `Could not start ${codexBinary()}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        cancelled: false,
        timedOut: false,
        deniedTools: [],
        rawLogPath,
      };
    }

    activeProcesses().set(iterationId, {
      child,
      iterationId,
      startedAt,
      sessionId: resumeSessionId,
    });

    if (child.stdin) {
      child.stdin.on('error', () => {
        // The CLI can exit before the write drains; close reports the failure.
      });
      child.stdin.end(input.prompt, 'utf8');
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', pushStdout);

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      const text = redactText(chunk);
      stderrChunks.push(text);
      logStream.write(`[stderr] ${text}`);
    });

    child.on('error', (err) => {
      spawnError ??= err.message;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, 'SIGKILL');
    }, timeoutMs);

    const onAbort = () => {
      cancelled = true;
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), 8_000).unref();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    let exitCode: number | null = null;
    try {
      const [code] = (await once(child, 'close')) as [number | null];
      exitCode = code;
    } catch (err) {
      spawnError ??= err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      activeProcesses().delete(iterationId);
    }

    if (buffer.trim()) handleLine(buffer.replace(/\r$/, ''));
    await chain;
    await new Promise<void>((resolve) => logStream.end(resolve));

    const durationMs = Date.now() - start;
    const stderr = stderrChunks.join('').trim();

    try {
      finalText = redactText(fs.readFileSync(outPath, 'utf8')).trim() || null;
    } catch {
      finalText = finalTextFromEvents(stdoutChunks) ?? null;
    }
    try {
      fs.rmSync(outPath, { force: true });
    } catch {
      // The final message is stored through the normal artifact path below.
    }

    let errorMessage: string | null = null;
    if (cancelled) {
      errorMessage = 'Cancelled';
    } else if (timedOut) {
      errorMessage = `Timed out after ${Math.round(timeoutMs / 1000)}s`;
    } else if (spawnError) {
      errorMessage = spawnError;
    } else if (exitCode !== 0) {
      errorMessage =
        stderr.split('\n').filter(Boolean).slice(-3).join(' ') ||
        finalText ||
        `Codex CLI exited with code ${exitCode}`;
    } else if (!finalText) {
      errorMessage = stderr || 'Codex CLI produced no final message';
    }

    const ok =
      !cancelled &&
      !timedOut &&
      spawnError === null &&
      exitCode === 0 &&
      finalText !== null;

    return {
      ok,
      sessionId,
      exitCode,
      finalText,
      numTurns: null,
      durationMs,
      costUsd: null,
      errorMessage: ok ? null : errorMessage,
      cancelled,
      timedOut,
      deniedTools: [],
      rawLogPath,
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function eventType(record: Record<string, unknown>): string {
  return stringField(record, ['type', 'event', 'kind', 'name'])?.toLowerCase() ?? '';
}

function sessionIdFromEvent(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const type = eventType(record);
  const id = stringField(record, [
    'session_id',
    'sessionId',
    'thread_id',
    'threadId',
    'conversation_id',
    'conversationId',
  ]);
  if (!id) return null;
  return /session|thread|conversation|init|start|created/.test(type) ? id : null;
}

function eventsFromCodexEvent(value: unknown): AgentStreamEvent[] {
  const record = asRecord(value);
  if (!record) return [];
  const type = eventType(record);
  const text = stringField(record, ['message', 'text', 'delta', 'content', 'summary']);
  if (!text) return [];
  const redacted = redactText(text);

  if (/reason|thinking/.test(type)) return [{ kind: 'thinking', text: redacted }];
  if (/error|warning|notice/.test(type)) return [{ kind: 'notice', text: redacted, level: 'notice' }];
  if (/message|assistant|response|text|final/.test(type)) return [{ kind: 'text', text: redacted }];
  return [];
}

function finalTextFromEvents(chunks: readonly string[]): string | null {
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const parsed = parseJsonObject(chunks[i]);
    if (!parsed) continue;
    const type = eventType(parsed);
    if (!/message|assistant|response|final/.test(type)) continue;
    const text = stringField(parsed, ['message', 'text', 'content', 'summary']);
    if (text) return text;
  }
  return null;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}
