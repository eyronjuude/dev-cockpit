import 'server-only';

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { redactText } from '@/core/redact';
import { ensureDir, runArtifactDir } from '@/core/paths';
import { planSpawn, resolveExecutable } from '@/process/exec';
import { killTree } from '@/process/spawn';
import { claudePermissionArgs, resolvePermissionMode } from './permissions';
import { NdjsonSplitter, parseStreamMessage, summariseToolInput } from './stream-parser';
import type {
  AgentAvailability,
  AgentContinueInput,
  AgentOutcome,
  AgentRunStatus,
  AgentStartInput,
  AgentStreamEvent,
  ImplementationAgent,
} from './types';

const execFileAsync = promisify(execFile);

interface ActiveProcess {
  child: ChildProcess;
  iterationId: string;
  startedAt: string;
  sessionId: string | null;
}

/** Live processes, keyed by iteration, so cancel and status can find them. */
const GLOBAL_KEY = '__devCockpitClaudeProcesses__' as const;
type GlobalWithProcs = typeof globalThis & { [GLOBAL_KEY]?: Map<string, ActiveProcess> };

function activeProcesses(): Map<string, ActiveProcess> {
  const g = globalThis as GlobalWithProcs;
  g[GLOBAL_KEY] ??= new Map();
  return g[GLOBAL_KEY];
}

export function claudeBinary(): string {
  return process.env.DEV_COCKPIT_CLAUDE_BIN?.trim() || 'claude';
}

const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * Claude Code as an implementation agent, driven through its supported
 * programmatic interface: `--print --output-format stream-json`.
 *
 * Session continuity is the whole reason the run model stores
 * `agentSessionId`: a change request resumes that session with `--resume`, so
 * the implementer keeps the context it built rather than starting cold.
 */
export class ClaudeCodeAgent implements ImplementationAgent {
  readonly id = 'claude-code';
  readonly label = 'Claude Code';

  async checkAvailability(): Promise<AgentAvailability> {
    const bin = claudeBinary();
    const plan = planSpawn(bin, ['--version']);
    try {
      const { stdout } = await execFileAsync(plan.file, plan.args, {
        windowsHide: true,
        timeout: 20_000,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
      });
      const version = stdout.trim();
      const resolved = resolveExecutable(bin).resolvedPath ?? bin;
      return { available: true, detail: `${resolved} — ${version}`, version };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        available: false,
        detail: `Could not run "${bin} --version": ${message}`,
        version: null,
      };
    }
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
    // Claude Code flushes on SIGTERM; escalate only if it does not exit.
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

  /* ---------------------------------------------------------------- */

  private buildArgs(input: AgentStartInput, resumeSessionId: string | null, newSessionId: string) {
    // The prompt is NOT passed as an argument. It is written to stdin, which
    // keeps arbitrary user text off any command line — the difference matters
    // on Windows, where a shim launch has to go through cmd.exe.
    const args: string[] = [
      '--print',
      '--output-format',
      'stream-json',
      // stream-json in print mode requires verbose; without it the CLI exits.
      '--verbose',
    ];

    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    } else {
      // A caller-chosen UUID means the session id is known before the process
      // starts, so a crash before the init message still leaves a resumable id.
      args.push('--session-id', newSessionId);
    }

    // Unattended by construction: the default posture skips permission checks
    // outright (`--dangerously-skip-permissions`), because nobody is present to
    // approve anything and a refused Bash call costs the run an iteration.
    args.push(...claudePermissionArgs(resolvePermissionMode(input.permissionMode)));

    // Belt and braces for every mode: anything that would still block on a
    // prompt is denied rather than hanging a headless run forever.
    args.push('--permission-prompts', 'none');

    if (input.model) args.push('--model', input.model);
    if (input.effort) args.push('--effort', input.effort);

    for (const dir of input.additionalDirs ?? []) {
      if (dir.trim()) args.push('--add-dir', dir);
    }

