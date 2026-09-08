import 'server-only';

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { once } from 'node:events';

import { redact } from '@/core/redact';

export interface RunCommandOptions {
  /** The command line, as configured by the project. */
  command: string;
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  /** Aborting kills the process tree. */
  signal?: AbortSignal;
  /** Called with redacted chunks as they arrive, for live log streaming. */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Cap on retained output per stream. Overflow is dropped from the middle. */
  maxCaptureBytes?: number;
}

export interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  timedOut: boolean;
  aborted: boolean;
  /** Set when the process could not be started at all. */
  spawnError: string | null;
  /** Redaction patterns that fired on the captured output. */
  redactionHits: string[];
}

const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_MAX_CAPTURE = 2_000_000;

/**
 * Project-configured command lines run through the platform shell, because
 * `pnpm test` needs PATHEXT resolution on Windows that bare `spawn` does not do.
 *
 * Node's own `shell: true` is used rather than a hand-rolled cmd.exe
 * invocation: getting Windows verbatim-argument quoting right by hand silently
 * mangles the command, which an earlier version of this file did.
 *
 * This is the reason `CommandSource` exists. Only project configuration ever
 * reaches a shell here — never model output, and never a run request.
 */

/** Bounded accumulator: keeps the head and tail and notes what it dropped. */
class BoundedBuffer {
  private head: string[] = [];
  private tail: string[] = [];
  private headBytes = 0;
  private tailBytes = 0;
  private dropped = 0;

  constructor(private readonly limit: number) {}

  push(chunk: string): void {
    const bytes = Buffer.byteLength(chunk);
    const halfLimit = Math.floor(this.limit / 2);

    if (this.headBytes < halfLimit) {
      this.head.push(chunk);
      this.headBytes += bytes;
      return;
    }

    this.tail.push(chunk);
    this.tailBytes += bytes;
    while (this.tailBytes > halfLimit && this.tail.length > 1) {
      const removed = this.tail.shift();
      if (removed === undefined) break;
      this.tailBytes -= Buffer.byteLength(removed);
      this.dropped += Buffer.byteLength(removed);
    }
  }

  value(): string {
    const head = this.head.join('');
    const tail = this.tail.join('');
    if (this.dropped === 0) return head + tail;
    return `${head}\n\n... [${this.dropped} bytes of output omitted] ...\n\n${tail}`;
  }
}

/**
 * Kills a process and its children. Windows needs taskkill because
 * `child.kill()` only reaches the shell, leaving the real command running.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } catch {
      child.kill('SIGKILL');
    }
    return;
  }

  try {
    // Negative pid targets the process group created by `detached: true`.
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
  }
}

/**
 * Runs one command to completion, capturing redacted output.
 * Never throws for a non-zero exit: the exit code is the result.
 */
export async function runCommand(options: RunCommandOptions): Promise<CommandResult> {
  const {
    command,
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env,
    signal,
    onStdout,
    onStderr,
    maxCaptureBytes = DEFAULT_MAX_CAPTURE,
  } = options;

  const startedAt = new Date().toISOString();
  const start = Date.now();

  const spawnOptions: SpawnOptions = {
    cwd,
    env: { ...process.env, ...env } as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: true,
    // A process group makes the whole tree killable on POSIX.
    detached: process.platform !== 'win32',
  };

  const stdoutBuf = new BoundedBuffer(maxCaptureBytes);
  const stderrBuf = new BoundedBuffer(maxCaptureBytes);
  const hits = new Set<string>();

  let child: ChildProcess;
  try {
    child = spawn(command, spawnOptions);
  } catch (err) {
    const finishedAt = new Date().toISOString();
    return {
      command,
      cwd,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      durationMs: Date.now() - start,
      startedAt,
      finishedAt,
      timedOut: false,
      aborted: false,
      spawnError: err instanceof Error ? err.message : String(err),
      redactionHits: [],
    };
  }

  let timedOut = false;
  let aborted = false;
  let spawnError: string | null = null;

  const consume = (
    stream: NodeJS.ReadableStream | null,
    buf: BoundedBuffer,
    sink: ((chunk: string) => void) | undefined,
  ) => {
    if (!stream) return;
    stream.setEncoding('utf8');
    stream.on('data', (raw: string) => {
      const { text, hits: chunkHits } = redact(raw);
      for (const hit of chunkHits) hits.add(hit);
      buf.push(text);
      sink?.(text);
    });
  };

  consume(child.stdout, stdoutBuf, onStdout);
  consume(child.stderr, stderrBuf, onStderr);

  child.on('error', (err) => {
    spawnError ??= err.message;
  });

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killTree(child, 'SIGKILL');
        }, timeoutMs)
      : null;

  const onAbort = () => {
    aborted = true;
    killTree(child, 'SIGTERM');
    // Escalate if it ignores the polite request.
    setTimeout(() => killTree(child, 'SIGKILL'), 5_000).unref();
  };

  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;

  try {
    const [code, sig] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
    exitCode = code;
    exitSignal = sig;
  } catch (err) {
    spawnError ??= err instanceof Error ? err.message : String(err);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  const finishedAt = new Date().toISOString();

  return {
    command,
    cwd,
    exitCode,
    signal: exitSignal,
    stdout: stdoutBuf.value(),
    stderr: stderrBuf.value(),
    durationMs: Date.now() - start,
    startedAt,
    finishedAt,
    timedOut,
    aborted,
    spawnError,
    redactionHits: [...hits],
  };
}

/** True when the command finished cleanly and was not killed. */
export function succeeded(result: CommandResult): boolean {
  return result.spawnError === null && !result.timedOut && !result.aborted && result.exitCode === 0;
}
