import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Discovery, read and write for Claude/Codex configuration files.
 *
 * The user scope is redirected at a fixture directory via
 * `DEV_COCKPIT_HOME_DIR` (the same override pattern `dataDir()` uses), so
 * this never touches the real `~/.claude` or `~/.codex`.
 */

let root: string;
let configMod: typeof import('@/services/agent-config');

function fixture(name: string, files: Record<string, string>): string {
  const dir = path.join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-agent-config-'));
  configMod = await import('@/services/agent-config');
});

afterEach(() => {
  delete process.env.DEV_COCKPIT_HOME_DIR;
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('user scope discovery', () => {
  it('finds skills, sub-agents, rules and settings, and marks Codex system skills read-only', () => {
    const home = fixture('home-full', {
      '.claude/skills/commit/SKILL.md': '# commit',
      '.claude/skills/.trash/gone/SKILL.md': '# gone',
      '.claude/agents/planner.md': '# planner',
      '.claude/rules/voice.md': '# voice',
      '.claude/settings.json': '{}',
      '.codex/config.toml': 'model = "gpt-5"',
      '.codex/skills/my-skill/SKILL.md': '# my skill',
      '.codex/skills/.system/imagegen/SKILL.md': '# imagegen',
    });
    process.env.DEV_COCKPIT_HOME_DIR = home;

    const entries = configMod.listAgentConfig({ kind: 'user' });

    const commit = entries.find((e) => e.relativePath === '.claude/skills/commit/SKILL.md');
    expect(commit?.tool).toBe('claude');
    expect(commit?.category).toBe('skill');
    expect(commit?.editable).toBe(true);

    // `.trash` is never a real skill.
    expect(entries.some((e) => e.relativePath.includes('.trash'))).toBe(false);

    const planner = entries.find((e) => e.relativePath === '.claude/agents/planner.md');
    expect(planner?.category).toBe('agent');

    const rule = entries.find((e) => e.relativePath === '.claude/rules/voice.md');
    expect(rule?.category).toBe('rule');

    const settings = entries.find((e) => e.relativePath === '.claude/settings.json');
    expect(settings?.category).toBe('settings');
    expect(settings?.editable).toBe(true);

    const configToml = entries.find((e) => e.relativePath === '.codex/config.toml');
    expect(configToml?.tool).toBe('codex');
    expect(configToml?.editable).toBe(true);

    const userSkill = entries.find((e) => e.relativePath === '.codex/skills/my-skill/SKILL.md');
    expect(userSkill?.editable).toBe(true);

    const systemSkill = entries.find(
      (e) => e.relativePath === '.codex/skills/.system/imagegen/SKILL.md',
    );
    expect(systemSkill?.editable).toBe(false);
    expect(systemSkill?.readOnlyReason).toMatch(/Codex/);
  });

  it('returns an empty list rather than throwing when nothing is there', () => {
    const home = fixture('home-empty', {});
    process.env.DEV_COCKPIT_HOME_DIR = home;

    expect(configMod.listAgentConfig({ kind: 'user' })).toEqual([]);
  });
});

describe('project scope discovery', () => {
  it('finds CLAUDE.md, AGENTS.md and a project-local .claude directory', () => {
    const repo = fixture('project-repo', {
      'CLAUDE.md': '# instructions',
      'AGENTS.md': '# agents',
      '.claude/skills/local-skill/SKILL.md': '# local',
    });

    const entries = configMod.listAgentConfig({
      kind: 'project',
      projectId: 'p1',
      repositoryPath: repo,
    });

    expect(entries.find((e) => e.relativePath === 'CLAUDE.md')?.category).toBe('instructions');
    expect(entries.find((e) => e.relativePath === 'AGENTS.md')?.category).toBe('instructions');
    expect(
      entries.find((e) => e.relativePath === '.claude/skills/local-skill/SKILL.md')?.editable,
    ).toBe(true);
  });
});

describe('read and write', () => {
  it('reads back exactly what discovery reports for an editable file', () => {
    const repo = fixture('rw-repo', { 'CLAUDE.md': 'hello' });
    const scope = { kind: 'project' as const, projectId: 'p1', repositoryPath: repo };

    const file = configMod.readAgentConfigFile(scope, 'CLAUDE.md');
    expect(file.content).toBe('hello');
    expect(file.editable).toBe(true);
  });

  it('writes an editable file and the write is visible on disk', () => {
    const repo = fixture('rw-repo-2', { 'CLAUDE.md': 'hello' });
    const scope = { kind: 'project' as const, projectId: 'p1', repositoryPath: repo };

    configMod.writeAgentConfigFile(scope, 'CLAUDE.md', 'updated');
    expect(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf8')).toBe('updated');
  });

  it('refuses to write a read-only entry', () => {
    const home = fixture('rw-readonly', {
      '.codex/skills/.system/imagegen/SKILL.md': 'vendor content',
    });
    process.env.DEV_COCKPIT_HOME_DIR = home;

    expect(() =>
      configMod.writeAgentConfigFile(
        { kind: 'user' },
        '.codex/skills/.system/imagegen/SKILL.md',
        'tampered',
      ),
    ).toThrow(/read-only/);
    expect(fs.readFileSync(path.join(home, '.codex/skills/.system/imagegen/SKILL.md'), 'utf8')).toBe(
      'vendor content',
    );
  });

  it('refuses an id that discovery never listed, even if it resolves inside the root', () => {
    const repo = fixture('rw-repo-3', {
      'CLAUDE.md': 'hello',
      'secrets.env': 'API_KEY=xyz',
    });
    const scope = { kind: 'project' as const, projectId: 'p1', repositoryPath: repo };

    expect(() => configMod.readAgentConfigFile(scope, 'secrets.env')).toThrow();
  });

  it('refuses an id that tries to escape the scope root', () => {
    const repo = fixture('rw-repo-4', { 'CLAUDE.md': 'hello' });
    const scope = { kind: 'project' as const, projectId: 'p1', repositoryPath: repo };

    expect(() => configMod.readAgentConfigFile(scope, '../rw-repo-3/secrets.env')).toThrow();
  });

  it('refuses a file over the read size cap', () => {
    const repo = fixture('rw-repo-huge', {
      'CLAUDE.md': 'x'.repeat(configMod.MAX_AGENT_CONFIG_READ_BYTES + 1),
    });
    const scope = { kind: 'project' as const, projectId: 'p1', repositoryPath: repo };

    expect(() => configMod.readAgentConfigFile(scope, 'CLAUDE.md')).toThrow(/too large/);
  });
});
