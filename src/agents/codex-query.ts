import 'server-only';

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { redactText } from '@/core/redact';
import { planSpawn, resolveExecutable } from '@/process/exec';
import { killTree } from '@/process/spawn';

/**
 * One-shot, read-only, structured query against the local Codex CLI.
 *
 * The OpenAI counterpart of `claude-query.ts`, and deliberately the same shape:
 * spawn a CLI the user has already authenticated, get structured output back,
 * hold no credentials of our own. That is what lets the transformer and
 * reviewer run on a ChatGPT plan with no API key.
 *
 * Read-only is enforced by the CLI:
 *  - `--sandbox read-only` — Codex is an agent and *can* edit files, so this is
 *    the flag that makes the contract structural rather than a promise.
 *  - `--ignore-user-config` and `--ignore-rules` — a target repository's
 *    AGENTS.md cannot inject instructions into a review.
 *  - `--ephemeral` — these queries stay out of the session history.
 *
 * One honest difference from the Claude adapter: Claude Code has
 * `--system-prompt`, which replaces the system prompt outright. Codex has no
 * equivalent, so the instruction rides at the top of the prompt body instead.
 * The output schema does the constraining either way.
 */

export interface CodexQueryOptions {
  prompt: string;
  /** Prepended to the prompt, since Codex has no system-prompt slot. */
  instructions?: string;
  /** JSON Schema for the response. Written to a temp file for `--output-schema`. */
  jsonSchema?: unknown;
  model?: string | null;
  /** minimal | low | medium | high | xhigh */
  effort?: string | null;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CodexQueryResult {
  ok: boolean;
  structured: unknown;
  text: string | null;
  durationMs: number | null;
  error: string | null;
  exitCode: number | null;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export function codexBinary(): string {
  return process.env.DEV_COCKPIT_CODEX_BIN?.trim() || 'codex';
}

export interface CodexAvailability {
  available: boolean;
  detail: string;
  version: string | null;
}

export async function checkCodexAvailable(): Promise<CodexAvailability> {
  const bin = codexBinary();
  const plan = planSpawn(bin, ['--version']);

  try {
    const child = spawn(plan.file, plan.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
    });

    const out: string[] = [];
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => out.push(c));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => out.push(c));

    const timer = setTimeout(() => killTree(child, 'SIGKILL'), 20_000);
    let spawnError: string | null = null;
    child.on('error', (err) => {
      spawnError ??= err.message;
    });

    const [code] = (await once(child, 'close')) as [number | null];
    clearTimeout(timer);

    if (spawnError || code !== 0) {
      return {
        available: false,
        detail: `Could not run "${bin} --version": ${spawnError ?? `exit ${code}`}`,
        version: null,
      };
    }

    const version = out.join('').trim().split('\n')[0] ?? '';
    const resolved = resolveExecutable(bin).resolvedPath ?? bin;
    return { available: true, detail: `${resolved} — ${version}`, version: version || null };
  } catch (err) {
    return {
      available: false,
      detail: `Could not run "${bin} --version": ${
        err instanceof Error ? err.message : String(err)
      }`,
      version: null,
    };
  }
}

export async function codexQuery(options: CodexQueryOptions): Promise<CodexQueryResult> {
  const {
    prompt,
    instructions,
    jsonSchema,
    model,
    effort,
    cwd = process.cwd(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
  } = options;

  const start = Date.now();

  // `--output-schema` and `-o` both take file paths, so a scratch directory is
  // needed for the round trip. Removed in the finally block.
  const scratch = path.join(os.tmpdir(), `dev-cockpit-codex-${randomUUID()}`);
  await fsp.mkdir(scratch, { recursive: true });
  const schemaPath = path.join(scratch, 'schema.json');
  const outPath = path.join(scratch, 'last-message.txt');

  const cleanup = async () => {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  };

  try {
    // `codex exec -` reads the prompt from stdin, so untrusted text never
    // reaches a command line — the same guarantee as the Claude adapter.
    const args: string[] = [
      'exec',
      '-',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--output-last-message',
      outPath,
    ];

    if (jsonSchema) {
      await fsp.writeFile(schemaPath, JSON.stringify(jsonSchema), 'utf8');
      args.push('--output-schema', schemaPath);
    }
    if (model) args.push('--model', model);
    if (effort) args.push('-c', `model_reasoning_effort=${effort}`);

    const plan = planSpawn(codexBinary(), args);

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
        durationMs: Date.now() - start,
        error: `Could not start ${codexBinary()}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        exitCode: null,
      };
    }

    if (child.stdin) {
      child.stdin.on('error', () => {
        // Reported through the close handler instead.
      });
      const body = instructions ? `${instructions}\n\n---\n\n${prompt}` : prompt;
      child.stdin.end(body, 'utf8');
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
      return { ok: false, structured: null, text: null, durationMs, error: 'Cancelled', exitCode };
    }
    if (timedOut) {
      return {
        ok: false,
        structured: null,
        text: null,
        durationMs,
        error: `Timed out after ${Math.round(timeoutMs / 1000)}s`,
        exitCode,
      };
    }
    if (spawnError) {
      return { ok: false, structured: null, text: null, durationMs, error: spawnError, exitCode };
    }

    // Prefer the file Codex was told to write; fall back to stdout.
    let text: string | null = null;
    try {
      text = (await fsp.readFile(outPath, 'utf8')).trim();
    } catch {
      text = redactText(stdoutParts.join('')).trim() || null;
    }

    if (exitCode !== 0) {
      return {
        ok: false,
        structured: null,
        text,
        durationMs,
        error:
          stderr.split('\n').filter(Boolean).slice(-3).join(' ') ||
          `Codex exited with code ${exitCode}`,
        exitCode,
      };
    }

    if (!text) {
      return {
        ok: false,
        structured: null,
        text: null,
        durationMs,
        error: stderr || 'Codex produced no output',
        exitCode,
      };
    }

    let structured: unknown = null;
    if (jsonSchema) {
      try {
        structured = JSON.parse(text);
      } catch {
        return {
          ok: false,
          structured: null,
          text,
          durationMs,
          error: 'Codex returned output that did not parse as JSON',
          exitCode,
        };
      }
    }

    return { ok: true, structured, text, durationMs, error: null, exitCode };
  } finally {
    await cleanup();
  }
}
