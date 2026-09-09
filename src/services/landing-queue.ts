import 'server-only';

import { asc, eq, inArray } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { runs } from '@/db/schema';
import {
  landingTargetBranch,
  type LandingModeKind,
  type LandingQueueState,
} from '@/domain/landing';
import { isLandableStatus, type Disposition, type RunStatus } from '@/domain/types';
import { landingQueueSnapshot } from '@/orchestrator/orchestrator';
import type { ProjectView } from '@/services/projects';

/**
 * What a project still owes its target branches.
 *
 * The orchestrator's queue answers only "who is landing right now, and who is
 * behind them", which is empty except during the seconds two landings contend.
 * On its own that is not something anyone can keep track of. What is worth
 * seeing is every run entitled to land and not yet landed — the approved ones
 * nobody has pressed Land on, and the ones whose landing stopped on a conflict
 * — with the live queue sitting on top of it in execution order.
 */

export interface LandingQueueRun {
  id: string;
  title: string;
  /** The run's own branch, the source of the merge. */
  branch: string | null;
  status: RunStatus;
  /** The branch this run's landing merges into. */
  targetBranch: string;
  state: LandingQueueState;
  /** Place in the live queue; null for a run that has not asked to land. */
  position: number | null;
  /** What the queued landing will do when its turn comes. */
  mode: LandingModeKind | null;
  /**
   * True when a previous attempt left a landing worktree behind, so pressing
   * Land resumes rather than starts. `MERGE_CONFLICT` and `LANDING_FAILED`
   * both hold one.
   */
  stopped: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LandingQueueBranch {
  targetBranch: string;
  entries: LandingQueueRun[];
}

export interface LandingQueueView {
  projectId: string;
  /** The project's default branch, so the view can mark the usual target. */
  defaultBranch: string;
  branches: LandingQueueBranch[];
  /** Landing right now, plus everything queued behind it. Drives polling. */
  liveCount: number;
  /** Entitled to land, no landing asked for yet. */
  pendingCount: number;
}

interface QueueRow {
  id: string;
  projectId: string;
  title: string;
  status: string;
  disposition: string | null;
  branch: string | null;
  baseBranch: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Statuses that kept a landing worktree from an attempt that stopped. */
const STOPPED_STATUSES: readonly RunStatus[] = ['MERGE_CONFLICT', 'LANDING_FAILED'];

const QUEUE_COLUMNS = {
  id: runs.id,
  projectId: runs.projectId,
  title: runs.title,
  status: runs.status,
  disposition: runs.disposition,
  branch: runs.branch,
  baseBranch: runs.baseBranch,
  createdAt: runs.createdAt,
  updatedAt: runs.updatedAt,
} as const;

const isLandable = (row: QueueRow): boolean =>
  isLandableStatus(row.status as RunStatus, row.disposition as Disposition | null);

/**
 * Every run this project still owes a landing, live queue first.
 *
 * Live entries are resolved back through the database and any run belonging to
 * another project is dropped. The queue is keyed by repository path rather than
 * by project id, and nothing stops a second project being registered against a
 * repository an archived one already holds, so "same repository" is not a safe
 * proxy for "same project".
 */
export function projectLandingQueue(project: ProjectView): LandingQueueView {
  const db = getDb();

  const landable: QueueRow[] = db
    .select(QUEUE_COLUMNS)
    .from(runs)
    .where(eq(runs.projectId, project.id))
    .orderBy(asc(runs.createdAt))
    .all()
    .filter(isLandable);

  const live = landingQueueSnapshot(project.repositoryPath);

  // A run that is landing has already left APPROVED for LANDING, so it is not
  // in the landable set above and has to be fetched by id.
  const known = new Set(landable.map((row) => row.id));
  const missingIds = live.map((entry) => entry.runId).filter((id) => !known.has(id));
  const extra: QueueRow[] =
    missingIds.length === 0
      ? []
      : db.select(QUEUE_COLUMNS).from(runs).where(inArray(runs.id, missingIds)).all();

  const rows = new Map(
    [...landable, ...extra]
      .filter((row) => row.projectId === project.id)
      .map((row) => [row.id, row] as const),
  );

  const liveByRun = new Map(
    live.filter((entry) => rows.has(entry.runId)).map((entry) => [entry.runId, entry] as const),
  );

  const byBranch = new Map<string, LandingQueueRun[]>();
  for (const row of rows.values()) {
    const entry = toQueueRun(row, liveByRun.get(row.id), project.defaultBranch);
    const bucket = byBranch.get(entry.targetBranch);
    if (bucket) bucket.push(entry);
    else byBranch.set(entry.targetBranch, [entry]);
  }

  const branches = [...byBranch.entries()]
    .map(([targetBranch, entries]) => ({
      targetBranch,
      entries: entries.sort(compareEntries),
    }))
    // The default branch first — it is where most landings go — then the rest
    // alphabetically, so the order does not shuffle between polls.
    .sort((a, b) => {
      if (a.targetBranch === b.targetBranch) return 0;
      if (a.targetBranch === project.defaultBranch) return -1;
      if (b.targetBranch === project.defaultBranch) return 1;
      return a.targetBranch.localeCompare(b.targetBranch);
    });

  return {
    projectId: project.id,
    defaultBranch: project.defaultBranch,
    branches,
    liveCount: liveByRun.size,
    pendingCount: rows.size - liveByRun.size,
  };
}

function toQueueRun(
  row: QueueRow,
  entry: { targetBranch: string; state: LandingQueueState; position: number; mode: LandingModeKind } | undefined,
  defaultBranch: string,
): LandingQueueRun {
  const status = row.status as RunStatus;
  return {
    id: row.id,
    title: row.title,
    branch: row.branch,
    status,
    targetBranch: entry?.targetBranch ?? landingTargetBranch(row.baseBranch, defaultBranch),
    state: entry?.state ?? 'pending',
    position: entry?.position ?? null,
    mode: entry?.mode ?? null,
    stopped: STOPPED_STATUSES.includes(status),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Queue order first, then oldest request first.
 *
 * Live entries carry a real position, so they sort by it. Everything else has
 * no position because nothing has claimed a turn for it; those fall back to
 * age, which is the order they would land in if you worked through them.
 */
function compareEntries(a: LandingQueueRun, b: LandingQueueRun): number {
  if (a.position !== null && b.position !== null) return a.position - b.position;
  if (a.position !== null) return -1;
  if (b.position !== null) return 1;
  return a.createdAt.localeCompare(b.createdAt);
}

export interface LandingQueueCount {
  live: number;
  pending: number;
  total: number;
}

/**
 * Just the totals, for the project list.
 *
 * One query covering every project rather than one per project: the list
 * renders a badge per card, and a per-card call would mean a query each.
 */
export function landingQueueCounts(
  projects: readonly ProjectView[],
): Map<string, LandingQueueCount> {
  const counts = new Map<string, LandingQueueCount>();
  if (projects.length === 0) return counts;

  const db = getDb();
  const rows = db
    .select({
      id: runs.id,
      projectId: runs.projectId,
      status: runs.status,
      disposition: runs.disposition,
    })
    .from(runs)
    .where(
      inArray(
        runs.projectId,
        projects.map((p) => p.id),
      ),
    )
    .all();

  const landableByProject = new Map<string, Set<string>>();
  const runProject = new Map<string, string>();
  for (const row of rows) {
    runProject.set(row.id, row.projectId);
    if (!isLandableStatus(row.status as RunStatus, row.disposition as Disposition | null)) continue;
    const bucket = landableByProject.get(row.projectId);
    if (bucket) bucket.add(row.id);
    else landableByProject.set(row.projectId, new Set([row.id]));
  }

  for (const project of projects) {
    const pendingIds = new Set(landableByProject.get(project.id) ?? []);
    let live = 0;
    for (const entry of landingQueueSnapshot(project.repositoryPath)) {
      if (runProject.get(entry.runId) !== project.id) continue;
      live += 1;
      pendingIds.delete(entry.runId);
    }
    counts.set(project.id, { live, pending: pendingIds.size, total: live + pendingIds.size });
  }

  return counts;
}
