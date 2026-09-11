import 'server-only';

import { desc, eq } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { projectConfigRevisions } from '@/db/schema';
import { newRevisionId } from '@/core/ids';
import { notFound } from '@/core/errors';
import type { ConfigRevisionSource } from '@/domain/types';
import {
  requireProject,
  replaceValidationSteps,
  toStepInput,
  updateProject,
  type PreviewConfigView,
  type ProjectView,
  type ValidationStepInput,
} from './projects';

/**
 * The undo history behind every configuration change.
 *
 * This exists because the advisor is now allowed to save on its own. A model
 * writing shell commands into a project without a human reading them first is
 * only reasonable if the previous configuration is one click away, so a
 * snapshot is taken before *every* save — the user's own included, since a
 * history with holes in it is not a history.
 *
 * Deliberately narrow: the snapshot holds the validation pipeline and the
 * preview configuration, not the whole project. Those are the fields a draft
 * touches, and restoring a repository path or a retention window from an old
 * revision would be a surprise rather than a rescue.
 */

export interface ConfigSnapshot {
  validationSteps: ValidationStepInput[];
  preview: PreviewConfigView;
}

export interface ConfigRevisionView {
  id: string;
  projectId: string;
  source: ConfigRevisionSource;
  note: string | null;
  createdAt: string;
  snapshot: ConfigSnapshot;
  /** A one-line account for the list, so the UI need not parse the snapshot. */
  summary: string;
}

/** How many revisions a project keeps. Older ones are pruned on write. */
const MAX_REVISIONS = 50;

export function snapshotOf(project: ProjectView): ConfigSnapshot {
  return {
    validationSteps: project.validationSteps.map(toStepInput),
    preview: project.preview,
  };
}

/**
 * Records the configuration as it stands, before something changes it.
 *
 * Returns the revision id so a caller can name it in a message. A project whose
 * configuration is unchanged since the last revision is not recorded again —
 * pressing Save twice should not bury the revision worth going back to.
 */
export function recordRevision(
  projectId: string,
  source: ConfigRevisionSource,
  note: string | null,
): string | null {
  const project = requireProject(projectId);
  const snapshot = snapshotOf(project);
  const serialised = JSON.stringify(snapshot);

  const db = getDb();
  const latest = db
    .select()
    .from(projectConfigRevisions)
    .where(eq(projectConfigRevisions.projectId, projectId))
    .orderBy(desc(projectConfigRevisions.createdAt))
    .limit(1)
    .get();

  if (latest && latest.snapshot === serialised) return null;

  const id = newRevisionId();
  db.insert(projectConfigRevisions)
    .values({ id, projectId, snapshot: serialised, source, note })
    .run();

  prune(projectId);
  return id;
}

export function listRevisions(projectId: string): ConfigRevisionView[] {
  const db = getDb();
  return db
    .select()
    .from(projectConfigRevisions)
    .where(eq(projectConfigRevisions.projectId, projectId))
    .orderBy(desc(projectConfigRevisions.createdAt))
    .all()
    .map(hydrate)
    .filter((revision): revision is ConfigRevisionView => revision !== null);
}

/**
 * Puts a stored configuration back.
 *
 * Takes a revision of its own first, so reverting is itself undoable — the
 * common mistake after a revert is realising the thing you reverted away from
 * was the one you wanted.
 */
export function revertToRevision(projectId: string, revisionId: string): ProjectView {
  const db = getDb();
  const row = db
    .select()
    .from(projectConfigRevisions)
    .where(eq(projectConfigRevisions.id, revisionId))
    .get();

  if (!row || row.projectId !== projectId) throw notFound(`Revision ${revisionId}`);
  const revision = hydrate(row);
  if (!revision) throw notFound(`Revision ${revisionId} (unreadable snapshot)`);

  recordRevision(projectId, 'user', `Replaced by a revert to ${revisionId}`);

  updateProject(projectId, {
    developmentCommand: revision.snapshot.preview.command,
    preview: {
      workingDir: revision.snapshot.preview.workingDir,
      env: revision.snapshot.preview.env,
      portStrategy: revision.snapshot.preview.portStrategy,
      fixedPort: revision.snapshot.preview.fixedPort,
      readyPath: revision.snapshot.preview.readyPath,
      readyTimeoutMs: revision.snapshot.preview.readyTimeoutMs,
      autoStart: revision.snapshot.preview.autoStart,
    },
  });
  replaceValidationSteps(projectId, revision.snapshot.validationSteps);

  return requireProject(projectId);
}

function prune(projectId: string): void {
  const db = getDb();
  const rows = db
    .select({ id: projectConfigRevisions.id })
    .from(projectConfigRevisions)
    .where(eq(projectConfigRevisions.projectId, projectId))
    .orderBy(desc(projectConfigRevisions.createdAt))
    .all();

  for (const row of rows.slice(MAX_REVISIONS)) {
    db.delete(projectConfigRevisions).where(eq(projectConfigRevisions.id, row.id)).run();
  }
}

/**
 * Parses a stored snapshot, or returns null when it cannot be read.
 *
 * Null rather than a throw: one unreadable row from an older shape should cost
 * that row, not the whole history list.
 */
function hydrate(row: typeof projectConfigRevisions.$inferSelect): ConfigRevisionView | null {
  let snapshot: ConfigSnapshot;
  try {
    snapshot = JSON.parse(row.snapshot) as ConfigSnapshot;
  } catch {
    return null;
  }
  if (!Array.isArray(snapshot?.validationSteps)) return null;

  const steps = snapshot.validationSteps.length;
  const command = snapshot.preview?.command;
  return {
    id: row.id,
    projectId: row.projectId,
    source: row.source as ConfigRevisionSource,
    note: row.note,
    createdAt: row.createdAt,
    snapshot,
    summary: `${steps} step${steps === 1 ? '' : 's'}${command ? `, preview \`${command}\`` : ', no preview'}`,
  };
}
