import 'server-only';

import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { eq } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { configProbes } from '@/db/schema';
import { newProbeId, probeBranchName } from '@/core/ids';
import { errorMessage, notFound } from '@/core/errors';
import { isInside, probeWorktreeDir } from '@/core/paths';
import { registerExtraSecrets } from '@/core/redact';
import { spawn } from 'node:child_process';
import { killTree, runCommand } from '@/process/spawn';
import { orderSteps, parseEnvLines, secretValuesIn } from '@/domain/validation-steps';
import type { ProbeStatus } from '@/domain/types';
import { createProbeWorktree, removeProbeWorktree } from '@/git/probe';
import { linkIntoWorktree } from '@/git/worktree';
import { requireProject } from '@/services/projects';
import type { SetupProposal } from '@/services/repo-evidence';
import type { ProbeFeedback } from './types';

/**
 * Runs a proposed configuration to find out whether it actually works.
 *
 * This is the half of `auto` mode that earns it. A model's proposal is a guess
 * until something executes it; a probe executes it in a checkout that exists
 * only for that purpose, records every outcome, and hands the errors back for
 * one revision pass.
 *
 * Three properties are load-bearing:
 *
 *  - **It never touches the user's checkout.** A fresh worktree on a throwaway
 *    branch under `data/probes/`, removed in a `finally`.
 *  - **`fail` and `error` mean different things and are treated differently.**
 *    A step that ran and exited non-zero found something real; only a step that
 *    could not run at all is a configuration problem.
 *  - **The model still runs nothing.** This code runs the commands. What goes
 *    back is exit codes, which is evidence rather than capability.
 */

/** A probe is a setup plus a pipeline; beyond this it is a build, not a check. */
const PROBE_BUDGET_MS = 15 * 60_000;
/** Per-step ceiling inside a probe. Shorter than a run's: this is a smoke test. */
const STEP_TIMEOUT_MS = 5 * 60_000;
const SETUP_TIMEOUT_MS = 10 * 60_000;
const PREVIEW_READY_TIMEOUT_MS = 90_000;
const PREVIEW_POLL_MS = 750;

export interface ProbeStepOutcome {
  key: string;
  label: string;
  command: string;
  /** `pass`, `fail`, `error`, or `skipped` when the budget ran out. */
  outcome: 'pass' | 'fail' | 'error' | 'skipped';
  exitCode: number | null;
  durationMs: number | null;
  error: string | null;
  /** Tail of the output, for the report. Never fed to a model. */
  excerpt: string | null;
}

export interface ProbeReport {
  proposal: SetupProposal;
  setup: { command: string; outcome: 'pass' | 'fail' | 'error'; error: string | null } | null;
  steps: ProbeStepOutcome[];
  preview: { command: string; ready: boolean; error: string | null } | null;
  /** True when nothing errored. Failures do not make a probe unsuccessful. */
  configurationSound: boolean;
  notes: string[];
}

