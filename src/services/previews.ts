import 'server-only';

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { AppError, errorMessage } from '@/core/errors';
import { ensureDir, isInside, runArtifactDir } from '@/core/paths';
import { redact, registerExtraSecrets } from '@/core/redact';
import { parseEnvLines, secretValuesIn } from '@/domain/validation-steps';
import type { PreviewStatus, PreviewView } from '@/domain/previews';
import type { PreviewConfigView } from './projects';
import { killTree } from '@/process/spawn';
import { refreshArtifactBytes, register } from './artifacts';
import { appendEvent } from './events';
import { requireProject } from './projects';
import { requireRun } from './runs';

/** How many log lines the Preview tab shows without opening the artifact. */
const LOG_TAIL_LINES = 200;

interface PreviewProcessState {
  runId: string;
  command: string;
  cwd: string;
  /** Where a readiness probe is sent. `url` plus the configured ready path. */
  readyUrl: string;
  readyTimeoutMs: number;
  generation: number;
  /** Ring of recent output, so the tab can show a tail without a file read. */
  tail: string[];
  child: ChildProcess;
  log: fs.WriteStream;
  status: Exclude<PreviewStatus, 'not_configured' | 'not_started'>;
  url: string;
  port: number;
  pid: number | null;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  logArtifactId: string | null;
  logPath: string;
  error: string | null;
  stopReason: string | null;
  finalized: boolean;
  closePromise: Promise<void>;
  resolveClosed: () => void;
}

const GLOBAL_KEY = '__devCockpitPreviews__' as const;
type GlobalWithPreviews = typeof globalThis & {
  [GLOBAL_KEY]?: Map<string, PreviewProcessState>;
};

const STOP_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 750;
const FETCH_TIMEOUT_MS = 1_500;

/** Survives a module reload so a restart does not reset the iframe key. */
const GENERATION_KEY = '__devCockpitPreviewGenerations__' as const;
type GlobalWithGenerations = typeof globalThis & {
  [GENERATION_KEY]?: Map<string, number>;
};

function nextGeneration(runId: string): number {
  const g = globalThis as GlobalWithGenerations;
  g[GENERATION_KEY] ??= new Map();
  const next = (g[GENERATION_KEY].get(runId) ?? 0) + 1;
  g[GENERATION_KEY].set(runId, next);
  return next;
}

function previewProcesses(): Map<string, PreviewProcessState> {
  const g = globalThis as GlobalWithPreviews;
  g[GLOBAL_KEY] ??= new Map();
  return g[GLOBAL_KEY];
}

function configuredCommand(runId: string): {
  command: string | null;
  cwd: string | null;
  preview: PreviewConfigView;
} {
  const run = requireRun(runId);
  const project = requireProject(run.projectId);
  const command = project.preview.command?.trim() || null;
  return { command, cwd: run.worktreePath, preview: project.preview };
}

/**
 * Where the preview's working directory is, and a refusal when it escapes.
 *
 * The same guard a validation step's working directory gets, for the same
 * reason: a preview started against the user's real checkout would write build
 * output into it.
 */
function resolvePreviewCwd(worktreePath: string, workingDir: string | null): string {
  if (!workingDir) return worktreePath;
  const resolved = path.resolve(worktreePath, workingDir);
  if (resolved !== worktreePath && !isInside(worktreePath, resolved)) {
    throw new AppError(`Preview working directory ${workingDir} escapes the worktree.`, {
      code: 'preview_unsafe_working_dir',
    });
  }
  return resolved;
}

/** Joins the ready path onto the base URL without doubling or dropping a slash. */
function readyUrlFor(base: string, readyPath: string): string {
  const suffix = readyPath.startsWith('/') ? readyPath : `/${readyPath}`;
  return suffix === '/' ? base : `${base}${suffix}`;
}

function isRunning(state: PreviewProcessState): boolean {
  // `unresponsive` counts: the process is alive, so Stop must still reach it.
  return (
    state.status === 'starting' ||
    state.status === 'ready' ||
    state.status === 'unresponsive'
  );
}

