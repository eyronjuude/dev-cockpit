import 'server-only';

import { and, asc, eq, inArray } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { projects, runs } from '@/db/schema';
import { errorMessage } from '@/core/errors';
import {
  EXPIRABLE_STATUSES,
  expiredTargets,
  isExpired,
  planExpiry,
  RETENTION_OFF,
  type ExpiryPlan,
  type ExpiryTarget,
  type RetentionPolicy,
} from '@/domain/expiry';
import type { RunStatus } from '@/domain/types';
import {
  expireRunArtifacts,
  listArtifacts,
  runArtifactBytes,
  type ArtifactExpiryResult,
} from './artifacts';
import { appendEvent, listEvents } from './events';
import { requireProject, retentionPolicy } from './projects';
import { requireRun } from './runs';
import { cleanUpRunWorktrees, runWorktrees, type WorktreeCleanupReport } from './worktrees';

/**
 * The sweep that acts on `domain/expiry`.
 *
 * Nothing in a run's lifecycle triggers this. Storage is reclaimed by the
 * passage of time, so the trigger is time too: once at startup, then on a slow
 * timer for as long as the process lives, and on demand from the API. That
 * spread matters for a local app whose process is stopped and started all day —
 * a startup-only sweep would never fire on the machine that leaves it running,
 * and a timer-only sweep would never fire on the one that does not.
 *
 * Two invariants hold across every path in here:
 *
 *  - **It never forces.** Worktree removal goes through the same non-forcing
 *    cleanup the user's own button uses, so a dirty checkout and an unmerged
 *    branch both survive and the refusal is recorded.
 *  - **It never removes history.** Run rows, events, iterations, validation
 *    results, findings and request attachments are all left alone. What goes is
 *    a checkout that can be recreated and artifact bytes whose record stays
 *    behind.
 */

/** What expiry did, or would do, to one run. */
export interface RunExpiryOutcome {
  runId: string;
  projectId: string;
  title: string;
  status: RunStatus;
  /** Which targets the policy released. */
  targets: ExpiryTarget[];
  plan: ExpiryPlan;
  /** Null when the worktree window had not elapsed, or nothing was on disk. */
  worktrees: WorktreeCleanupReport | null;
  /** Null when the artifact window had not elapsed, or nothing was left. */
  artifacts: ArtifactExpiryResult | null;
  /** How many of the run's worktrees were on disk when this pass started. */
  worktreesOnDisk: number;
  bytesReclaimed: number;
  /** Set when the run was looked at and deliberately left alone. */
  skipped: string | null;
}

export interface ExpirySweepReport {
  startedAt: string;
  finishedAt: string;
  dryRun: boolean;
  /** Finished runs the sweep considered. */
  scanned: number;
  /** Runs where something was reclaimed, or would have been. */
  affected: number;
  worktreesRemoved: number;
  /** Worktrees the sweep found but refused to remove. */
  worktreesKept: number;
  artifactsExpired: number;
  /**
   * Bytes of artifact files removed. Worktree sizes are not measured — a
   * recursive stat over a checkout costs more than the number is worth — so
   * this under-reports what a sweep freed rather than guessing at the rest.
   */
  bytesReclaimed: number;
  /** One entry per affected run. Untouched runs are not listed. */
  runs: RunExpiryOutcome[];
  /** Runs the sweep could not finish, with the reason. */
  errors: { runId: string; error: string }[];
}

export interface SweepOptions {
  /** Report what would happen and change nothing. */
  dryRun?: boolean;
  /** Limit the sweep to one project. */
  projectId?: string;
  /** Judge the windows against this instant rather than now. A test seam. */
  now?: Date;
  /** Ceiling on runs examined in one pass, longest-finished first. */
  limit?: number;
  /**
   * Runs to leave alone whatever their age. Callers pass the orchestrator's
   * live set: a run can hold a finished status while its process is still
   * winding down, and its worktree is not free until that is over.
   */
  isBusy?: (runId: string) => boolean;
}

/** One run's plan, for the run screen and the API. */
export function runExpiryPlan(runId: string, now?: Date): ExpiryPlan {
  const run = requireRun(runId);
  return planExpiry(run, retentionPolicy(requireProject(run.projectId)), now);
}

/**
 * Whether this project has any retention at all.
 *
 * Checked before planning so a project with both windows off costs one
 * comparison rather than a plan per run.
 */
export function retentionEnabled(policy: RetentionPolicy): boolean {
  return (
    policy.worktreeRetentionDays !== RETENTION_OFF ||
    policy.artifactRetentionDays !== RETENTION_OFF
  );
}

const DEFAULT_LIMIT = 500;

