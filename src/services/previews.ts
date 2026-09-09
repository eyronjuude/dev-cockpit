import 'server-only';

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { AppError, errorMessage } from '@/core/errors';
import { ensureDir, runArtifactDir } from '@/core/paths';
import { redact } from '@/core/redact';
import type { PreviewStatus, PreviewView } from '@/domain/previews';
import { killTree } from '@/process/spawn';
import { refreshArtifactBytes, register } from './artifacts';
import { appendEvent } from './events';
import { requireProject } from './projects';
import { requireRun } from './runs';

interface PreviewProcessState {
  runId: string;
  command: string;
  cwd: string;
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

function previewProcesses(): Map<string, PreviewProcessState> {
  const g = globalThis as GlobalWithPreviews;
  g[GLOBAL_KEY] ??= new Map();
  return g[GLOBAL_KEY];
}

function configuredCommand(runId: string): { command: string | null; cwd: string | null } {
  const run = requireRun(runId);
  const project = requireProject(run.projectId);
  const command = project.developmentCommand?.trim() || null;
  return { command, cwd: run.worktreePath };
}

function isRunning(state: PreviewProcessState): boolean {
  return state.status === 'starting' || state.status === 'ready';
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
  const command = project.developmentCommand?.trim();
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

  const port = await reservePort();
  const url = `http://127.0.0.1:${port}`;
  const startedAt = new Date().toISOString();
  const logDir = ensureDir(path.join(runArtifactDir(runId), 'preview'));
  const logPath = path.join(logDir, `${startedAt.replace(/[:.]/g, '-')}.log`);
  const header = [
    `Dev Cockpit preview`,
    `Run: ${runId}`,
    `Command: ${command}`,
    `Worktree: ${run.worktreePath}`,
    `URL: ${url}`,
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
    meta: { command, cwd: run.worktreePath, port, url, startedAt },
  });

  const log = fs.createWriteStream(logPath, { flags: 'a', encoding: 'utf8' });

  let child: ChildProcess;
  try {
    child = spawn(command, {
      cwd: run.worktreePath,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        HOSTNAME: '127.0.0.1',
        BROWSER: 'none',
        DEV_COCKPIT_PREVIEW_URL: url,
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
    cwd: run.worktreePath,
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
  pipeRedacted(child.stdout, log);
  pipeRedacted(child.stderr, log);

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

function pipeRedacted(stream: NodeJS.ReadableStream | null, log: fs.WriteStream): void {
  if (!stream) return;
  stream.setEncoding('utf8');
  stream.on('data', (raw: string) => {
    const { text } = redact(raw);
    log.write(text);
  });
}

async function waitForReady(state: PreviewProcessState): Promise<void> {
  while (previewProcesses().get(state.runId) === state && state.status === 'starting') {
    if (await responds(state.url)) {
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
