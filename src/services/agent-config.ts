import 'server-only';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { invalid, notFound } from '@/core/errors';
import { isInside } from '@/core/paths';

/**
 * Discovery, read and write for the Claude Code / Codex configuration files
 * that already live on this machine — skills, sub-agents, settings and
 * project instructions — at both the user scope (`~/.claude`, `~/.codex`)
 * and the project scope (a project's own repository root).
 *
 * Deliberately an explicit allow-list of known subpaths rather than a
 * generic recursive walk of `~/.claude`/`~/.codex`: most of those
 * directories are private runtime state (credentials, session transcripts,
 * sqlite databases) that must never be listed, let alone made writable,
 * from a web UI. Anything not named below is invisible to this module.
 */

export type AgentConfigTool = 'claude' | 'codex';
export type AgentConfigCategory = 'skill' | 'agent' | 'settings' | 'instructions' | 'rule';

export type AgentConfigScope =
  | { kind: 'user' }
  | { kind: 'project'; projectId: string; repositoryPath: string };

export interface AgentConfigEntry {
  /** Stable within its scope. Re-derived from discovery, never trusted as a raw path. */
  id: string;
  tool: AgentConfigTool;
  category: AgentConfigCategory;
  label: string;
  /** Relative to the scope's root, forward-slashed regardless of platform. */
  relativePath: string;
  editable: boolean;
  readOnlyReason: string | null;
  bytes: number;
  modifiedAt: string;
}

export interface AgentConfigFile extends AgentConfigEntry {
  content: string;
}

/** Above this, a config file is shown as too large rather than loaded. */
export const MAX_AGENT_CONFIG_READ_BYTES = 512 * 1024;

interface InternalEntry extends AgentConfigEntry {
  absolutePath: string;
}

/* ------------------------------------------------------------------ *
 * Filesystem helpers
 *
 * Every listing swallows a missing directory rather than throwing: no
 * `~/.claude/agents` or no project `.claude/` folder is the ordinary case,
 * not an error.
 * ------------------------------------------------------------------ */

