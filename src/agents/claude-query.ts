import 'server-only';

import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { redactText } from '@/core/redact';
import { planSpawn } from '@/process/exec';
import { killTree } from '@/process/spawn';
import { claudeBinary } from './claude-code';

/**
 * One-shot, read-only, structured query against the local Claude Code CLI.
 *
 * This is the mechanism behind the `claude-cli` transformer and reviewer
 * providers. It exists because it needs no API key: the CLI's own
 * authentication is reused, so both optional layers work out of the box on a
 * machine that already has Claude Code set up.
 *
 * Read-only is enforced by the CLI, not by convention:
 *  - `--tools ""` removes every tool, so there is no Write, Edit or Bash to
 *    call. The model physically cannot modify a file.
 *  - `--safe-mode` skips CLAUDE.md, skills, plugins, hooks and MCP servers, so
 *    a target repository cannot inject instructions into a review.
 *  - `--no-session-persistence` keeps these queries out of the session history
 *    that implementation runs resume from.
 */

export interface ClaudeQueryOptions {
  prompt: string;
  systemPrompt?: string;
  /** JSON Schema for the response. Returned parsed in `structured`. */
  jsonSchema?: unknown;
  model?: string | null;
  effort?: string | null;
  /** Working directory. Read-only anyway; affects nothing but diagnostics. */
  cwd?: string;
  timeoutMs?: number;
  maxBudgetUsd?: number;
  signal?: AbortSignal;
}

export interface ClaudeQueryResult {
  ok: boolean;
  /** Parsed `structured_output` when a schema was supplied. */
  structured: unknown;
  /** Raw final text. */
  text: string | null;
  costUsd: number | null;
  durationMs: number | null;
  error: string | null;
  exitCode: number | null;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export async function claudeQuery(options: ClaudeQueryOptions): Promise<ClaudeQueryResult> {
  const {
    prompt,
    systemPrompt,
    jsonSchema,
    model,
    effort,
    cwd = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBudgetUsd,
    signal,
  } = options;

  // The prompt goes over stdin, never as an argument.
  const args: string[] = [
    '--print',
    '--output-format',
    'json',
    // No tools at all: this is the read-only guarantee.
    '--tools',
    '',
    '--safe-mode',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--permission-prompts',
    'none',
  ];

  if (systemPrompt) args.push('--system-prompt', systemPrompt);
  if (jsonSchema) args.push('--json-schema', JSON.stringify(jsonSchema));
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (typeof maxBudgetUsd === 'number' && maxBudgetUsd > 0) {
    args.push('--max-budget-usd', String(maxBudgetUsd));
  }

  const start = Date.now();
  const plan = planSpawn(claudeBinary(), args);

  let child;
  try {
    child = spawn(plan.file, plan.args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      detached: process.platform !== 'win32',
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
    });
  } catch (err) {
    return {
      ok: false,
      structured: null,
      text: null,
      costUsd: null,
      durationMs: Date.now() - start,
      error: `Could not start ${claudeBinary()}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      exitCode: null,
    };
  }

  if (child.stdin) {
    child.stdin.on('error', () => {
      // Reported through the close handler instead.
    });
    child.stdin.end(prompt, 'utf8');
  }

  const stdoutParts: string[] = [];
  const stderrParts: string[] = [];
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (c: string) => stdoutParts.push(c));
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (c: string) => stderrParts.push(c));

  let timedOut = false;
  let cancelled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(child, 'SIGKILL');
  }, timeoutMs);

  const onAbort = () => {
    cancelled = true;
    killTree(child, 'SIGTERM');
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let exitCode: number | null = null;
  let spawnError: string | null = null;
  child.on('error', (err) => {
    spawnError ??= err.message;
  });

  try {
    const [code] = (await once(child, 'close')) as [number | null];
    exitCode = code;
  } catch (err) {
    spawnError ??= err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  const durationMs = Date.now() - start;
  const stderr = redactText(stderrParts.join('')).trim();

  if (cancelled) {
    return { ok: false, structured: null, text: null, costUsd: null, durationMs, error: 'Cancelled', exitCode };
  }
  if (timedOut) {
    return {
      ok: false,
      structured: null,
      text: null,
      costUsd: null,
      durationMs,
      error: `Timed out after ${Math.round(timeoutMs / 1000)}s`,
      exitCode,
    };
  }
  if (spawnError) {
    return { ok: false, structured: null, text: null, costUsd: null, durationMs, error: spawnError, exitCode };
  }

  const stdout = stdoutParts.join('').trim();
  if (!stdout) {
    return {
      ok: false,
      structured: null,
      text: null,
      costUsd: null,
      durationMs,
      error: stderr || `Claude Code produced no output (exit ${exitCode})`,
      exitCode,
    };
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      structured: null,
      text: null,
      costUsd: null,
      durationMs,
      error: 'Claude Code returned output that was not JSON',
      exitCode,
    };
  }

  const isError = payload.is_error === true || payload.subtype !== 'success';
  const text = typeof payload.result === 'string' ? payload.result : null;
  const costUsd = typeof payload.total_cost_usd === 'number' ? payload.total_cost_usd : null;

  // `structured_output` is already parsed when --json-schema was supplied; fall
  // back to parsing `result` for CLI versions that only populate that.
  let structured: unknown = payload.structured_output ?? null;
  if (structured === null && jsonSchema && text) {
    try {
      structured = JSON.parse(text);
    } catch {
      structured = null;
    }
  }

  if (isError) {
    const apiError = typeof payload.api_error_status === 'string' ? payload.api_error_status : null;
    return {
      ok: false,
      structured,
      text,
      costUsd,
      durationMs,
      error: apiError ?? text ?? stderr ?? 'Claude Code reported an error',
      exitCode,
    };
  }

  return { ok: true, structured, text, costUsd, durationMs, error: null, exitCode };
}