    return args;
  }

  private async execute(
    input: AgentStartInput,
    resumeSessionId: string | null,
  ): Promise<AgentOutcome> {
    const { iterationId, worktreePath, onEvent, signal } = input;
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = new Date().toISOString();

    // Pre-allocated so a resumable id exists even if the process dies early.
    const plannedSessionId = randomUUID();
    const args = this.buildArgs(input, resumeSessionId, plannedSessionId);

    const logDir = ensureDir(path.join(runArtifactDir(input.runId), 'agent'));
    const rawLogPath = path.join(logDir, `${iterationId}.stream.jsonl`);
    const logStream = fs.createWriteStream(rawLogPath, { flags: 'a' });

    let sessionId: string | null = resumeSessionId ?? null;
    let resultOk: boolean | null = null;
    let finalText: string | null = null;
    let numTurns: number | null = null;
    let durationMs: number | null = null;
    let costUsd: number | null = null;
    let errorMessage: string | null = null;
    let deniedTools: string[] = [];
    let timedOut = false;
    let cancelled = false;
    let spawnError: string | null = null;
    const stderrChunks: string[] = [];

    // Tool names arrive on tool_use and are needed again on tool_result, which
    // only carries the id.
    const toolNames = new Map<string, string>();

    const emit = async (event: AgentStreamEvent) => {
      await onEvent(event);
    };

    const handleParsed = async (value: unknown) => {
      const { events, sessionId: lineSession } = parseStreamMessage(value);
      if (lineSession) sessionId = lineSession;

      for (const event of events) {
        switch (event.kind) {
          case 'session':
            sessionId = event.sessionId;
            await emit(event);
            break;
          case 'tool_start':
            toolNames.set(event.toolUseId, event.tool);
            await emit(event);
            break;
          case 'tool_end':
            await emit({
              ...event,
              tool: toolNames.get(event.toolUseId) ?? event.tool,
            });
            break;
          case 'result':
            resultOk = event.ok;
            finalText = event.finalText;
            numTurns = event.numTurns;
            durationMs = event.durationMs;
            costUsd = event.costUsd;
            errorMessage = event.errorMessage;
            deniedTools = event.deniedTools;
            await emit(event);
            break;
          default:
            await emit(event);
        }
      }
    };

    // Parsing is synchronous per line but handlers are async; serialise them so
    // events reach the store in wire order.
    let chain: Promise<void> = Promise.resolve();
    const splitter = new NdjsonSplitter((value, raw) => {
      logStream.write(`${raw}\n`);
      if (value === undefined) {
        const text = redactText(raw).trim();
        if (text) {
          chain = chain.then(() => emit({ kind: 'notice', text, level: 'notice' }));
        }
        return;
      }
      chain = chain.then(() => handleParsed(value));
    });

    const plan = planSpawn(claudeBinary(), args);

    let child: ChildProcess;
    try {
      child = spawn(plan.file, plan.args, {
        cwd: worktreePath,
        // stdin carries the prompt, then closes. Leaving it open would make the
        // CLI wait; closing it without writing makes it run with no prompt.
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          // Keeps the CLI from emitting decorative output it would otherwise
          // add when it thinks a human is watching.
          CI: '1',
          FORCE_COLOR: '0',
        },
      });
    } catch (err) {
      logStream.end();
      return {
        ok: false,
        sessionId: resumeSessionId ?? null,
        exitCode: null,
        finalText: null,
        numTurns: null,
        durationMs: null,
        costUsd: null,
        errorMessage: `Could not start ${claudeBinary()}: ${
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
      sessionId: resumeSessionId ?? plannedSessionId,
    });

    if (child.stdin) {
      child.stdin.on('error', () => {
        // The CLI can exit before the write drains; the close handler reports it.
      });
      child.stdin.end(input.prompt, 'utf8');
    }

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => splitter.push(chunk));

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

    splitter.flush();
    await chain;
    await new Promise<void>((resolve) => logStream.end(resolve));

    const stderr = stderrChunks.join('').trim();

    if (cancelled) {
      errorMessage = 'Cancelled';
    } else if (timedOut) {
      errorMessage = `Timed out after ${Math.round(timeoutMs / 1000)}s`;
    } else if (spawnError) {
      errorMessage = spawnError;
    } else if (resultOk === null && exitCode !== 0) {
      // No result message and a bad exit: report the process failure honestly
      // instead of guessing that the work succeeded.
      errorMessage =
        stderr.split('\n').filter(Boolean).slice(-3).join(' ') ||
        `Claude Code exited with code ${exitCode}`;
    }

    const ok = !cancelled && !timedOut && spawnError === null && exitCode === 0 && resultOk !== false;

    return {
      ok,
      sessionId: sessionId ?? resumeSessionId ?? plannedSessionId,
      exitCode,
      finalText,
      numTurns,
      durationMs,
      costUsd,
      errorMessage: ok ? null : errorMessage,
      cancelled,
      timedOut,
      deniedTools,
      rawLogPath,
    };
  }
}

export { summariseToolInput };