function listFilesSafe(dir: string): { name: string; absolute: string }[] {
  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return items
    .filter((item) => item.isFile())
    .map((item) => ({ name: item.name, absolute: path.join(dir, item.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function listDirsSafe(dir: string): { name: string; absolute: string }[] {
  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return items
    .filter((item) => item.isDirectory())
    .map((item) => ({ name: item.name, absolute: path.join(dir, item.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function statOrNull(absolute: string): fs.Stats | null {
  try {
    return fs.statSync(absolute);
  } catch {
    return null;
  }
}

function toRelative(root: string, absolute: string): string {
  return path.relative(root, absolute).split(path.sep).join('/');
}

function makeEntry(
  root: string,
  absolute: string,
  tool: AgentConfigTool,
  category: AgentConfigCategory,
  label: string,
  editable: boolean,
  readOnlyReason: string | null,
): InternalEntry | null {
  const stat = statOrNull(absolute);
  if (!stat || !stat.isFile()) return null;
  return {
    id: toRelative(root, absolute),
    relativePath: toRelative(root, absolute),
    absolutePath: absolute,
    tool,
    category,
    label,
    editable,
    readOnlyReason,
    bytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
  };
}

/** One `SKILL.md` (+ siblings) per subdirectory of a Claude-style skills folder. */
function claudeSkillEntries(root: string, skillsDir: string): InternalEntry[] {
  const entries: InternalEntry[] = [];
  for (const dir of listDirsSafe(skillsDir)) {
    // `.trash`, etc. — never a real skill.
    if (dir.name.startsWith('.')) continue;
    for (const file of listFilesSafe(dir.absolute)) {
      const entry = makeEntry(
        root,
        file.absolute,
        'claude',
        'skill',
        `${dir.name}/${file.name}`,
        true,
        null,
      );
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

/**
 * Codex skills, with the vendor `.system` subtree kept distinct: those are
 * bundled by Codex itself and shown read-only, everything else is
 * user-authored and editable.
 */
function codexSkillEntries(root: string, skillsDir: string): InternalEntry[] {
  const entries: InternalEntry[] = [];
  for (const dir of listDirsSafe(skillsDir)) {
    if (dir.name === '.system') {
      for (const vendorDir of listDirsSafe(dir.absolute)) {
        for (const file of listFilesSafe(vendorDir.absolute)) {
          const entry = makeEntry(
            root,
            file.absolute,
            'codex',
            'skill',
            `${vendorDir.name}/${file.name}`,
            false,
            'Bundled by Codex',
          );
          if (entry) entries.push(entry);
        }
      }
      continue;
    }
    if (dir.name.startsWith('.')) continue;
    for (const file of listFilesSafe(dir.absolute)) {
      const entry = makeEntry(
        root,
        file.absolute,
        'codex',
        'skill',
        `${dir.name}/${file.name}`,
        true,
        null,
      );
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

/** Flat `*.md` files directly inside a directory — sub-agents or rules. */
function markdownEntries(
  root: string,
  dir: string,
  tool: AgentConfigTool,
  category: AgentConfigCategory,
): InternalEntry[] {
  const entries: InternalEntry[] = [];
  for (const file of listFilesSafe(dir)) {
    if (!file.name.toLowerCase().endsWith('.md')) continue;
    const entry = makeEntry(root, file.absolute, tool, category, file.name, true, null);
    if (entry) entries.push(entry);
  }
  return entries;
}

function singleFileEntry(
  root: string,
  absolute: string,
  tool: AgentConfigTool,
  category: AgentConfigCategory,
  label: string,
): InternalEntry[] {
  const entry = makeEntry(root, absolute, tool, category, label, true, null);
  return entry ? [entry] : [];
}

/* ------------------------------------------------------------------ *
 * Scope roots and discovery
 * ------------------------------------------------------------------ */

/**
 * Overridable the same way `dataDir()` is (`core/paths.ts`), so a test can
 * point the user scope at a fixture directory instead of the real home
 * directory.
 */
function homeDir(): string {
  const override = process.env.DEV_COCKPIT_HOME_DIR?.trim();
  return path.resolve(override && override.length > 0 ? override : os.homedir());
}

function rootFor(scope: AgentConfigScope): string {
  return scope.kind === 'user' ? homeDir() : path.resolve(scope.repositoryPath);
}

function discoverUserEntries(): InternalEntry[] {
  const root = homeDir();
  const claudeDir = path.join(root, '.claude');
  const codexDir = path.join(root, '.codex');

  return [
    ...claudeSkillEntries(root, path.join(claudeDir, 'skills')),
    ...markdownEntries(root, path.join(claudeDir, 'agents'), 'claude', 'agent'),
    ...markdownEntries(root, path.join(claudeDir, 'rules'), 'claude', 'rule'),
    ...singleFileEntry(root, path.join(claudeDir, 'settings.json'), 'claude', 'settings', 'settings.json'),
    ...singleFileEntry(root, path.join(claudeDir, 'CLAUDE.md'), 'claude', 'instructions', 'CLAUDE.md'),
    ...codexSkillEntries(root, path.join(codexDir, 'skills')),
    ...singleFileEntry(root, path.join(codexDir, 'config.toml'), 'codex', 'settings', 'config.toml'),
  ];
}

function discoverProjectEntries(repositoryPath: string): InternalEntry[] {
  const root = path.resolve(repositoryPath);
  const claudeDir = path.join(root, '.claude');
  const codexDir = path.join(root, '.codex');

  return [
    ...singleFileEntry(root, path.join(root, 'CLAUDE.md'), 'claude', 'instructions', 'CLAUDE.md'),
    ...singleFileEntry(root, path.join(root, 'AGENTS.md'), 'codex', 'instructions', 'AGENTS.md'),
    ...claudeSkillEntries(root, path.join(claudeDir, 'skills')),
    ...markdownEntries(root, path.join(claudeDir, 'agents'), 'claude', 'agent'),
    ...markdownEntries(root, path.join(claudeDir, 'rules'), 'claude', 'rule'),
    ...singleFileEntry(root, path.join(claudeDir, 'settings.json'), 'claude', 'settings', 'settings.json'),
    ...codexSkillEntries(root, path.join(codexDir, 'skills')),
    ...singleFileEntry(root, path.join(codexDir, 'config.toml'), 'codex', 'settings', 'config.toml'),
  ];
}

function discoverEntries(scope: AgentConfigScope): InternalEntry[] {
  return scope.kind === 'user' ? discoverUserEntries() : discoverProjectEntries(scope.repositoryPath);
}

/** Every config file this scope can show, tool first, then category, then name. */
export function listAgentConfig(scope: AgentConfigScope): AgentConfigEntry[] {
  return discoverEntries(scope)
    .map(({ absolutePath: _absolutePath, ...entry }) => entry)
    .sort(
      (a, b) =>
        a.tool.localeCompare(b.tool) ||
        a.category.localeCompare(b.category) ||
        a.label.localeCompare(b.label),
    );
}

/**
 * Resolves a client-supplied id back to a real file, but only if today's
 * discovery still lists it — an id is never used to build a path directly.
 * `isInside` is checked as well, as defense in depth against the resolver
 * itself ever computing something outside the scope's root.
 */
function resolveEntry(scope: AgentConfigScope, id: string): InternalEntry {
  const root = rootFor(scope);
  const normalized = id.replace(/\\/g, '/');
  const entry = discoverEntries(scope).find((candidate) => candidate.relativePath === normalized);
  if (!entry) throw notFound('Configuration file');
  if (!isInside(root, entry.absolutePath)) {
    throw invalid('That file is outside the allowed directory.');
  }
  return entry;
}

/* ------------------------------------------------------------------ *
 * Read / write
 * ------------------------------------------------------------------ */

export function readAgentConfigFile(scope: AgentConfigScope, id: string): AgentConfigFile {
  const entry = resolveEntry(scope, id);
  if (entry.bytes > MAX_AGENT_CONFIG_READ_BYTES) {
    throw invalid(
      `${entry.label} is too large to display here (over ${Math.round(
        MAX_AGENT_CONFIG_READ_BYTES / 1024,
      )} KB).`,
    );
  }
  const content = fs.readFileSync(entry.absolutePath, 'utf8');
  const { absolutePath: _absolutePath, ...publicEntry } = entry;
  return { ...publicEntry, content };
}

export function writeAgentConfigFile(
  scope: AgentConfigScope,
  id: string,
  content: string,
): AgentConfigFile {
  const entry = resolveEntry(scope, id);
  if (!entry.editable) {
    throw invalid(
      `${entry.label} is read-only${entry.readOnlyReason ? ` — ${entry.readOnlyReason}.` : '.'}`,
    );
  }
  fs.writeFileSync(entry.absolutePath, content, 'utf8');
  const stat = fs.statSync(entry.absolutePath);
  const { absolutePath: _absolutePath, ...publicEntry } = entry;
  return { ...publicEntry, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), content };
}
