import 'server-only';

import { asc, desc, eq, isNull } from 'drizzle-orm';
import path from 'node:path';
import { z } from 'zod';

import { getDb } from '@/db/client';
import { projects, runs, validationSteps } from '@/db/schema';
import { newProjectId } from '@/core/ids';
import { AppError, conflict, invalid, notFound } from '@/core/errors';
import {
  agentPermissionModeSchema,
  aiConfigModeSchema,
  DEFAULT_AGENT_PERMISSION_MODE,
  DEFAULT_PREVIEW_READY_PATH,
  DEFAULT_PREVIEW_READY_TIMEOUT_MS,
  MAX_RETRIES,
  POSITION_STRIDE,
  previewPortStrategySchema,
  retryOnModeSchema,
  runWhenConditionSchema,
  VALIDATION_KIND_LABELS,
  VALIDATION_KINDS,
  validationKindSchema,
  type AiConfigMode,
  type PreviewPortStrategy,
  type RetryOnMode,
  type RunWhenCondition,
  type ValidationKind,
} from '@/domain/types';
import {
  nextPosition,
  orderSteps,
  slugifyStepKey,
  STEP_KEY_PATTERN,
  uniqueStepKey,
} from '@/domain/validation-steps';
import {
  DEFAULT_ARTIFACT_RETENTION_DAYS,
  DEFAULT_WORKTREE_RETENTION_DAYS,
  type RetentionPolicy,
} from '@/domain/expiry';
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
import type { ProjectRow, ValidationStepRow } from '@/db/schema';

/* ------------------------------------------------------------------ *
 * Input schemas
 * ------------------------------------------------------------------ */

/**
 * One step of a project's validation pipeline.
 *
 * `key` is optional on the way in and derived from the label when absent, so a
 * caller adding a step does not have to invent a slug. It is not optional in
 * storage: it is the identity a result row is written against.
 */
export const validationStepInputSchema = z.object({
  key: z.string().trim().regex(STEP_KEY_PATTERN).optional(),
  label: z.string().trim().min(1).max(80),
  kind: validationKindSchema.nullable().optional(),
  command: z.string().trim().max(2_000),
  workingDir: z.string().trim().max(500).nullable().optional(),
  env: z.array(z.string().max(2_000)).max(50).optional(),
  timeoutMs: z.number().int().min(1_000).max(7_200_000).optional(),
  enabled: z.boolean().optional(),
  blocking: z.boolean().optional(),
  profiles: z.array(z.string()).optional(),
  position: z.number().int().min(0).max(100_000).optional(),
  runWhen: runWhenConditionSchema.optional(),
  runWhenArg: z.string().trim().max(2_000).nullable().optional(),
  retries: z.number().int().min(0).max(MAX_RETRIES).optional(),
  retryOn: retryOnModeSchema.optional(),
});

export type ValidationStepInput = z.infer<typeof validationStepInputSchema>;

/**
 * The pre-pipeline shape: one command per kind.
 *
 * Accepted on the way in and converted, because it is how every caller wrote a
 * project before steps existed and there is no reason to break them. Nothing
 * reads it back — `ProjectView` reports steps.
 */
export const validationCommandInputSchema = z.object({
  kind: z.enum(VALIDATION_KINDS),
  command: z.string().trim().max(2_000),
  workingDir: z.string().trim().max(500).nullable().optional(),
  timeoutMs: z.number().int().min(1_000).max(7_200_000).optional(),
  enabled: z.boolean().optional(),
  blocking: z.boolean().optional(),
  profiles: z.array(z.string()).optional(),
});

/** Everything about how this project's preview is started and watched. */
export const previewConfigInputSchema = z.object({
  workingDir: z.string().trim().max(500).nullable().optional(),
  env: z.array(z.string().max(2_000)).max(50).optional(),
  portStrategy: previewPortStrategySchema.optional(),
  fixedPort: z.number().int().min(1).max(65_535).nullable().optional(),
  readyPath: z.string().trim().max(500).optional(),
  readyTimeoutMs: z.number().int().min(1_000).max(1_800_000).optional(),
  autoStart: z.boolean().optional(),
});

/**
 * A retention window in days. Zero is meaningful — it turns that window off —
 * so the floor is zero rather than one, and ten years is the ceiling.
 */
const retentionDaysSchema = z.number().int().min(0).max(3_650);

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
  /** Retention windows, in days. Zero keeps that target forever. */
  artifactRetentionDays: retentionDaysSchema.optional(),
  worktreeRetentionDays: retentionDaysSchema.optional(),
  agentModel: z.string().trim().max(120).nullable().optional(),
  agentPermissionMode: agentPermissionModeSchema.optional(),
  agentAddDirs: z.array(z.string()).optional(),
  aiConfigMode: aiConfigModeSchema.optional(),
  aiConfigProvider: z.string().trim().max(60).nullable().optional(),
  preview: previewConfigInputSchema.optional(),
  validationSteps: z.array(validationStepInputSchema).max(100).optional(),
  /** Legacy shape, converted to steps. See `validationCommandInputSchema`. */
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

