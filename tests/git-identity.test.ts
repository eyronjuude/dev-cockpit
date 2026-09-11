import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let git: typeof import('@/git/git');
let dataDir: string;
let previousGitConfigGlobal: string | undefined;
let previousGitConfigNoSystem: string | undefined;

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

function makeRepo(name: string): string {
  const repo = path.join(dataDir, name);
  fs.mkdirSync(repo, { recursive: true });
  runGit(['init', '-q', '-b', 'main'], repo);
  return repo;
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-git-identity-'));

  // Point git at a global config file that does not exist and disable system
  // config, so `localGitIdentity`'s "unconfigured" cases are deterministic
  // regardless of what identity happens to be set on the machine running
  // this test.
  previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  previousGitConfigNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = path.join(dataDir, 'nonexistent-gitconfig');
  process.env.GIT_CONFIG_NOSYSTEM = '1';

  git = await import('@/git/git');
});

afterAll(() => {
  if (previousGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = previousGitConfigGlobal;
  if (previousGitConfigNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = previousGitConfigNoSystem;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('localGitIdentity', () => {
  it('returns the configured identity when user.name and user.email are set', async () => {
    const repo = makeRepo('configured');
    runGit(['config', 'user.name', 'Aaron Jude Tanael'], repo);
    runGit(['config', 'user.email', 'aaron@twinklingtree.com'], repo);

    const identity = await git.localGitIdentity(repo);
    expect(identity).toEqual({ name: 'Aaron Jude Tanael', email: 'aaron@twinklingtree.com' });
  });

  it('returns null when neither is set', async () => {
    const repo = makeRepo('unconfigured');
    const identity = await git.localGitIdentity(repo);
    expect(identity).toBeNull();
  });

  it('returns null when only the name is set', async () => {
    const repo = makeRepo('partial-name');
    runGit(['config', 'user.name', 'Only Name'], repo);
    const identity = await git.localGitIdentity(repo);
    expect(identity).toBeNull();
  });

  it('returns null when only the email is set', async () => {
    const repo = makeRepo('partial-email');
    runGit(['config', 'user.email', 'only@example.com'], repo);
    const identity = await git.localGitIdentity(repo);
    expect(identity).toBeNull();
  });
});