export async function sweepExpiredRuns(options: SweepOptions = {}): Promise<ExpirySweepReport> {
  const { dryRun = false, projectId, now = new Date(), limit = DEFAULT_LIMIT, isBusy } = options;

  const startedAt = new Date().toISOString();
  const db = getDb();

  // Retention lives on the project, so the windows are joined in rather than
  // costing a project lookup per run. Oldest first: under a `limit`, the runs
  // most overdue are the ones worth reaching.
  const candidates = db
    .select({
      id: runs.id,
      projectId: runs.projectId,
      status: runs.status,
      finishedAt: runs.finishedAt,
      updatedAt: runs.updatedAt,
      createdAt: runs.createdAt,
      worktreeRetentionDays: projects.worktreeRetentionDays,
      artifactRetentionDays: projects.artifactRetentionDays,
    })
    .from(runs)
    .innerJoin(projects, eq(runs.projectId, projects.id))
    .where(
      projectId === undefined
        ? inArray(runs.status, [...EXPIRABLE_STATUSES])
        : and(inArray(runs.status, [...EXPIRABLE_STATUSES]), eq(runs.projectId, projectId)),
    )
    .orderBy(asc(runs.finishedAt))
    .limit(limit)
    .all();

  const report: ExpirySweepReport = {
    startedAt,
    finishedAt: startedAt,
    dryRun,
    scanned: candidates.length,
    affected: 0,
    worktreesRemoved: 0,
    worktreesKept: 0,
    artifactsExpired: 0,
    bytesReclaimed: 0,
    runs: [],
    errors: [],
  };

  for (const row of candidates) {
    const policy: RetentionPolicy = {
      worktreeRetentionDays: row.worktreeRetentionDays,
      artifactRetentionDays: row.artifactRetentionDays,
    };
    if (!retentionEnabled(policy)) continue;

    const plan = planExpiry(
      {
        status: row.status as RunStatus,
        finishedAt: row.finishedAt,
        updatedAt: row.updatedAt,
        createdAt: row.createdAt,
      },
      policy,
      now,
    );

    const targets = expiredTargets(plan);
    if (targets.length === 0) continue;

    try {
      const outcome = await expireOneRun(row.id, plan, targets, { dryRun, isBusy });
      if (outcome === null) continue;

      report.runs.push(outcome);
      report.affected += 1;
      report.worktreesRemoved += outcome.worktrees?.removed ?? 0;
      report.worktreesKept += outcome.worktrees?.kept ?? 0;
      report.artifactsExpired += outcome.artifacts?.expired ?? 0;
      report.bytesReclaimed += outcome.bytesReclaimed;
    } catch (err) {
      // One unreadable worktree must not stop the sweep reaching the rest.
      report.errors.push({ runId: row.id, error: errorMessage(err) });
    }
  }

  report.finishedAt = new Date().toISOString();
  return report;
}

/**
 * Acts on one run's elapsed windows.
 *
 * Returns null when the run has nothing left to reclaim, so a sweep over a
 * thousand long-expired runs reports the handful it changed rather than a
 * thousand no-ops — and appends no event for them either.
 */
async function expireOneRun(
  runId: string,
  plan: ExpiryPlan,
  targets: ExpiryTarget[],
  options: { dryRun: boolean; isBusy?: (id: string) => boolean },
): Promise<RunExpiryOutcome | null> {
  const { dryRun, isBusy } = options;

  const run = requireRun(runId);
  const project = requireProject(run.projectId);

  const outcome: RunExpiryOutcome = {
    runId: run.id,
    projectId: run.projectId,
    title: run.title,
    status: run.status,
    targets,
    plan,
    worktrees: null,
    artifacts: null,
    worktreesOnDisk: 0,
    bytesReclaimed: 0,
    skipped: null,
  };

  if (isBusy?.(run.id)) {
    return { ...outcome, skipped: 'the orchestrator is still working on this run' };
  }

  outcome.worktreesOnDisk = runWorktrees(run, project).filter((w) => w.exists).length;

  const worktreesDue = isExpired(plan, 'worktrees') && outcome.worktreesOnDisk > 0;
  const artifactsPending = listArtifacts(run.id).some((a) => a.expiredAt === null);
  const artifactsDue = isExpired(plan, 'artifacts') && artifactsPending;

  // Both windows stay elapsed for the rest of the run's life. A run already
  // swept has nothing to say, so it is skipped before any event is written.
  if (!worktreesDue && !artifactsDue) return null;

  if (dryRun) {
    // What is on disk, not what removal would decide: whether git refuses a
    // dirty worktree is not knowable without attempting it.
    outcome.bytesReclaimed = artifactsDue ? runArtifactBytes(run.id) : 0;
    outcome.skipped = 'preview only; nothing was removed';
    return outcome;
  }

  if (worktreesDue) {
    outcome.worktrees = await cleanUpRunWorktrees(run.id, {
      force: false,
      deleteBranches: true,
      automatic: true,
    });
  }

  if (artifactsDue) {
    outcome.artifacts = await expireRunArtifacts(run.id);
    outcome.bytesReclaimed = outcome.artifacts.bytesReclaimed;
  }

  if (!worthRecording(outcome)) return outcome;

  appendEvent({
    runId: run.id,
    type: 'run.expired',
    level: (outcome.worktrees?.kept ?? 0) > 0 ? 'notice' : 'info',
    message: describeExpiry(outcome),
    payload: {
      targets,
      retentionDays: {
        worktrees: project.worktreeRetentionDays,
        artifacts: project.artifactRetentionDays,
      },
      worktreesRemoved: outcome.worktrees?.removed ?? null,
      worktreesKept: outcome.worktrees?.kept ?? null,
      artifactsExpired: outcome.artifacts?.expired ?? null,
      bytesReclaimed: outcome.bytesReclaimed,
      dryRun: false,
    },
  });

  return outcome;
}