export interface ValidationStepView {
  id: number;
  /** Slug, unique per project. What a result row is keyed by. */
  key: string;
  label: string;
  /** A tag, not an identity. Null for a step that fits none of the six kinds. */
  kind: ValidationKind | null;
  command: string;
  workingDir: string | null;
  /** Raw `KEY=VALUE` lines; parse with `parseEnvLines`. */
  env: string[];
  timeoutMs: number;
  enabled: boolean;
  blocking: boolean;
  profiles: string[];
  position: number;
  runWhen: RunWhenCondition;
  runWhenArg: string | null;
  retries: number;
  retryOn: RetryOnMode;
}

export interface PreviewConfigView {
  /** The same value as `ProjectView.developmentCommand`; this is the command. */
  command: string | null;
  workingDir: string | null;
  env: string[];
  portStrategy: PreviewPortStrategy;
  fixedPort: number | null;
  readyPath: string;
  readyTimeoutMs: number;
  autoStart: boolean;
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
  /** See `domain/expiry`. Zero on either means that target never expires. */
  artifactRetentionDays: number;
  worktreeRetentionDays: number;
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
  /** How much authority the setup advisor has here. See `AI_CONFIG_MODES`. */
  aiConfigMode: AiConfigMode;
  aiConfigProvider: string | null;
  createdAt: string;
  updatedAt: string;
  /** The pipeline, already in execution order. */
  validationSteps: ValidationStepView[];
  preview: PreviewConfigView;
}

function toStepView(row: ValidationStepRow): ValidationStepView {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    kind: (row.kind as ValidationKind | null) ?? null,
    command: row.command,
    workingDir: row.workingDir,
    env: fromLines(row.env),
    timeoutMs: row.timeoutMs,
    enabled: row.enabled,
    blocking: row.blocking,
    profiles: fromLines(row.profiles),
    position: row.position,
    runWhen: row.runWhen as RunWhenCondition,
    runWhenArg: row.runWhenArg,
    retries: row.retries,
    retryOn: row.retryOn as RetryOnMode,
  };
}

function toPreviewView(row: ProjectRow): PreviewConfigView {
  return {
    command: row.developmentCommand,
    workingDir: row.previewWorkingDir,
    env: fromLines(row.previewEnv),
    portStrategy: (row.previewPortStrategy as PreviewPortStrategy) ?? 'auto',
    fixedPort: row.previewFixedPort,
    readyPath: row.previewReadyPath || DEFAULT_PREVIEW_READY_PATH,
    readyTimeoutMs: row.previewReadyTimeoutMs || DEFAULT_PREVIEW_READY_TIMEOUT_MS,
    autoStart: row.previewAutoStart,
  };
}

function toProjectView(row: ProjectRow, steps: ValidationStepRow[]): ProjectView {
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
    worktreeRetentionDays: row.worktreeRetentionDays,
    agentModel: row.agentModel,
    agentPermissionMode: row.agentPermissionMode,
    effectivePermissionMode: resolvePermissionMode(row.agentPermissionMode),
    agentAddDirs: fromLines(row.agentAddDirs),
    aiConfigMode: (row.aiConfigMode as AiConfigMode) ?? 'draft',
    aiConfigProvider: row.aiConfigProvider,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    validationSteps: orderSteps(steps.map(toStepView)),
    preview: toPreviewView(row),
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

  const steps = db.select().from(validationSteps).all();
  return rows.map((row) =>
    toProjectView(
      row,
      steps.filter((step) => step.projectId === row.id),
    ),
  );
}

export function getProject(id: string): ProjectView | null {
  const db = getDb();
  const row = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!row) return null;
  const steps = db
    .select()
    .from(validationSteps)
    .where(eq(validationSteps.projectId, id))
    .all();
  return toProjectView(row, steps);
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
      artifactRetentionDays: parsed.artifactRetentionDays ?? DEFAULT_ARTIFACT_RETENTION_DAYS,
      worktreeRetentionDays: parsed.worktreeRetentionDays ?? DEFAULT_WORKTREE_RETENTION_DAYS,
      agentModel: parsed.agentModel ?? null,
      agentPermissionMode: parsed.agentPermissionMode ?? DEFAULT_AGENT_PERMISSION_MODE,
      agentAddDirs: toLines(parsed.agentAddDirs) ?? null,
      aiConfigMode: parsed.aiConfigMode ?? 'draft',
      aiConfigProvider: parsed.aiConfigProvider ?? null,
      ...previewColumns(parsed.preview),
    })
    .run();

  const steps = stepsFromInput(parsed);
  if (steps.length > 0) replaceValidationSteps(id, steps);

  return requireProject(id);
}

