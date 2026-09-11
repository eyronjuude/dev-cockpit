import 'server-only';

import { inArray } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { runs } from '@/db/schema';
import type { LandingModeKind, LandingQueueState } from '@/domain/landing';
import type { RunStatus } from '@/domain/types';
import { landingQueueSnapshot, type LandingQueueEntry } from '@/orchestrator/orchestrator';
import type { ProjectView } from '@/services/projects';

/**
 * Who is landing right now, and who is behind them.
 *
 * This mirrors the orchestrator's in-memory queue exactly: a run appears here
 * only once its landing has actually been asked for — "Land on {branch}",
 * "Resolve conflicts with AI", or a Retry that resumes a stopped landing.
 * Nothing shows up here just because it is entitled to land; that entitlement
 * is what makes the Land button available on the run itself, not what fills
 * this list.
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
  /** 0 for the run currently landing, then 1 upwards for those behind it. */
  position: number;
  /** What the queued landing will do when its turn comes. */
  mode: LandingModeKind;
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
}

interface QueueRow {
  id: string;
  projectId: string;
  title: string;
  status: string;
  branch: string | null;
  createdAt: string;
  updatedAt: string;
}

const QUEUE_COLUMNS = {
  id: runs.id,
  projectId: runs.projectId,
  title: runs.title,
  status: runs.status,
  branch: runs.branch,
  createdAt: runs.createdAt,
  updatedAt: runs.updatedAt,
} as const;

/**
 * Every run actually queued to land for this project, live queue order.
 *
 * The queue is keyed by repository path rather than by project id, and
 * nothing stops a second project being registered against a repository an
 * archived one already holds, so entries are resolved back through the
 * database and any run belonging to another project is dropped.
 */
export function projectLandingQueue(project: ProjectView): LandingQueueView {
  const live = landingQueueSnapshot(project.repositoryPath);

  const rows: QueueRow[] =
    live.length === 0
      ? []
      : getDb()
          .select(QUEUE_COLUMNS)
          .from(runs)
          .where(
            inArray(
              runs.id,
              live.map((entry) => entry.runId),
            ),
          )
          .all();

  const rowById = new Map(
    rows.filter((row) => row.projectId === project.id).map((row) => [row.id, row] as const),
  );

  const byBranch = new Map<string, LandingQueueRun[]>();
  let liveCount = 0;
  for (const entry of live) {
    const row = rowById.get(entry.runId);
    if (!row) continue;
    liveCount += 1;
    const queueRun = toQueueRun(row, entry);
    const bucket = byBranch.get(entry.targetBranch);
    if (bucket) bucket.push(queueRun);
    else byBranch.set(entry.targetBranch, [queueRun]);
  }

  const branches = [...byBranch.entries()]
    .map(([targetBranch, entries]) => ({
      targetBranch,
      entries: entries.sort((a, b) => a.position - b.position),
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
    liveCount,
  };
}

function toQueueRun(row: QueueRow, entry: LandingQueueEntry): LandingQueueRun {
  return {
    id: row.id,
    title: row.title,
    branch: row.branch,
    status: row.status as RunStatus,
    targetBranch: entry.targetBranch,
    state: entry.state,
    position: entry.position,
    mode: entry.mode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface LandingQueueCount {
  live: number;
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
    .select({ id: runs.id, projectId: runs.projectId })
    .from(runs)
    .where(
      inArray(
        runs.projectId,
        projects.map((p) => p.id),
      ),
    )
    .all();

  const runProject = new Map(rows.map((row) => [row.id, row.projectId] as const));

  for (const project of projects) {
    let live = 0;
    for (const entry of landingQueueSnapshot(project.repositoryPath)) {
      if (runProject.get(entry.runId) === project.id) live += 1;
    }
    counts.set(project.id, { live });
  }

  return counts;
}