function toView(
  state: PreviewProcessState,
  configured: boolean,
  command: string | null,
): PreviewView {
  return {
    configured,
    command,
    running: isRunning(state),
    status: state.status,
    url: state.url,
    readyUrl: state.readyUrl,
    port: state.port,
    pid: state.pid,
    cwd: state.cwd,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    exitCode: state.exitCode,
    signal: state.signal,
    logArtifactId: state.logArtifactId,
    logPath: state.logPath,
    error: state.error,
    generation: state.generation,
    logTail: state.tail.length > 0 ? state.tail.join('') : null,
  };
}

function idlePreviewView(runId: string): PreviewView {
  const { command, cwd } = configuredCommand(runId);
  return {
    configured: command !== null,
    command,
    running: false,
    status: command === null ? 'not_configured' : 'not_started',
    url: null,
    readyUrl: null,
    port: null,
    pid: null,
    cwd,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    signal: null,
    logArtifactId: null,
    logPath: null,
    error: null,
    generation: 0,
    logTail: null,
  };
}

export function getRunPreview(runId: string): PreviewView {
  const current = previewProcesses().get(runId);
  const configured = configuredCommand(runId);
  if (!current) return idlePreviewView(runId);

  const command = configured.command ?? current.command;
  return toView(current, command !== null, command);
}

export async function startRunPreview(runId: string): Promise<PreviewView> {
  const existing = previewProcesses().get(runId);
  if (existing && isRunning(existing)) return getRunPreview(runId);

  const run = requireRun(runId);
  const project = requireProject(run.projectId);
  const config = project.preview;
  const command = config.command?.trim();
  if (!command) {
    throw new AppError('This project does not have a development command configured.', {
      code: 'preview_not_configured',
    });
  }
  if (!run.worktreePath) {
    throw new AppError('This run does not have a worktree to preview yet.', {
      code: 'preview_no_worktree',
    });
  }

  const worktreeStat = await fsp.stat(run.worktreePath).catch(() => null);
  if (!worktreeStat?.isDirectory()) {
    throw new AppError(`The run worktree is not available: ${run.worktreePath}`, {
      code: 'preview_no_worktree',
    });
  }

  const cwd = resolvePreviewCwd(run.worktreePath, config.workingDir);
  const cwdStat = await fsp.stat(cwd).catch(() => null);
  if (!cwdStat?.isDirectory()) {
    throw new AppError(`The preview working directory does not exist: ${cwd}`, {
      code: 'preview_no_working_dir',
    });
  }

  // A fixed port is a deliberate choice for a project whose configuration
  // hard-codes a URL, so a clash is reported rather than silently worked
  // around — quietly moving it would defeat the point of asking for it.
  const port =
    config.portStrategy === 'fixed' && config.fixedPort
      ? await claimFixedPort(config.fixedPort)
      : await reservePort();
  const url = `http://127.0.0.1:${port}`;
  const readyUrl = readyUrlFor(url, config.readyPath);
  const startedAt = new Date().toISOString();
  const logDir = ensureDir(path.join(runArtifactDir(runId), 'preview'));
  const logPath = path.join(logDir, `${startedAt.replace(/[:.]/g, '-')}.log`);
  const header = [
    `Dev Cockpit preview`,
    `Run: ${runId}`,
    `Command: ${command}`,
    `Worktree: ${run.worktreePath}`,
    `Working directory: ${cwd}`,
    `URL: ${url}`,
    `Readiness probe: ${readyUrl}`,
    `Port strategy: ${config.portStrategy}`,
    `Started: ${startedAt}`,
    '',
  ].join('\n');

  await fsp.writeFile(logPath, header, 'utf8');
  const artifact = await register({
    runId,
    kind: 'stdout_log',
    label: 'Preview server log',
    filePath: logPath,
    previewUrl: url,
    meta: { command, cwd, port, url, readyUrl, startedAt },
  });

  const log = fs.createWriteStream(logPath, { flags: 'a', encoding: 'utf8' });

  // Configured values never reach `process.env`, so the redactor cannot see
  // them without being told. Same gap, same fix as a validation step's env.
  const previewEnv = parseEnvLines(config.env.join('\n'));
  registerExtraSecrets(secretValuesIn(previewEnv));

  let child: ChildProcess;
  try {
    child = spawn(command, {
      cwd,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        HOSTNAME: '127.0.0.1',
        BROWSER: 'none',
        DEV_COCKPIT_PREVIEW_URL: url,
        // The project's own values win: a project that must set its own PORT
        // or HOST knows something this code does not.
        ...previewEnv,
      } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: true,
      detached: process.platform !== 'win32',
    });
  } catch (err) {
    const message = errorMessage(err);
    await new Promise<void>((resolve) => {
      log.end(`\nCould not start preview: ${message}\n`, resolve);
    });
    await refreshArtifactBytes(artifact.id);
    appendEvent({
      runId,
      type: 'preview.failed',
      level: 'error',
      message: `Preview failed to start: ${message}`,
      payload: { error: message, exitCode: null, signal: null },
    });
    throw new AppError(`Could not start preview: ${message}`, {
      code: 'preview_spawn_failed',
    });
  }

  let resolveClosed: () => void = () => {};
  const closePromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const state: PreviewProcessState = {
    runId,
    command,
    cwd,
    readyUrl,
    readyTimeoutMs: config.readyTimeoutMs,
    generation: nextGeneration(runId),
    tail: [],
    child,
    log,
    status: 'starting',
    url,
    port,
    pid: child.pid ?? null,
    startedAt,
    finishedAt: null,
    exitCode: null,
    signal: null,
    logArtifactId: artifact.id,
    logPath,
    error: null,
    stopReason: null,
    finalized: false,
    closePromise,
    resolveClosed,
  };

  previewProcesses().set(runId, state);
  pipeRedacted(child.stdout, log, state);
  pipeRedacted(child.stderr, log, state);

  child.on('error', (err) => {
    state.error = err.message;
  });

  child.once('close', (code, signal) => {
    void finalizePreview(state, code, signal);
  });

  appendEvent({
    runId,
    type: 'preview.started',
    message: `Preview starting on ${url}`,
    payload: { command, url, port, pid: state.pid, artifactId: artifact.id },
  });

  void waitForReady(state);

  return getRunPreview(runId);
}

