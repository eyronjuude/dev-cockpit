import 'server-only';

import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import path from 'node:path';
import { z } from 'zod';

import { getDb } from '@/db/client';
import { projects, runs, validationCommands } from '@/db/schema';
import { newProjectId } from '@/core/ids';
import { AppError, conflict, invalid, notFound } from '@/core/errors';
import {
  agentPermissionModeSchema,
  DEFAULT_AGENT_PERMISSION_MODE,
  VALIDATION_KINDS,
  type ValidationKind,
} from '@/domain/types';
import { resolvePermissionMode } from '@/agents/permissions';
import {
  aheadBehind,
  currentBranch,
  guessDefaultBranch,
  isDirty,
  isGitRepository,
  listBranches,
  repositoryRoot,
} from '@/git/git';
import type { ProjectRow, ValidationCommandRow } from '@/db/schema';

/* ------------------------------------------------------------------ *
 * Input schemas
 * ------------------------------------------------------------------ */

export const validationCommandInputSchema = z.object({
  kind: z.enum(VALIDATION_KINDS),
  command: z.string().trim().max(2_000),
  workingDir: z.string().trim().max(500).nullable().optional(),
  timeoutMs: z.number().int().min(1_000).max(7_200_000).optional(),
  enabled: z.boolean().optional(),
  blocking: z.boolean().optional(),
  profiles: z.array(z.string()).optional(),
});

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  repositoryPath: z.string().trim().min(1),
  defaultBranch: z.string().trim().max(200).optional(),
  developmentCommand: z.string().trim().max(2_000).nullable().optional(),
  setupCommand: z.string().trim().max(2_000).nullable().optional(),
  openCommand: z.string().trim().max(2_000).nullable().optional(),
  linkPaths: z.array(z.string()).optional(),
  protectedBranches: z.array(z.string()).optional(),
  requireValidation: z.boolean().optional(),
  requireE2eForUiChanges: z.boolean().optional(),
  uiPathPatterns: z.array(z.string()).optional(),
  captureScreenshots: z.boolean().optional(),
  allowAgentCommit: z.boolean().optional(),
  reviewBlocksReady: z.boolean().optional(),
  cleanUpWorktreeOnFinish: z.boolean().optional(),
  artifactRetentionDays: z.number().int().min(1).max(3_650).optional(),
  agentModel: z.string().trim().max(120).nullable().optional(),
  agentPermissionMode: agentPermissionModeSchema.optional(),
  agentAddDirs: z.array(z.string()).optional(),
  validationCommands: z.array(validationCommandInputSchema).optional(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = createProjectSchema.partial().omit({ repositoryPath: true });
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

/* ------------------------------------------------------------------ *
 * Serialisation helpers
 * ------------------------------------------------------------------ */

/** Multi-value fields are newline-separated text: readable in any sqlite client. */
const toLines = (values: readonly string[] | undefined): string | undefined =>
  values === undefined ? undefined : values.map((v) => v.trim()).filter(Boolean).join('\n');

export const fromLines = (value: string | null | undefined): string[] =>
  (value ?? '')
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

export interface ValidationCommandView {
  id: number;
  kind: ValidationKind;
  command: string;
  workingDir: string | null;
  timeoutMs: number;
  enabled: boolean;
  blocking: boolean;
  profiles: string[];
}

export interface ProjectView {
  id: string;
  name: string;
  repositoryPath: string;
  defaultBranch: string;
  developmentCommand: string | null;
  setupCommand: string | null;
  openCommand: string | null;
  linkPaths: string[];
  protectedBranches: string[];
  requireValidation: boolean;
  requireE2eForUiChanges: boolean;
  uiPathPatterns: string[];
  captureScreenshots: boolean;
  allowAgentCommit: boolean;
  reviewBlocksReady: boolean;
  /** Reclaim the run and landing worktrees once a run lands or is rejected. */
  cleanUpWorktreeOnFinish: boolean;
  artifactRetentionDays: number;
  agentModel: string | null;
  /** What the project stores. May be overridden for a run. */
  agentPermissionMode: string;
  /**
   * What a run would actually use — the stored mode unless
   * `DEV_COCKPIT_PERMISSION_MODE` overrides it. Read this, not the field above,
   * anywhere the answer must match what the agent is really given.
   */
  effectivePermissionMode: string;
  agentAddDirs: string[];
  createdAt: string;
  updatedAt: string;
  validationCommands: ValidationCommandView[];
}

function toCommandView(row: ValidationCommandRow): ValidationCommandView {
  return {
    id: row.id,
    kind: row.kind as ValidationKind,
    command: row.command,
    workingDir: row.workingDir,
    timeoutMs: row.timeoutMs,
    enabled: row.enabled,
    blocking: row.blocking,
    profiles: fromLines(row.profiles),
  };
}

function toProjectView(row: ProjectRow, commands: ValidationCommandRow[]): ProjectView {
  return {
    id: row.id,
    name: row.name,
    repositoryPath: row.repositoryPath,
    defaultBranch: row.defaultBranch,
    developmentCommand: row.developmentCommand,
    setupCommand: row.setupCommand,
    openCommand: row.openCommand,
    linkPaths: fromLines(row.linkPaths),
    protectedBranches: fromLines(row.protectedBranches),
    requireValidation: row.requireValidation,
    requireE2eForUiChanges: row.requireE2eForUiChanges,
    uiPathPatterns: fromLines(row.uiPathPatterns),
    captureScreenshots: row.captureScreenshots,
    allowAgentCommit: row.allowAgentCommit,
    reviewBlocksReady: row.reviewBlocksReady,
    cleanUpWorktreeOnFinish: row.cleanUpWorktreeOnFinish,
    artifactRetentionDays: row.artifactRetentionDays,
    agentModel: row.agentModel,
    agentPermissionMode: row.agentPermissionMode,
    effectivePermissionMode: resolvePermissionMode(row.agentPermissionMode),
    agentAddDirs: fromLines(row.agentAddDirs),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    validationCommands: commands
      .slice()
      .sort(
        (a, b) =>
          VALIDATION_KINDS.indexOf(a.kind as ValidationKind) -
          VALIDATION_KINDS.indexOf(b.kind as ValidationKind),
      )
      .map(toCommandView),
  };
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

export function listProjects(): ProjectView[] {
  const db = getDb();
  const rows = db
    .select()
    .from(projects)
    .where(isNull(projects.archivedAt))
    .orderBy(asc(projects.name))
    .all();

  const commands = db.select().from(validationCommands).all();
  return rows.map((row) =>
    toProjectView(
      row,
      commands.filter((c) => c.projectId === row.id),
    ),
  );
}

export function getProject(id: string): ProjectView | null {
  const db = getDb();
  const row = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!row) return null;
  const commands = db
    .select()
    .from(validationCommands)
    .where(eq(validationCommands.projectId, id))
    .all();
  return toProjectView(row, commands);
}

export function requireProject(id: string): ProjectView {
  const project = getProject(id);
  if (!project) throw notFound(`Project ${id}`);
  return project;
}

export function projectRunCounts(projectId: string): { total: number; active: number } {
  const db = getDb();
  const rows = db.select({ status: runs.status }).from(runs).where(eq(runs.projectId, projectId)).all();
  const active = rows.filter((r) =>
    ['PREPARING', 'IMPLEMENTING', 'VALIDATING', 'REVIEWING'].includes(r.status),
  ).length;
  return { total: rows.length, active };
}

/* ------------------------------------------------------------------ *
 * Repository inspection
 * ------------------------------------------------------------------ */

export interface RepositoryProbe {
  ok: boolean;
  resolvedPath: string | null;
  defaultBranch: string | null;
  branches: string[];
  message: string;
}

/** Validates a candidate repository path before the project is created. */
export async function probeRepository(inputPath: string): Promise<RepositoryProbe> {
  const trimmed = inputPath.trim();
  if (!trimmed) {
    return { ok: false, resolvedPath: null, defaultBranch: null, branches: [], message: 'Path is empty.' };
  }

  const resolved = path.resolve(trimmed);

  if (!(await isGitRepository(resolved))) {
    return {
      ok: false,
      resolvedPath: resolved,
      defaultBranch: null,
      branches: [],
      message: 'Not a Git repository, or the path does not exist.',
    };
  }

  try {
    const root = await repositoryRoot(resolved);
    const [defaultBranch, branches] = await Promise.all([
      guessDefaultBranch(root),
      listBranches(root),
    ]);
    return {
      ok: true,
      resolvedPath: root,
      defaultBranch,
      branches,
      message:
        root === resolved
          ? 'Git repository found.'
          : `Resolved to the repository root: ${root}`,
    };
  } catch (err) {
    return {
      ok: false,
      resolvedPath: resolved,
      defaultBranch: null,
      branches: [],
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/* ------------------------------------------------------------------ *
 * Mutations
 * ------------------------------------------------------------------ */

export async function createProject(input: CreateProjectInput): Promise<ProjectView> {
  const parsed = createProjectSchema.parse(input);
  const probe = await probeRepository(parsed.repositoryPath);
  if (!probe.ok || !probe.resolvedPath) {
    throw invalid(probe.message);
  }

  const db = getDb();
  const existing = db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.repositoryPath, probe.resolvedPath))
    .get();
  if (existing) {
    throw conflict('A project is already registered for that repository path.');
  }

  const id = newProjectId();
  const defaultBranch = parsed.defaultBranch?.trim() || probe.defaultBranch || 'main';

  // The default branch is always protected, whatever the user listed.
  const protectedBranches = new Set([
    ...(parsed.protectedBranches ?? ['main', 'master']),
    defaultBranch,
  ]);

  db.insert(projects)
    .values({
      id,
      name: parsed.name,
      repositoryPath: probe.resolvedPath,
      defaultBranch,
      developmentCommand: parsed.developmentCommand ?? null,
      setupCommand: parsed.setupCommand ?? null,
      openCommand: parsed.openCommand ?? null,
      linkPaths: toLines(parsed.linkPaths) ?? null,
      protectedBranches: [...protectedBranches].join('\n'),
      requireValidation: parsed.requireValidation ?? true,
      requireE2eForUiChanges: parsed.requireE2eForUiChanges ?? false,
      uiPathPatterns: toLines(parsed.uiPathPatterns) ?? null,
      captureScreenshots: parsed.captureScreenshots ?? true,
      allowAgentCommit: parsed.allowAgentCommit ?? false,
      reviewBlocksReady: parsed.reviewBlocksReady ?? false,
      cleanUpWorktreeOnFinish: parsed.cleanUpWorktreeOnFinish ?? true,
      artifactRetentionDays: parsed.artifactRetentionDays ?? 30,
      agentModel: parsed.agentModel ?? null,
      agentPermissionMode: parsed.agentPermissionMode ?? DEFAULT_AGENT_PERMISSION_MODE,
      agentAddDirs: toLines(parsed.agentAddDirs) ?? null,
    })
    .run();

  for (const command of parsed.validationCommands ?? []) {
    upsertValidationCommand(id, command);
  }

  return requireProject(id);
}

export function updateProject(id: string, input: UpdateProjectInput): ProjectView {
  const parsed = updateProjectSchema.parse(input);
  const existing = requireProject(id);
  const db = getDb();

  const defaultBranch = parsed.defaultBranch?.trim() || existing.defaultBranch;
  const protectedList =
    parsed.protectedBranches === undefined
      ? existing.protectedBranches
      : parsed.protectedBranches;
  const protectedBranches = new Set([...protectedList, defaultBranch]);

  db.update(projects)
    .set({
      name: parsed.name ?? existing.name,
      defaultBranch,
      developmentCommand:
        parsed.developmentCommand === undefined
          ? existing.developmentCommand
          : parsed.developmentCommand,
      setupCommand:
        parsed.setupCommand === undefined ? existing.setupCommand : parsed.setupCommand,
      openCommand: parsed.openCommand === undefined ? existing.openCommand : parsed.openCommand,
      linkPaths: toLines(parsed.linkPaths) ?? existing.linkPaths.join('\n'),
      protectedBranches: [...protectedBranches].join('\n'),
      requireValidation: parsed.requireValidation ?? existing.requireValidation,
      requireE2eForUiChanges: parsed.requireE2eForUiChanges ?? existing.requireE2eForUiChanges,
      uiPathPatterns: toLines(parsed.uiPathPatterns) ?? existing.uiPathPatterns.join('\n'),
      captureScreenshots: parsed.captureScreenshots ?? existing.captureScreenshots,
      allowAgentCommit: parsed.allowAgentCommit ?? existing.allowAgentCommit,
      reviewBlocksReady: parsed.reviewBlocksReady ?? existing.reviewBlocksReady,
      cleanUpWorktreeOnFinish:
        parsed.cleanUpWorktreeOnFinish ?? existing.cleanUpWorktreeOnFinish,
      artifactRetentionDays: parsed.artifactRetentionDays ?? existing.artifactRetentionDays,
      agentModel: parsed.agentModel === undefined ? existing.agentModel : parsed.agentModel,
      agentPermissionMode: parsed.agentPermissionMode ?? existing.agentPermissionMode,
      agentAddDirs: toLines(parsed.agentAddDirs) ?? existing.agentAddDirs.join('\n'),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(projects.id, id))
    .run();

  if (parsed.validationCommands) {
    for (const command of parsed.validationCommands) {
      upsertValidationCommand(id, command);
    }
  }

  return requireProject(id);
}

/**
 * Sets or clears one validation command. An empty command string removes the
 * row, which is how a kind returns to "not configured" rather than "failed".
 */
export function upsertValidationCommand(
  projectId: string,
  input: z.infer<typeof validationCommandInputSchema>,
): void {
  const parsed = validationCommandInputSchema.parse(input);
  const db = getDb();
  const command = parsed.command.trim();

  if (!command) {
    db.delete(validationCommands)
      .where(
        and(
          eq(validationCommands.projectId, projectId),
          eq(validationCommands.kind, parsed.kind),
        ),
      )
      .run();
    return;
  }

  const existing = db
    .select()
    .from(validationCommands)
    .where(
      and(eq(validationCommands.projectId, projectId), eq(validationCommands.kind, parsed.kind)),
    )
    .get();

  const values = {
    command,
    workingDir: parsed.workingDir?.trim() || null,
    timeoutMs: parsed.timeoutMs ?? existing?.timeoutMs ?? 900_000,
    enabled: parsed.enabled ?? existing?.enabled ?? true,
    blocking: parsed.blocking ?? existing?.blocking ?? true,
    profiles: toLines(parsed.profiles) ?? existing?.profiles ?? 'quick\nstandard\ndeep',
    updatedAt: new Date().toISOString(),
  };

  if (existing) {
    db.update(validationCommands).set(values).where(eq(validationCommands.id, existing.id)).run();
    return;
  }

  db.insert(validationCommands)
    .values({ projectId, kind: parsed.kind, ...values })
    .run();
}

/** Hides a project from the list without touching its runs or worktrees. */
export function archiveProject(id: string): void {
  const db = getDb();
  db.update(projects)
    .set({ archivedAt: new Date().toISOString() })
    .where(eq(projects.id, id))
    .run();
}

/**
 * Deletes a project and everything attached to it. Worktrees are removed by
 * the caller first: this only touches the database.
 */
export function deleteProject(id: string): void {
  const db = getDb();
  const result = db.delete(projects).where(eq(projects.id, id)).run();
  if (result.changes === 0) throw notFound(`Project ${id}`);
}

export function recentRunSummaries(projectId: string, limit = 10) {
  const db = getDb();
  return db
    .select({
      id: runs.id,
      title: runs.title,
      status: runs.status,
      createdAt: runs.createdAt,
      finishedAt: runs.finishedAt,
      branch: runs.branch,
    })
    .from(runs)
    .where(eq(runs.projectId, projectId))
    .orderBy(desc(runs.createdAt))
    .limit(limit)
    .all();
}

/** Guards a project's protected-branch policy at run creation time. */
export function assertBranchAllowed(project: ProjectView, branch: string): void {
  if (project.protectedBranches.includes(branch)) {
    throw new AppError(
      `${branch} is a protected branch for this project. Runs always work on their own branch.`,
      { code: 'protected' },
    );
  }
}

/* ------------------------------------------------------------------ *
 * Live repository state
 * ------------------------------------------------------------------ */

export interface RepositoryState {
  /** The branch currently checked out in the user's own working tree. */
  currentBranch: string | null;
  /** What a run would branch from unless the base ref is overridden. */
  defaultBranch: string;
  /** True when those differ, so the run would not start from current work. */
  divergent: boolean;
  /** How far the checked-out branch is ahead of the default branch. */
  ahead: number | null;
  behind: number | null;
  dirty: boolean;
  error: string | null;
}

/**
 * Reads the repository as it stands right now.
 *
 * The New Task screen needs this to warn before a run starts, rather than
 * after: a project whose default branch is `main` while the developer works on
 * a feature branch will otherwise produce runs built on stale code, and nothing
 * about the resulting diff makes that obvious.
 */
export async function repositoryState(project: ProjectView): Promise<RepositoryState> {
  const base: RepositoryState = {
    currentBranch: null,
    defaultBranch: project.defaultBranch,
    divergent: false,
    ahead: null,
    behind: null,
    dirty: false,
    error: null,
  };

  try {
    const [current, dirty] = await Promise.all([
      currentBranch(project.repositoryPath),
      isDirty(project.repositoryPath).catch(() => false),
    ]);

    // A detached HEAD reports as "HEAD"; treat it as unknown rather than a name.
    const branch = current === 'HEAD' ? null : current;
    const divergent = branch !== null && branch !== project.defaultBranch;

    let ahead: number | null = null;
    let behind: number | null = null;
    if (divergent && branch) {
      const counts = await aheadBehind(project.repositoryPath, project.defaultBranch, branch);
      ahead = counts?.ahead ?? null;
      behind = counts?.behind ?? null;
    }

    return { ...base, currentBranch: branch, divergent, ahead, behind, dirty };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}
