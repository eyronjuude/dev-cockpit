import path from 'node:path';
import fs from 'node:fs';

/**
 * Root for everything the app writes: SQLite database, artifacts, worktrees.
 * Overridable so the database can live off a synced drive if wanted.
 */
export function dataDir(): string {
  const configured = process.env.DEV_COCKPIT_DATA_DIR?.trim();
  const root = configured && configured.length > 0 ? configured : path.join(process.cwd(), 'data');
  return path.resolve(root);
}

export const dbPath = () => path.join(dataDir(), 'cockpit.db');
export const worktreesDir = () => path.join(dataDir(), 'worktrees');
export const landingsDir = () => path.join(dataDir(), 'landings');
export const artifactsDir = () => path.join(dataDir(), 'artifacts');

/**
 * Files the user attached to a request.
 *
 * Deliberately not under `artifacts/`. An artifact is something a run
 * produced and retention may delete it; an attachment is something the
 * developer supplied and deleting it would destroy an input nobody else has a
 * copy of. Keeping the two roots apart means no cleanup path can confuse them.
 */
export const attachmentsDir = () => path.join(dataDir(), 'attachments');

export const runWorktreeDir = (projectId: string, runId: string) =>
  path.join(worktreesDir(), projectId, runId);

export const runLandingDir = (projectId: string, runId: string) =>
  path.join(landingsDir(), projectId, runId);

export const runArtifactDir = (runId: string) => path.join(artifactsDir(), runId);

/**
 * One directory per run, because it is handed to the agent whole with
 * `--add-dir`. A shared directory would grant read access to every other
 * run's attachments at the same time.
 */
export const runAttachmentDir = (runId: string) => path.join(attachmentsDir(), runId);

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureDataDirs(): void {
  ensureDir(dataDir());
  ensureDir(worktreesDir());
  ensureDir(landingsDir());
  ensureDir(artifactsDir());
  ensureDir(attachmentsDir());
}

/**
 * True when `child` is inside `parent`. Used to keep artifact reads and
 * worktree removals from escaping the data directory.
 */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}