/**
 * Stop, then start.
 *
 * One call rather than two, because sequencing it in the browser means a
 * window where a failed stop leaves the UI thinking it restarted. The stop is
 * allowed to report "nothing was running" — restarting a stopped preview is
 * just starting it.
 */
export async function restartRunPreview(runId: string): Promise<PreviewView> {
  await stopRunPreview(runId, 'Stopped for a restart');
  return startRunPreview(runId);
}

export async function stopRunPreview(
  runId: string,
  reason = 'Stopped by the user',
): Promise<boolean> {
  const state = previewProcesses().get(runId);
  if (!state || !isRunning(state)) return false;

  state.stopReason = reason;
  killTree(state.child, 'SIGTERM');
  const killTimer = setTimeout(() => {
    if (previewProcesses().get(runId) === state && isRunning(state)) {
      killTree(state.child, 'SIGKILL');
    }
  }, 5_000);
  killTimer.unref();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      state.closePromise,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, STOP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(killTimer);
    if (timeout) clearTimeout(timeout);
  }

  if (previewProcesses().get(runId) === state && isRunning(state)) {
    throw new AppError(
      `The preview did not stop within ${Math.round(STOP_TIMEOUT_MS / 1000)}s. Stop the dev server manually before removing the worktree.`,
      { code: 'preview_stop_timeout' },
    );
  }

  return true;
}

