import 'server-only';

import { asc, eq } from 'drizzle-orm';
import path from 'node:path';

import { getDb } from '@/db/client';
import { commits } from '@/db/schema';
import { newCommitId } from '@/core/ids';
import { commitPatch } from '@/git/diff';
import { listCommitsSince } from '@/git/git';
import { writeTextArtifact } from './artifacts';

export interface CommitView {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorDate: string;
  additions: number;
  deletions: number;
  filesChanged: number;
  /** The commit's own patch, when one could be captured. */
  diffArtifactId: string | null;
  /**
   * Whether this run's branch has been merged into its target branch.
   *
   * There is no push or remote in this app — landing is the closest event to
   * "shipped" a commit can reach, so that is what this reports.
   */
  landed: boolean;
  landedAt: string | null;
}

function hydrate(row: typeof commits.$inferSelect): CommitView {
  return {
    sha: row.sha,
    shortSha: row.shortSha,
    subject: row.subject,
    authorName: row.authorName,
    authorDate: row.authorDate,
    additions: row.additions,
    deletions: row.deletions,
    filesChanged: row.filesChanged,
    diffArtifactId: row.diffArtifactId,
    landed: row.landed,
    landedAt: row.landedAt,
  };
}

export function listRunCommits(runId: string): CommitView[] {
  const db = getDb();
  return db
    .select()
    .from(commits)
    .where(eq(commits.runId, runId))
    .orderBy(asc(commits.authorDate))
    .all()
    .map(hydrate);
}

/**
 * Records any commit on the run's branch since its base commit that this
 * table does not already know about.
 *
 * Safe to call after every iteration and again at landing: existing shas are
 * skipped, so a call that finds nothing new does nothing. The commit's own
 * patch is captured as a `commit_diff` artifact at the same time, because the
 * worktree this reads from is reclaimed once the run finishes — the artifact
 * is what a reviewer opening the run later actually sees.
 */
export async function recordRunCommits(
  runId: string,
  worktreePath: string,
  baseCommit: string,
): Promise<void> {
  const found = await listCommitsSince(worktreePath, baseCommit, 'HEAD');
  if (found.length === 0) return;

  const db = getDb();
  const existing = new Set(
    db
      .select({ sha: commits.sha })
      .from(commits)
      .where(eq(commits.runId, runId))
      .all()
      .map((row) => row.sha),
  );

  for (const commit of found) {
    if (existing.has(commit.sha)) continue;

    let diffArtifactId: string | null = null;
    try {
      const patch = await commitPatch(worktreePath, commit.sha);
      const artifact = await writeTextArtifact({
        runId,
        kind: 'commit_diff',
        label: `Commit ${commit.shortSha}`,
        fileName: path.join('commits', `${commit.sha}.patch`),
        content: patch,
        mimeType: 'text/x-diff',
        // A diff is evidence, same as the run's own `git_diff` artifact — redaction
        // would alter it, so it is stored verbatim.
        redactContent: false,
        meta: { sha: commit.sha, subject: commit.subject },
      });
      diffArtifactId = artifact.id;
    } catch {
      // The commit row is still worth recording without its patch — a missing
      // diff is a smaller loss than a missing commit.
    }

    db.insert(commits)
      .values({
        id: newCommitId(),
        runId,
        sha: commit.sha,
        shortSha: commit.shortSha,
        subject: commit.subject,
        authorName: commit.authorName,
        authorDate: commit.authorDate,
        additions: commit.additions,
        deletions: commit.deletions,
        filesChanged: commit.filesChanged,
        diffArtifactId,
      })
      .run();
  }
}

/** Marks every commit recorded for a run as landed, once the run's branch merges. */
export function markRunCommitsLanded(runId: string): void {
  const db = getDb();
  db.update(commits)
    .set({ landed: true, landedAt: new Date().toISOString() })
    .where(eq(commits.runId, runId))
    .run();
}

/**
 * Forgets the commits recorded for a run, for a forced restart.
 *
 * A restart gives the run a new branch (`resetRunForRestart`), so these rows
 * would otherwise describe commits that no longer belong to the run's current
 * attempt — the same reason that call already clears `changedFiles`. Their
 * `commit_diff` artifacts are left alone: artifacts are a record of what
 * happened and a restart is a new attempt, not an erasure of the last one.
 */
export function clearRunCommits(runId: string): void {
  const db = getDb();
  db.delete(commits).where(eq(commits.runId, runId)).run();
}
