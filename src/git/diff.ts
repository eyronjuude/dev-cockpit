import 'server-only';

import type { ChangeType } from '@/domain/types';
import { git } from './git';

export interface FileChange {
  path: string;
  previousPath: string | null;
  changeType: ChangeType;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface RunDiff {
  /** Unified diff of committed + staged + unstaged changes against the base. */
  patch: string;
  files: FileChange[];
  additions: number;
  deletions: number;
  /** True when the patch was cut short by the size cap. */
  truncated: boolean;
}

const MAX_PATCH_BYTES = 4 * 1024 * 1024;

function mapStatus(code: string): ChangeType {
  switch (code[0]) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'added';
    case 'M':
    case 'T':
      return 'modified';
    default:
      return 'modified';
  }
}

/**
 * Files the agent created but never staged are invisible to `git diff`, so they
 * are collected separately and reported as `untracked`.
 */
async function untrackedFiles(worktree: string): Promise<string[]> {
  const res = await git(worktree, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]);
  return res.stdout.split('\0').filter((p) => p.length > 0);
}

async function numstat(worktree: string, baseCommit: string): Promise<Map<string, FileChange>> {
  const out = new Map<string, FileChange>();

  // `--find-renames` plus `-z` gives machine-readable rename pairs.
  const statusRes = await git(worktree, [
    'diff',
    '--find-renames',
    '--name-status',
    '-z',
    baseCommit,
  ]);
  const statusFields = statusRes.stdout.split('\0').filter((f) => f.length > 0);
  const statuses = new Map<string, { changeType: ChangeType; previousPath: string | null }>();

  for (let i = 0; i < statusFields.length; ) {
    const code = statusFields[i];
    if (code === undefined) break;
    if (code.startsWith('R') || code.startsWith('C')) {
      const from = statusFields[i + 1];
      const to = statusFields[i + 2];
      i += 3;
      if (to === undefined) break;
      statuses.set(to, { changeType: mapStatus(code), previousPath: from ?? null });
    } else {
      const file = statusFields[i + 1];
      i += 2;
      if (file === undefined) break;
      statuses.set(file, { changeType: mapStatus(code), previousPath: null });
    }
  }

  const numRes = await git(worktree, [
    'diff',
    '--find-renames',
    '--numstat',
    '-z',
    baseCommit,
  ]);
  // With -z, numstat emits: "adds\tdels\t\0old\0new\0" for renames and
  // "adds\tdels\tpath\0" otherwise.
  const numFields = numRes.stdout.split('\0');
  for (let i = 0; i < numFields.length; i += 1) {
    const field = numFields[i];
    if (!field) continue;
    const parts = field.split('\t');
    if (parts.length < 3) continue;
    const [addsRaw, delsRaw, inlinePath] = parts as [string, string, string];

    let filePath = inlinePath;
    let previousPath: string | null = null;
    if (filePath === '') {
      previousPath = numFields[i + 1] ?? null;
      filePath = numFields[i + 2] ?? '';
      i += 2;
    }
    if (!filePath) continue;

    const binary = addsRaw === '-' || delsRaw === '-';
    const status = statuses.get(filePath);
    out.set(filePath, {
      path: filePath,
      previousPath: previousPath ?? status?.previousPath ?? null,
      changeType: status?.changeType ?? 'modified',
      additions: binary ? 0 : Number.parseInt(addsRaw, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(delsRaw, 10) || 0,
      binary,
    });
  }

  // A status entry with no numstat row (a pure rename) still counts as changed.
  for (const [file, status] of statuses) {
    if (out.has(file)) continue;
    out.set(file, {
      path: file,
      previousPath: status.previousPath,
      changeType: status.changeType,
      additions: 0,
      deletions: 0,
      binary: false,
    });
  }

  return out;
}

/**
 * Everything that changed in the worktree relative to the run's base commit,
 * including changes the agent left unstaged and files it never added.
 *
 * Diffs are evidence: this function reads and formats, it never rewrites.
 */
export async function collectRunDiff(worktree: string, baseCommit: string): Promise<RunDiff> {
  const changes = await numstat(worktree, baseCommit);

  const untracked = await untrackedFiles(worktree);
  for (const file of untracked) {
    if (changes.has(file)) continue;
    // Count lines so an untracked file is not silently reported as 0 additions.
    const stat = await git(
      worktree,
      ['diff', '--numstat', '--no-index', '--', devNull(), file],
      { allowFailure: true },
    );
    const first = stat.stdout.split('\n')[0] ?? '';
    const [addsRaw = '0', delsRaw = '0'] = first.split('\t');
    const binary = addsRaw === '-' || delsRaw === '-';
    changes.set(file, {
      path: file,
      previousPath: null,
      changeType: 'untracked',
      additions: binary ? 0 : Number.parseInt(addsRaw, 10) || 0,
      deletions: 0,
      binary,
    });
  }

  const files = [...changes.values()].sort((a, b) => a.path.localeCompare(b.path));

  const patchRes = await git(
    worktree,
    ['diff', '--find-renames', '--patch', '--stat', baseCommit],
    { allowFailure: true, maxBuffer: MAX_PATCH_BYTES * 2 },
  );

  let patch = patchRes.stdout;

  // Append untracked files so the diff view shows new work rather than nothing.
  for (const file of untracked) {
    const single = await git(
      worktree,
      ['diff', '--no-index', '--', devNull(), file],
      { allowFailure: true },
    );
    if (single.stdout.trim()) patch += `\n${single.stdout}`;
  }

  let truncated = false;
  if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) {
    patch = `${patch.slice(0, MAX_PATCH_BYTES)}\n\n... [diff truncated at ${MAX_PATCH_BYTES} bytes] ...\n`;
    truncated = true;
  }

  return {
    patch,
    files,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    truncated,
  };
}

function devNull(): string {
  return process.platform === 'win32' ? 'NUL' : '/dev/null';
}

/**
 * Commits everything in the worktree onto the run branch. Only ever called
 * from the explicit approval action, and never touches a protected branch:
 * the run branch is created by the worktree module and is per-run.
 */
export async function commitAll(
  worktree: string,
  message: string,
  author: { name: string; email: string },
): Promise<string> {
  await git(worktree, ['add', '--all']);
  await git(worktree, [
    '-c',
    `user.name=${author.name}`,
    '-c',
    `user.email=${author.email}`,
    'commit',
    '--no-verify',
    '-m',
    message,
  ]);
  const res = await git(worktree, ['rev-parse', 'HEAD']);
  return res.stdout.trim();
}
