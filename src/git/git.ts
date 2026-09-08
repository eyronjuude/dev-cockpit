import 'server-only';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly cwd: string,
    readonly stderr: string,
    readonly exitCode: number,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Runs git with an explicit argument array — never through a shell — so no
 * path or branch name can be interpreted as shell syntax.
 */
export async function git(
  cwd: string,
  args: string[],
  opts: { allowFailure?: boolean; maxBuffer?: number } = {},
): Promise<GitResult> {
  const { allowFailure = false, maxBuffer = 64 * 1024 * 1024 } = opts;
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      maxBuffer,
      windowsHide: true,
      env: {
        ...process.env,
        // Keep git from opening an editor or a credential prompt: this runs
        // headless and a blocked prompt would hang the run.
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
      },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    const exitCode = typeof e.code === 'number' ? e.code : 1;
    if (allowFailure) {
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? e.message ?? '', exitCode };
    }
    throw new GitError(
      `git ${args.join(' ')} failed: ${(e.stderr ?? e.message ?? '').trim()}`,
      args,
      cwd,
      e.stderr ?? '',
      exitCode,
    );
  }
}

export async function isGitRepository(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) return false;
  } catch {
    return false;
  }
  const res = await git(dir, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
  return res.exitCode === 0 && res.stdout.trim() === 'true';
}

/** Absolute path of the repository's top level, resolving any subdirectory. */
export async function repositoryRoot(dir: string): Promise<string> {
  const res = await git(dir, ['rev-parse', '--show-toplevel']);
  return path.resolve(res.stdout.trim());
}

export async function currentBranch(dir: string): Promise<string> {
  const res = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return res.stdout.trim();
}

export async function resolveCommit(dir: string, ref: string): Promise<string> {
  const res = await git(dir, ['rev-parse', '--verify', `${ref}^{commit}`]);
  return res.stdout.trim();
}

export async function refExists(dir: string, ref: string): Promise<boolean> {
  const res = await git(dir, ['rev-parse', '--verify', '--quiet', ref], { allowFailure: true });
  return res.exitCode === 0;
}

export async function listBranches(dir: string): Promise<string[]> {
  const res = await git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  return res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export interface CommitInfo {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string;
}

export async function commitInfo(dir: string, ref: string): Promise<CommitInfo | null> {
  // Newline-separated: %s is the subject line only, so no field can contain a
  // newline and the split stays unambiguous without a control-byte separator.
  const res = await git(
    dir,
    ['show', '-s', '--format=%H%n%h%n%s%n%an%n%aI', `${ref}^{commit}`],
    { allowFailure: true },
  );
  if (res.exitCode !== 0) return null;
  const [sha, shortSha, subject, author, date] = res.stdout.trim().split(String.fromCharCode(10));
  if (!sha) return null;
  return {
    sha,
    shortSha: shortSha ?? sha.slice(0, 7),
    subject: subject ?? '',
    author: author ?? '',
    date: date ?? '',
  };
}

/** True when the working tree or index has changes. */
export async function isDirty(dir: string): Promise<boolean> {
  const res = await git(dir, ['status', '--porcelain']);
  return res.stdout.trim().length > 0;
}

/**
 * Default branch guess: the configured HEAD of origin, else the first of
 * main/master that exists, else the current branch.
 */
export async function guessDefaultBranch(dir: string): Promise<string> {
  const originHead = await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    allowFailure: true,
  });
  if (originHead.exitCode === 0) {
    const name = originHead.stdout.trim().replace(/^origin\//, '');
    if (name) return name;
  }
  for (const candidate of ['main', 'master']) {
    if (await refExists(dir, `refs/heads/${candidate}`)) return candidate;
  }
  return currentBranch(dir);
}

export interface AheadBehind {
  ahead: number;
  behind: number;
}

/**
 * How far `head` has diverged from `base`.
 *
 * Used to catch a run about to branch from a stale base: a repository whose
 * checked-out branch is ahead of the project's default branch will silently
 * produce work built on old code unless the base ref is corrected.
 */
export async function aheadBehind(
  dir: string,
  base: string,
  head: string,
): Promise<AheadBehind | null> {
  const res = await git(dir, ['rev-list', '--left-right', '--count', `${base}...${head}`], {
    allowFailure: true,
  });
  if (res.exitCode !== 0) return null;

  const [behindRaw, aheadRaw] = res.stdout.trim().split(/\s+/);
  const behind = Number.parseInt(behindRaw ?? '', 10);
  const ahead = Number.parseInt(aheadRaw ?? '', 10);
  if (Number.isNaN(behind) || Number.isNaN(ahead)) return null;
  return { ahead, behind };
}
