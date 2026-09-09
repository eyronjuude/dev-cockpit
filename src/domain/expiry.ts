import { FINISHED_STATUSES, type RunStatus } from './types';

/**
 * When a finished run's disk footprint stops being worth keeping.
 *
 * A run leaves two kinds of storage behind, and they cost very different
 * amounts. Its worktrees are a full checkout plus whatever `linkPaths`
 * brought in — hundreds of megabytes once `node_modules` is there — and they
 * are worthless the moment nobody is going to look at the diff again. Its
 * artifacts are logs and reports measured in megabytes, and they are the
 * evidence for what the run claimed, so they earn a longer stay. One window
 * for both would have to pick which of those two facts to ignore, so there
 * are two.
 *
 * Expiry only ever *reclaims storage*. The run row, its events, iterations,
 * validation results and findings are never touched, and neither are request
 * attachments — the app holds the only copy of those. What expiry removes is
 * always something the run could produce again.
 *
 * Pure: no I/O, no database, no server-only imports. `services/expiry` acts on
 * what this decides, and the run screen calls the same functions to say when a
 * run's storage is due to go.
 */

export const EXPIRY_TARGETS = ['worktrees', 'artifacts'] as const;
export type ExpiryTarget = (typeof EXPIRY_TARGETS)[number];

export const EXPIRY_TARGET_LABELS: Record<ExpiryTarget, string> = {
  worktrees: 'Worktrees',
  artifacts: 'Artifacts',
};

/** A retention window of this many days keeps its target forever. */
export const RETENTION_OFF = 0;

/**
 * Worktrees go first and go sooner. Seven days is long enough to come back to
 * a run on the following Monday, short enough that a week of runs cannot fill
 * a disk.
 */
export const DEFAULT_WORKTREE_RETENTION_DAYS = 7;

/** Matches the column default that has been on `projects` since the schema began. */
export const DEFAULT_ARTIFACT_RETENTION_DAYS = 30;

/** Per-project retention, in days. Zero on either means "keep forever". */
export interface RetentionPolicy {
  worktreeRetentionDays: number;
  artifactRetentionDays: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  worktreeRetentionDays: DEFAULT_WORKTREE_RETENTION_DAYS,
  artifactRetentionDays: DEFAULT_ARTIFACT_RETENTION_DAYS,
};

/**
 * The shape the policy reads off a run. `RunView` and `RunRow` both satisfy it
 * structurally, so neither the service nor the UI has to build an adapter.
 */
export interface ExpirableRun {
  status: RunStatus;
  finishedAt: string | null;
  updatedAt: string;
  createdAt: string;
}

/**
 * Statuses expiry may act on: exactly the set whose worktrees are already
 * spent, which is the same set the manual cleanup accepts.
 *
 * `FAILED` and `CANCELLED` are in here even though both can be reworked. That
 * is the point of a window rather than an immediate sweep — a rework happens
 * within days, and a run nobody returned to in a week is one whose checkout is
 * pure cost. Nothing is lost either way: removal refuses a dirty worktree and
 * an unmerged branch, so the work itself survives an expiry that reclaims the
 * directory around it.
 */
export const EXPIRABLE_STATUSES: readonly RunStatus[] = FINISHED_STATUSES;

export const isExpirable = (status: RunStatus): boolean => EXPIRABLE_STATUSES.includes(status);

/**
 * When the clock starts.
 *
 * `finishedAt` is the honest answer and is set by every path that reaches a
 * finished status. The fallbacks exist because a retention window must never
 * silently become infinite on a row that predates a field: `updatedAt` is
 * always written, and `createdAt` cannot be null.
 */
export function retentionStart(run: ExpirableRun): string {
  return run.finishedAt ?? run.updatedAt ?? run.createdAt;
}

const MS_PER_DAY = 86_400_000;

/** One target's verdict. `dueAt` is null when the window is off. */
export interface TargetExpiry {
  target: ExpiryTarget;
  retentionDays: number;
  dueAt: string | null;
  expired: boolean;
}

export interface ExpiryPlan {
  /**
   * When the run became a candidate, or null when its status means expiry has
   * no business looking at it yet.
   */
  eligibleFrom: string | null;
  targets: TargetExpiry[];
  /**
   * Why nothing is expired, as a sentence fragment. Null when at least one
   * target is.
   */
  reason: string | null;
}

function daysFor(policy: RetentionPolicy, target: ExpiryTarget): number {
  const raw =
    target === 'worktrees' ? policy.worktreeRetentionDays : policy.artifactRetentionDays;
  // A negative or non-finite window would otherwise expire everything at once.
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : RETENTION_OFF;
}

/**
 * What, if anything, this run's retention windows have released.
 *
 * `now` is a parameter rather than read from the clock so a test can state the
 * date it means instead of arranging one.
 */
export function planExpiry(
  run: ExpirableRun,
  policy: RetentionPolicy,
  now: Date = new Date(),
): ExpiryPlan {
  if (!isExpirable(run.status)) {
    return {
      eligibleFrom: null,
      targets: EXPIRY_TARGETS.map((target) => ({
        target,
        retentionDays: daysFor(policy, target),
        dueAt: null,
        expired: false,
      })),
      reason: `the run is ${run.status}, and expiry only acts on a run that is over`,
    };
  }

  const start = retentionStart(run);
  const startMs = Date.parse(start);
  const nowMs = now.getTime();

  const targets: TargetExpiry[] = EXPIRY_TARGETS.map((target) => {
    const retentionDays = daysFor(policy, target);
    if (retentionDays === RETENTION_OFF || !Number.isFinite(startMs)) {
      return { target, retentionDays, dueAt: null, expired: false };
    }
    const dueMs = startMs + retentionDays * MS_PER_DAY;
    return {
      target,
      retentionDays,
      dueAt: new Date(dueMs).toISOString(),
      expired: dueMs <= nowMs,
    };
  });

  const expired = targets.filter((t) => t.expired);
  if (expired.length > 0) {
    return { eligibleFrom: start, targets, reason: null };
  }

  const soonest = targets
    .filter((t) => t.dueAt !== null)
    .sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!))
    .at(0);

  return {
    eligibleFrom: start,
    targets,
    reason: soonest
      ? `nothing is due yet; the next window elapses ${soonest.dueAt}`
      : 'retention is off for this project',
  };
}

/** Which targets the plan has released. */
export function expiredTargets(plan: ExpiryPlan): ExpiryTarget[] {
  return plan.targets.filter((t) => t.expired).map((t) => t.target);
}

export function isExpired(plan: ExpiryPlan, target: ExpiryTarget): boolean {
  return plan.targets.some((t) => t.target === target && t.expired);
}

/** When a target is due, or null when its window is off or already elapsed. */
export function dueAt(plan: ExpiryPlan, target: ExpiryTarget): string | null {
  const found = plan.targets.find((t) => t.target === target);
  return found && !found.expired ? found.dueAt : null;
}