/**
 * Maps the preview half of a project input onto columns.
 *
 * Undefined means "not mentioned", which must leave the stored value alone —
 * so this returns a partial and the caller spreads it.
 */
function previewColumns(
  preview: z.infer<typeof previewConfigInputSchema> | undefined,
): Record<string, unknown> {
  if (!preview) return {};
  const out: Record<string, unknown> = {};
  if (preview.workingDir !== undefined) out.previewWorkingDir = preview.workingDir?.trim() || null;
  if (preview.env !== undefined) out.previewEnv = toLines(preview.env) ?? null;
  if (preview.portStrategy !== undefined) out.previewPortStrategy = preview.portStrategy;
  if (preview.fixedPort !== undefined) out.previewFixedPort = preview.fixedPort ?? null;
  if (preview.readyPath !== undefined) {
    out.previewReadyPath = normaliseReadyPath(preview.readyPath);
  }
  if (preview.readyTimeoutMs !== undefined) out.previewReadyTimeoutMs = preview.readyTimeoutMs;
  if (preview.autoStart !== undefined) out.previewAutoStart = preview.autoStart;
  return out;
}

/**
 * A ready path is appended to a URL, so it has to start with a slash and must
 * not carry an origin of its own — otherwise a probe could be pointed at any
 * host on the network by editing a project field.
 */
function normaliseReadyPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_PREVIEW_READY_PATH;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) {
    throw invalid('The preview ready path must be a path, not a URL.');
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * Collects steps from either input shape.
 *
 * The legacy per-kind commands are converted here rather than at the edge, so
 * every caller — the API, the advisor, a test helper — goes through one
 * conversion and cannot disagree about the order they land in.
 */
function stepsFromInput(parsed: {
  validationSteps?: ValidationStepInput[];
  validationCommands?: z.infer<typeof validationCommandInputSchema>[];
}): ValidationStepInput[] {
  if (parsed.validationSteps) return parsed.validationSteps;
  if (!parsed.validationCommands) return [];
  return parsed.validationCommands
    .slice()
    .sort((a, b) => VALIDATION_KINDS.indexOf(a.kind) - VALIDATION_KINDS.indexOf(b.kind))
    .map((command, index) => ({
      key: command.kind,
      label: VALIDATION_KIND_LABELS[command.kind],
      kind: command.kind,
      command: command.command,
      workingDir: command.workingDir ?? null,
      timeoutMs: command.timeoutMs,
      enabled: command.enabled,
      blocking: command.blocking,
      profiles: command.profiles,
      position: index * POSITION_STRIDE,
    }));
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
      worktreeRetentionDays: parsed.worktreeRetentionDays ?? existing.worktreeRetentionDays,
      agentModel: parsed.agentModel === undefined ? existing.agentModel : parsed.agentModel,
      agentPermissionMode: parsed.agentPermissionMode ?? existing.agentPermissionMode,
      agentAddDirs: toLines(parsed.agentAddDirs) ?? existing.agentAddDirs.join('\n'),
      aiConfigMode: parsed.aiConfigMode ?? existing.aiConfigMode,
      aiConfigProvider:
        parsed.aiConfigProvider === undefined
          ? existing.aiConfigProvider
          : parsed.aiConfigProvider,
      ...previewColumns(parsed.preview),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(projects.id, id))
    .run();

  if (parsed.validationSteps || parsed.validationCommands) {
    replaceValidationSteps(id, stepsFromInput(parsed));
  }

  return requireProject(id);
}

/**
 * Replaces a project's whole pipeline in one transaction.
 *
 * Whole-list rather than per-step upsert, because order is now part of the
 * configuration: a partial write would leave two steps claiming one position
 * and no way to say which the user meant. The form sends what it has and this
 * makes the stored pipeline match it.
 *
 * A step with a blank command is dropped rather than stored, which is how a
 * check returns to "not configured" — the same convention the per-kind upsert
 * used, and for the same reason: not configured is not failed.
 */