/**
 * Whether this pass has anything new to say.
 *
 * A worktree holding uncommitted work is refused on every sweep, and the
 * refusal is correct each time — but recording it every six hours for the rest
 * of the run's life would bury the log in a fact the user was already told.
 * So a pass that reclaimed nothing speaks only if nothing has spoken before.
 */
function worthRecording(outcome: RunExpiryOutcome): boolean {
  const reclaimed =
    (outcome.worktrees?.removed ?? 0) > 0 ||
    (outcome.worktrees?.targets.some((t) => t.branchDeleted) ?? false) ||
    (outcome.artifacts?.expired ?? 0) > 0;

  if (reclaimed) return true;
  return listEvents(outcome.runId, { types: ['run.expired'], limit: 1 }).length === 0;
}

function describeExpiry(outcome: RunExpiryOutcome): string {
  const parts: string[] = [];

  if (outcome.worktrees) {
    const { removed, kept } = outcome.worktrees;
    if (removed > 0) parts.push(`${removed} worktree${removed === 1 ? '' : 's'} reclaimed`);
    if (kept > 0) parts.push(`${kept} kept`);
  }

  const expired = outcome.artifacts?.expired ?? 0;
  if (expired > 0) parts.push(`${expired} artifact${expired === 1 ? '' : 's'} expired`);

  const windows = outcome.plan.targets
    .filter((t) => t.expired)
    .map((t) => `${t.target} after ${t.retentionDays}d`)
    .join(', ');

  return parts.length > 0
    ? `Retention reclaimed storage — ${parts.join(', ')} (${windows})`
    : `Retention found nothing left to reclaim (${windows})`;
}

/* ------------------------------------------------------------------ *
 * Scheduling
 * ------------------------------------------------------------------ */

/**
 * Six hours. Long enough that the sweep is invisible, short enough that a
 * machine left running for a fortnight honours a 7-day window on the day it
 * elapses rather than at the next restart.
 */
export const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1_000;

const GLOBAL_KEY = '__devCockpitExpiryTimer__' as const;
type GlobalWithTimer = typeof globalThis & { [GLOBAL_KEY]?: NodeJS.Timeout };

/** False when `DEV_COCKPIT_DISABLE_EXPIRY` is set. */
export function expirySweepsEnabled(): boolean {
  const raw = process.env.DEV_COCKPIT_DISABLE_EXPIRY?.trim().toLowerCase();
  return !(raw === '1' || raw === 'true' || raw === 'yes');
}

/**
 * Starts the background sweep. Idempotent, and guarded on `globalThis` so
 * Next's dev-mode module reloading does not stack timers.
 *
 * The timer is unref'd: reclaiming disk is never a reason to keep the process
 * alive, and a sweep missed at shutdown runs at the next startup instead.
 */
export function scheduleExpirySweeps(): void {
  if (!expirySweepsEnabled()) return;

  const g = globalThis as GlobalWithTimer;
  if (g[GLOBAL_KEY]) return;

  const timer = setInterval(runScheduledSweep, SWEEP_INTERVAL_MS);
  timer.unref?.();
  g[GLOBAL_KEY] = timer;

  runScheduledSweep();
}

function runScheduledSweep(): void {
  void sweepExpiredRuns()
    .then((report) => {
      for (const failure of report.errors) {
        console.warn(
          `[dev-cockpit] Retention could not finish ${failure.runId}: ${failure.error}`,
        );
      }
      if (report.affected === 0) return;
      console.info(
        `[dev-cockpit] Retention reclaimed storage from ${report.affected} run(s): ` +
          `${report.worktreesRemoved} worktree(s) removed, ${report.worktreesKept} kept, ` +
          `${report.artifactsExpired} artifact(s) expired.`,
      );
    })
    .catch((err: unknown) => {
      // Never fatal. A sweep that cannot run leaves storage in place, which is
      // the safe direction to fail in.
      console.warn(`[dev-cockpit] Retention sweep failed: ${errorMessage(err)}`);
    });
}