async function finalizePreview(
  state: PreviewProcessState,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): Promise<void> {
  if (state.finalized) return;
  state.finalized = true;
  state.finishedAt = new Date().toISOString();
  state.exitCode = exitCode;
  state.signal = signal;

  const stoppedByRequest = state.stopReason !== null;
  const cleanExit = exitCode === 0 && signal === null;
  if (stoppedByRequest || cleanExit) {
    state.status = 'stopped';
    state.error = null;
    appendEvent({
      runId: state.runId,
      type: 'preview.stopped',
      level: stoppedByRequest ? 'notice' : 'info',
      message: stoppedByRequest ? state.stopReason! : 'Preview server stopped',
      payload: { exitCode, signal, reason: state.stopReason },
    });
  } else {
    state.status = 'failed';
    state.error =
      state.error ??
      `Preview server exited ${exitCode === null ? '' : `with code ${exitCode}`}${
        signal ? ` after signal ${signal}` : ''
      }`.trim();
    appendEvent({
      runId: state.runId,
      type: 'preview.failed',
      level: 'error',
      message: state.error,
      payload: { error: state.error, exitCode, signal },
    });
  }

  await new Promise<void>((resolve) => {
    state.log.end(`\nFinished: ${state.finishedAt}\n`, resolve);
  });
  if (state.logArtifactId) await refreshArtifactBytes(state.logArtifactId);
  state.resolveClosed();
}

function pipeRedacted(
  stream: NodeJS.ReadableStream | null,
  log: fs.WriteStream,
  state: PreviewProcessState,
): void {
  if (!stream) return;
  stream.setEncoding('utf8');
  stream.on('data', (raw: string) => {
    const { text } = redact(raw);
    log.write(text);
    // Kept in memory as well as on disk so the Preview tab can show a tail
    // without a file read on every poll. Bounded, because a chatty dev server
    // produces megabytes an hour and none of it is worth holding.
    state.tail.push(text);
    if (state.tail.length > LOG_TAIL_LINES) {
      state.tail.splice(0, state.tail.length - LOG_TAIL_LINES);
    }
  });
}

/**
 * Polls until the server answers, or until the project's patience runs out.
 *
 * The timeout is the point. V1 polled forever, so a server that never bound
 * left the preview reading `starting` with no way out but stopping it — and
 * nothing said why.
 */
async function waitForReady(state: PreviewProcessState): Promise<void> {
  const deadline = Date.now() + state.readyTimeoutMs;

  while (previewProcesses().get(state.runId) === state && state.status === 'starting') {
    if (await responds(state.readyUrl)) {
      if (previewProcesses().get(state.runId) !== state || state.status !== 'starting') return;
      state.status = 'ready';
      appendEvent({
        runId: state.runId,
        type: 'preview.ready',
        message: `Preview ready at ${state.url}`,
        payload: { url: state.url, port: state.port },
      });
      return;
    }

    if (Date.now() >= deadline) {
      if (previewProcesses().get(state.runId) !== state || state.status !== 'starting') return;
      const seconds = Math.round(state.readyTimeoutMs / 1000);
      state.status = 'unresponsive';
      state.error = `The preview did not answer ${state.readyUrl} within ${seconds}s. It is still running — a slow first build is the usual cause — but the ready path may also be wrong.`;
      appendEvent({
        runId: state.runId,
        type: 'preview.unresponsive',
        level: 'notice',
        message: state.error,
        payload: { url: state.url, readyUrl: state.readyUrl, waitedMs: state.readyTimeoutMs },
      });
      // The process is left running on purpose: a slow build is the common
      // cause, the log is still being captured, and killing it would throw
      // away the thing the user needs to read.
      return;
    }

    await delay(READY_POLL_MS);
  }
}

async function responds(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    await fetch(url, { cache: 'no-store', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Checks a fixed port is free, and says so plainly when it is not.
 *
 * Still a check rather than a reservation: nothing can hold a port open and
 * hand it to a child process, so this narrows the window rather than closing
 * it. A clash after this point surfaces as the dev server's own bind error in
 * the preview log.
 */
async function claimFixedPort(port: number): Promise<number> {
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  } catch {
    throw new AppError(
      `Port ${port} is already in use, and this project's preview is configured to use it. Free the port, or switch the preview to an automatic port.`,
      { code: 'preview_port_unavailable' },
    );
  }
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  return port;
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

  if (typeof address === 'object' && address !== null) return address.port;
  throw new AppError('Could not allocate a local preview port.', {
    code: 'preview_port_unavailable',
  });
}