export function replaceValidationSteps(
  projectId: string,
  input: readonly ValidationStepInput[],
): void {
  const db = getDb();
  const parsed = input.map((step) => validationStepInputSchema.parse(step));

  const taken = new Set<string>();
  const rows: {
    key: string;
    label: string;
    kind: ValidationKind | null;
    command: string;
    workingDir: string | null;
    env: string | null;
    timeoutMs: number;
    enabled: boolean;
    blocking: boolean;
    profiles: string;
    position: number;
    runWhen: RunWhenCondition;
    runWhenArg: string | null;
    retries: number;
    retryOn: RetryOnMode;
  }[] = [];

  parsed.forEach((step, index) => {
    const command = step.command.trim();
    if (!command) return;

    const key = uniqueStepKey(step.key ?? slugifyStepKey(step.label), taken);
    taken.add(key);

    rows.push({
      key,
      label: step.label.trim() || key,
      kind: step.kind ?? null,
      command,
      workingDir: step.workingDir?.trim() || null,
      env: toLines(step.env) ?? null,
      timeoutMs: step.timeoutMs ?? 900_000,
      enabled: step.enabled ?? true,
      blocking: step.blocking ?? true,
      profiles: toLines(step.profiles) ?? 'quick\nstandard\ndeep',
      position: step.position ?? index * POSITION_STRIDE,
      runWhen: step.runWhen ?? 'always',
      runWhenArg: step.runWhenArg?.trim() || null,
      retries: step.retries ?? 0,
      retryOn: step.retryOn ?? 'error',
    });
  });

  // A `depends_on` pointing at a step that is not in the list would skip
  // forever. Refusing here beats discovering it mid-run.
  const keys = new Set(rows.map((row) => row.key));
  for (const row of rows) {
    if (row.runWhen !== 'depends_on') continue;
    const dependency = row.runWhenArg ?? '';
    if (!keys.has(dependency)) {
      throw invalid(`Step ${row.key} depends on ${dependency || '(nothing)'}, which is not a step.`);
    }
    if (dependency === row.key) {
      throw invalid(`Step ${row.key} cannot depend on itself.`);
    }
  }
  assertNoDependencyCycle(rows);

  const now = new Date().toISOString();
  db.transaction((tx) => {
    tx.delete(validationSteps).where(eq(validationSteps.projectId, projectId)).run();
    for (const row of rows) {
      tx.insert(validationSteps)
        .values({ projectId, ...row, createdAt: now, updatedAt: now })
        .run();
    }
  });
}

/**
 * Refuses a pipeline whose dependencies form a loop.
 *
 * Without this the engine would skip every step in the cycle and report a
 * pipeline that ran nothing as though nothing were configured, which is the
 * one reading the scorecard is built to prevent.
 */
function assertNoDependencyCycle(
  rows: readonly { key: string; runWhen: RunWhenCondition; runWhenArg: string | null }[],
): void {
  const edges = new Map<string, string>();
  for (const row of rows) {
    if (row.runWhen === 'depends_on' && row.runWhenArg) edges.set(row.key, row.runWhenArg);
  }

  for (const start of edges.keys()) {
    const seen = new Set<string>([start]);
    let current = edges.get(start);
    while (current !== undefined) {
      if (seen.has(current)) {
        throw invalid(`Validation steps form a dependency cycle through ${current}.`);
      }
      seen.add(current);
      current = edges.get(current);
    }
  }
}

/**
 * Adds or replaces one step, leaving the rest of the pipeline alone.
 *
 * The narrow path, for callers that hold one step rather than a list — the
 * probe's revision pass is the one that matters.
 */
export function upsertValidationStep(projectId: string, input: ValidationStepInput): void {
  const existing = requireProject(projectId).validationSteps;
  const step = validationStepInputSchema.parse(input);
  const key = step.key ?? slugifyStepKey(step.label);

  const next = existing.map(toStepInput);
  const at = next.findIndex((candidate) => candidate.key === key);
  if (at >= 0) {
    next[at] = { ...next[at], ...step, key };
  } else {
    next.push({ ...step, key, position: step.position ?? nextPosition(existing) });
  }
  replaceValidationSteps(projectId, next);
}

/** Round-trips a stored step back into the input shape. */
export function toStepInput(step: ValidationStepView): ValidationStepInput {
  return {
    key: step.key,
    label: step.label,
    kind: step.kind,
    command: step.command,
    workingDir: step.workingDir,
    env: step.env,
    timeoutMs: step.timeoutMs,
    enabled: step.enabled,
    blocking: step.blocking,
    profiles: step.profiles,
    position: step.position,
    runWhen: step.runWhen,
    runWhenArg: step.runWhenArg,
    retries: step.retries,
    retryOn: step.retryOn,
  };
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

/**
 * The project's retention windows, in the shape `domain/expiry` reads.
 *
 * `ProjectView` already satisfies `RetentionPolicy` structurally; this exists
 * so a caller passing retention somewhere states that it is retention it is
 * passing, rather than handing over a whole project.
 */
export function retentionPolicy(project: ProjectView): RetentionPolicy {
  return {
    worktreeRetentionDays: project.worktreeRetentionDays,
    artifactRetentionDays: project.artifactRetentionDays,
  };
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