export interface ProbeRecordView {
  id: string;
  projectId: string;
  status: ProbeStatus;
  phase: string;
  report: ProbeReport | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export function createProbeRecord(projectId: string): string {
  const id = newProbeId();
  getDb().insert(configProbes).values({ id, projectId, status: 'running', phase: 'starting' }).run();
  return id;
}

export function getProbe(id: string): ProbeRecordView | null {
  const row = getDb().select().from(configProbes).where(eq(configProbes.id, id)).get();
  if (!row) return null;

  let report: ProbeReport | null = null;
  if (row.report) {
    try {
      report = JSON.parse(row.report) as ProbeReport;
    } catch {
      report = null;
    }
  }

  return {
    id: row.id,
    projectId: row.projectId,
    status: row.status as ProbeStatus,
    phase: row.phase,
    report,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

export function requireProbe(id: string): ProbeRecordView {
  const probe = getProbe(id);
  if (!probe) throw notFound(`Probe ${id}`);
  return probe;
}

function setPhase(id: string, phase: string): void {
  getDb().update(configProbes).set({ phase }).where(eq(configProbes.id, id)).run();
}

/** Closes a probe row. The single place a probe's terminal state is written. */
export function finishProbe(
  id: string,
  status: ProbeStatus,
  report: ProbeReport | null,
  error: string | null,
): void {
  getDb()
    .update(configProbes)
    .set({
      status,
      phase: status === 'completed' ? 'done' : status,
      report: report ? JSON.stringify(report) : null,
      error,
      finishedAt: new Date().toISOString(),
    })
    .where(eq(configProbes.id, id))
    .run();
}

/**
 * Runs one proposal end to end in a disposable worktree.
 *
 * Never throws for a command that failed — that is a result. It throws only
 * when the probe itself could not be set up, which the caller records as a
 * failed probe rather than a bad configuration.
 */
export async function runConfigurationProbe(input: {
  probeId: string;
  projectId: string;
  proposal: SetupProposal;
  signal?: AbortSignal;
}): Promise<ProbeReport> {
  const { probeId, projectId, proposal, signal } = input;
  const project = requireProject(projectId);
  const deadline = Date.now() + PROBE_BUDGET_MS;
  const notes: string[] = [];

  const worktreePath = probeWorktreeDir(projectId, probeId);
  const branch = probeBranchName(probeId);

  setPhase(probeId, 'creating a disposable worktree');
  const worktree = await createProbeWorktree({
    repositoryPath: project.repositoryPath,
    worktreePath,
    branch,
    baseRef: project.defaultBranch,
  });

  const report: ProbeReport = {
    proposal,
    setup: null,
    steps: [],
    preview: null,
    configurationSound: true,
    notes,
  };

  try {
    // Dependencies first, or every step below reports a missing binary and the
    // revision pass spends its one attempt fixing the wrong thing.
    if (proposal.linkPaths.length > 0) {
      setPhase(probeId, 'linking dependencies');
      const linked = await linkIntoWorktree(
        project.repositoryPath,
        worktree.worktreePath,
        proposal.linkPaths,
      );
      for (const failure of linked.failed) {
        notes.push(`Could not link ${failure.path}: ${failure.error}`);
      }
    }

    if (proposal.setupCommand?.trim()) {
      setPhase(probeId, 'running the setup command');
      const result = await runCommand({
        command: proposal.setupCommand,
        cwd: worktree.worktreePath,
        timeoutMs: Math.min(SETUP_TIMEOUT_MS, remaining(deadline)),
        signal,
      });
      const outcome = result.spawnError || result.timedOut ? 'error' : result.exitCode === 0 ? 'pass' : 'fail';
      report.setup = {
        command: proposal.setupCommand,
        outcome,
        error: result.spawnError ?? (result.timedOut ? 'The setup command timed out.' : null),
      };
      if (outcome !== 'pass') {
        notes.push(
          'The setup command did not succeed, so later steps may report missing dependencies rather than real problems.',
        );
      }
    }

    setPhase(probeId, 'running the proposed checks');
    for (const step of orderSteps(proposal.validationSteps)) {
      if (signal?.aborted) break;

      if (remaining(deadline) <= 0) {
        report.steps.push({
          key: step.key,
          label: step.label,
          command: step.command,
          outcome: 'skipped',
          exitCode: null,
          durationMs: null,
          error: 'The probe ran out of time before this step.',
          excerpt: null,
        });
        notes.push('The probe hit its time budget; later steps were not tried.');
        continue;
      }

      setPhase(probeId, `running ${step.label}`);
      const cwd = safeCwd(worktree.worktreePath, step.workingDir);
      if (!cwd) {
        report.steps.push({
          key: step.key,
          label: step.label,
          command: step.command,
          outcome: 'error',
          exitCode: null,
          durationMs: null,
          error: `Working directory ${step.workingDir} escapes the worktree.`,
          excerpt: null,
        });
        continue;
      }

      const result = await runCommand({
        command: step.command,
        cwd,
        timeoutMs: Math.min(STEP_TIMEOUT_MS, remaining(deadline)),
        signal,
      });

      const outcome = result.spawnError
        ? 'error'
        : result.timedOut
          ? 'error'
          : result.exitCode === 0
            ? 'pass'
            : 'fail';

      report.steps.push({
        key: step.key,
        label: step.label,
        command: step.command,
        outcome,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        error: result.spawnError
          ? `Could not start the command: ${result.spawnError}`
          : result.timedOut
            ? 'The command timed out.'
            : null,
        excerpt: excerptOf(result.stdout, result.stderr),
      });
    }

    if (proposal.preview.command?.trim() && !signal?.aborted && remaining(deadline) > 0) {
      setPhase(probeId, 'starting the preview');
      report.preview = await probePreview(
        worktree.worktreePath,
        proposal,
        Math.min(PREVIEW_READY_TIMEOUT_MS, remaining(deadline)),
      );
    }

    // Failures are results, not configuration problems. Only something that
    // could not run says the configuration itself is wrong.
    report.configurationSound =
      report.setup?.outcome !== 'error' &&
      !report.steps.some((step) => step.outcome === 'error') &&
      (report.preview === null || report.preview.ready);

    return report;
  } finally {
    setPhase(probeId, 'cleaning up');
    const cleanup = await removeProbeWorktree({
      repositoryPath: project.repositoryPath,
      worktreePath: worktree.worktreePath,
      branch,
    });
    for (const problem of cleanup.problems) notes.push(`Cleanup: ${problem}`);
  }
}

/**
 * Starts the preview command and waits for it to answer, then stops it.
 *
 * The port is not the project's configured one: a probe must not collide with a
 * preview the user already has running, and nothing about the port proves the
 * command works.
 */
async function probePreview(
  worktreePath: string,
  proposal: SetupProposal,
  timeoutMs: number,
): Promise<{ command: string; ready: boolean; error: string | null }> {
  const command = proposal.preview.command!;
  const cwd = safeCwd(worktreePath, proposal.preview.workingDir);
  if (!cwd) {
    return {
      command,
      ready: false,
      error: `Working directory ${proposal.preview.workingDir} escapes the worktree.`,
    };
  }

  let port: number;
  try {
    port = await freePort();
  } catch (err) {
    return { command, ready: false, error: errorMessage(err) };
  }

  const url = `http://127.0.0.1:${port}`;
  const readyPath = proposal.preview.readyPath.startsWith('/')
    ? proposal.preview.readyPath
    : `/${proposal.preview.readyPath}`;
  const readyUrl = readyPath === '/' ? url : `${url}${readyPath}`;

  const child = spawn(command, {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      HOSTNAME: '127.0.0.1',
      BROWSER: 'none',
      DEV_COCKPIT_PREVIEW_URL: url,
    } as NodeJS.ProcessEnv,
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
    shell: true,
    detached: process.platform !== 'win32',
  });

  let exited: string | null = null;
  child.once('exit', (code, signal) => {
    exited = `The preview command exited early (code ${code ?? 'none'}${signal ? `, signal ${signal}` : ''}).`;
  });

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exited) return { command, ready: false, error: exited };
      if (await responds(readyUrl)) return { command, ready: true, error: null };
      await delay(PREVIEW_POLL_MS);
    }
    return {
      command,
      ready: false,
      error: `The preview did not answer ${readyPath} within ${Math.round(timeoutMs / 1000)}s.`,
    };
  } finally {
    killTree(child, 'SIGTERM');
    // A dev server that ignores SIGTERM would otherwise outlive the probe and
    // hold the worktree open, which is what makes the cleanup fail.
    setTimeout(() => killTree(child, 'SIGKILL'), 5_000).unref();
  }
}

/**
 * Turns a report into the narrow slice a model is allowed to see.
 *
 * Errors only. Handing over a failure invites the model to make the red go
 * away, and the red is usually the most valuable thing the probe found.
 */
export function feedbackFrom(report: ProbeReport): ProbeFeedback {
  const steps = report.steps
    .filter((step) => step.outcome === 'error')
    .map((step) => ({
      key: step.key,
      command: step.command,
      outcome: step.outcome,
      error: step.error,
    }));

  if (report.setup && report.setup.outcome === 'error') {
    steps.unshift({
      key: 'setup',
      command: report.setup.command,
      outcome: 'error',
      error: report.setup.error,
    });
  }

  return {
    steps,
    previewError: report.preview && !report.preview.ready ? report.preview.error : null,
  };
}

/**
 * Merges a revised proposal over the one that was probed.
 *
 * The rule the revision pass has to obey: a step may be corrected, but a step
 * the probe proved sound is kept as it was, and a step that merely *failed* is
 * never dropped. Enforced here rather than asked for in the prompt, because a
 * prompt is a request and this is a guarantee.
 */
export function applyRevision(
  probed: SetupProposal,
  revised: SetupProposal,
  report: ProbeReport,
): SetupProposal {
  const outcomes = new Map(report.steps.map((step) => [step.key, step.outcome] as const));
  const revisedByKey = new Map(revised.validationSteps.map((step) => [step.key, step] as const));

  const merged = probed.validationSteps.map((step) => {
    const outcome = outcomes.get(step.key);
    // Ran and passed, or ran and found something: either way the command works,
    // so the revision has nothing to say about it.
    if (outcome === 'pass' || outcome === 'fail') return step;
    const replacement = revisedByKey.get(step.key);
    return replacement ? { ...replacement, position: step.position } : step;
  });

  // A step the model added that was never probed is new information, so it is
  // kept — at the end, where it cannot reorder anything already proven.
  const known = new Set(merged.map((step) => step.key));
  const added = revised.validationSteps.filter((step) => !known.has(step.key));
  const appended = added.map((step, index) => ({
    ...step,
    position: (merged.length + index) * 10,
  }));

  return {
    ...revised,
    validationSteps: [...merged, ...appended],
    // Setup and linking were not re-probed, so the revised view of them stands.
    preview:
      report.preview && report.preview.ready ? probed.preview : revised.preview,
  };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function remaining(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

/** Resolves a working directory, or null when it escapes the worktree. */
function safeCwd(worktreePath: string, workingDir: string | null): string | null {
  if (!workingDir) return worktreePath;
  const resolved = path.resolve(worktreePath, workingDir);
  if (resolved !== worktreePath && !isInside(worktreePath, resolved)) return null;
  return resolved;
}

function excerptOf(stdout: string, stderr: string): string | null {
  const text = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
  if (!text) return null;
  return text.length <= 4_000 ? text : `…\n${text.slice(-4_000)}`;
}

async function responds(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    await fetch(url, { cache: 'no-store', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort(): Promise<number> {
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
  throw new Error('Could not allocate a local port for the preview probe.');
}

/** Exported for the setup path, which registers a proposal's env before running it. */
export function registerProposalSecrets(env: readonly string[]): void {
  registerExtraSecrets(secretValuesIn(parseEnvLines(env.join('\n'))));
}

export async function probeWorktreeExists(probeId: string, projectId: string): Promise<boolean> {
  return fsp
    .stat(probeWorktreeDir(projectId, probeId))
    .then((stat) => stat.isDirectory())
    .catch(() => false);
}
