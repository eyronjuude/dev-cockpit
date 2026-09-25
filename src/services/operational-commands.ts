import 'server-only';

import fs from 'node:fs';
import path from 'node:path';
import { asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { newOperationalCommandId, newOperationalCommandRunId } from '@/core/ids';
import { invalid, notFound } from '@/core/errors';
import { isInside } from '@/core/paths';
import { registerExtraSecrets } from '@/core/redact';
import { getDb } from '@/db/client';
import { operationalCommands, operationalCommandRuns } from '@/db/schema';
import type { OperationalCommandRow, OperationalCommandRunRow } from '@/db/schema';
import {
  commandTargetSchema,
  type CommandTarget,
  type OperationalRunOutcome,
} from '@/domain/types';
import { interpolateRunTokens } from '@/domain/env-tokens';
import { parseEnvLines, secretValuesIn } from '@/domain/validation-steps';
import { assertTargetCheckoutReady } from '@/git/landing';
import { runCommand } from '@/process/spawn';
import { requireProject } from './projects';
import { requireRun } from './runs';

/**
 * A command a person runs deliberately against a real target.
 *
 * Distinct from a validation step: nothing in this file is ever invoked by
 * the orchestrator, a run's pipeline, or an agent. The only caller is
 * `runOperationalCommand`, and the only thing that calls that is an explicit
 * API request — see the module doc on that function for what "permission"
 * means in an app with no user accounts.
 */

export const operationalCommandInputSchema = z.object({
  label: z.string().trim().min(1).max(80),
  command: z.string().trim().min(1).max(2_000),
  workingDir: z.string().trim().max(500).nullable().optional(),
  target: commandTargetSchema.optional(),
  /** Extra environment for this command, merged over the project's own. */
  env: z.array(z.string().max(2_000)).max(50).optional(),
  timeoutMs: z.number().int().min(1_000).max(7_200_000).optional(),
});

export type OperationalCommandInput = z.infer<typeof operationalCommandInputSchema>;

export interface OperationalCommandView {
  id: string;
  projectId: string;
  label: string;
  command: string;
  workingDir: string | null;
  target: CommandTarget;
  /** Raw `KEY=VALUE` lines; parse with `parseEnvLines`. */
  env: string[];
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface OperationalCommandRunView {
  id: string;
  operationalCommandId: string;
  projectId: string;
  /** Set only for a `non_production` execution: whose worktree it used. */
  runId: string | null;
  label: string;
  command: string;
  target: CommandTarget;
  cwd: string;
  outcome: OperationalRunOutcome;
  exitCode: number | null;
  durationMs: number | null;
  stdout: string | null;
  stderr: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

const toLines = (values: readonly string[] | undefined): string | undefined =>
  values === undefined ? undefined : values.map((v) => v.trim()).filter(Boolean).join('\n');

const fromLines = (value: string | null | undefined): string[] =>
  (value ?? '')
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);

function toView(row: OperationalCommandRow): OperationalCommandView {
  return {
    id: row.id,
    projectId: row.projectId,
    label: row.label,
    command: row.command,
    workingDir: row.workingDir,
    target: row.target as CommandTarget,
    env: fromLines(row.env),
    timeoutMs: row.timeoutMs,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRunView(row: OperationalCommandRunRow): OperationalCommandRunView {
  return {
    id: row.id,
    operationalCommandId: row.operationalCommandId,
    projectId: row.projectId,
    runId: row.runId,
    label: row.label,
    command: row.command,
    target: row.target as CommandTarget,
    cwd: row.cwd,
    outcome: row.outcome as OperationalRunOutcome,
    exitCode: row.exitCode,
    durationMs: row.durationMs,
    stdout: row.stdout,
    stderr: row.stderr,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  };
}

export function listOperationalCommands(projectId: string): OperationalCommandView[] {
  const db = getDb();
  return db
    .select()
    .from(operationalCommands)
    .where(eq(operationalCommands.projectId, projectId))
    .orderBy(asc(operationalCommands.label))
    .all()
    .map(toView);
}

export function requireOperationalCommand(id: string): OperationalCommandView {
  const db = getDb();
  const row = db.select().from(operationalCommands).where(eq(operationalCommands.id, id)).get();
  if (!row) throw notFound(`Operational command ${id}`);
  return toView(row);
}

export function createOperationalCommand(
  projectId: string,
  input: OperationalCommandInput,
): OperationalCommandView {
  requireProject(projectId);
  const parsed = operationalCommandInputSchema.parse(input);
  const db = getDb();
  const id = newOperationalCommandId();
  const now = new Date().toISOString();
  db.insert(operationalCommands)
    .values({
      id,
      projectId,
      label: parsed.label,
      command: parsed.command,
      workingDir: parsed.workingDir?.trim() || null,
      target: parsed.target ?? 'non_production',
      env: toLines(parsed.env) ?? null,
      timeoutMs: parsed.timeoutMs ?? 900_000,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return requireOperationalCommand(id);
}

export function updateOperationalCommand(
  id: string,
  input: Partial<OperationalCommandInput>,
): OperationalCommandView {
  const existing = requireOperationalCommand(id);
  const parsed = operationalCommandInputSchema.partial().parse(input);
  const db = getDb();
  db.update(operationalCommands)
    .set({
      label: parsed.label ?? existing.label,
      command: parsed.command ?? existing.command,
      workingDir:
        parsed.workingDir === undefined ? existing.workingDir : parsed.workingDir?.trim() || null,
      target: parsed.target ?? existing.target,
      env: toLines(parsed.env) ?? existing.env.join('\n'),
      timeoutMs: parsed.timeoutMs ?? existing.timeoutMs,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(operationalCommands.id, id))
    .run();
  return requireOperationalCommand(id);
}

export function deleteOperationalCommand(id: string): void {
  const db = getDb();
  const result = db.delete(operationalCommands).where(eq(operationalCommands.id, id)).run();
  if (result.changes === 0) throw notFound(`Operational command ${id}`);
}

export function listOperationalCommandRuns(
  operationalCommandId: string,
  limit = 20,
): OperationalCommandRunView[] {
  const db = getDb();
  return db
    .select()
    .from(operationalCommandRuns)
    .where(eq(operationalCommandRuns.operationalCommandId, operationalCommandId))
    .orderBy(desc(operationalCommandRuns.createdAt))
    .limit(limit)
    .all()
    .map(toRunView);
}

export function requireOperationalCommandRun(id: string): OperationalCommandRunView {
  const db = getDb();
  const row = db
    .select()
    .from(operationalCommandRuns)
    .where(eq(operationalCommandRuns.id, id))
    .get();
  if (!row) throw notFound(`Operational command run ${id}`);
  return toRunView(row);
}

/**
 * Executes one operational command.
 *
 * There is no automatic trigger anywhere in the app for this — no run
 * lifecycle, no agent, no schedule calls it. The only caller is the API route
 * behind an explicit "run" button, and `options.confirmed` has to be true on
 * every call: this is the one hard gate enforced here rather than trusted to
 * the UI, so a client cannot fire the request without having shown *some*
 * confirmation step first. The UI is expected to make a `production` target
 * harder to confirm than a `non_production` one (e.g. typing the project
 * name), but that extra friction is a UI concern; this function's own
 * required gate is the same for both.
 *
 * `production` runs directly in the project's own checkout
 * (`repositoryPath`), on its default branch — there is no separate worktree
 * for "production" in an app with no remote or deploy step, so the main
 * checkout is the only thing it can mean. It is refused unless that checkout
 * is on the default branch and clean: the same preflight the landing flow
 * already performs before touching that branch (`assertTargetCheckoutReady`).
 *
 * `non_production` runs inside a specific run's own worktree, which is why it
 * needs a `runId` — there is nowhere else for it to run.
 */
export async function runOperationalCommand(
  commandId: string,
  options: { runId?: string; confirmed: boolean },
): Promise<OperationalCommandRunView> {
  if (!options.confirmed) {
    throw invalid('This command requires explicit confirmation to run.');
  }

  const command = requireOperationalCommand(commandId);
  const project = requireProject(command.projectId);

  let root: string;
  let runId: string | null = null;

  if (command.target === 'production') {
    if (options.runId) {
      throw invalid('A production command runs against the main checkout, not a run.');
    }
    await assertTargetCheckoutReady(project.repositoryPath, project.defaultBranch);
    root = project.repositoryPath;
  } else {
    if (!options.runId) {
      throw invalid('A non-production command needs a run to borrow a worktree from.');
    }
    const run = requireRun(options.runId);
    if (run.projectId !== project.id) {
      throw invalid('That run does not belong to this project.');
    }
    if (!run.worktreePath) {
      throw invalid(`Run ${run.id} has no worktree to run this command in.`);
    }
    root = run.worktreePath;
    runId = run.id;
  }

  const cwd = command.workingDir ? path.resolve(root, command.workingDir) : root;
  if (cwd !== root && !isInside(root, cwd)) {
    throw invalid('The working directory escapes the target checkout.');
  }
  if (!fs.existsSync(cwd)) {
    throw invalid(`Working directory does not exist: ${cwd}`);
  }

  // Neither field ever reaches `process.env`, so the redactor's environment
  // scan cannot see either — registered here for the same reason a
  // validation step's env is registered in the validation engine.
  const configured = {
    ...parseEnvLines(project.env.join('\n')),
    ...parseEnvLines(command.env.join('\n')),
  };
  // Tokens name a run, and production has none. Left unresolved there, a
  // `{runId}` in a database URL fails as an unknown database rather than
  // quietly pointing somewhere plausible.
  const env = runId ? interpolateRunTokens(configured, { runId, worktree: 'run' }) : configured;
  registerExtraSecrets(secretValuesIn(env));

  const db = getDb();
  const rowId = newOperationalCommandRunId();
  const startedAt = new Date().toISOString();
  db.insert(operationalCommandRuns)
    .values({
      id: rowId,
      operationalCommandId: command.id,
      projectId: project.id,
      runId,
      label: command.label,
      command: command.command,
      target: command.target,
      cwd,
      outcome: 'running',
      startedAt,
      createdAt: startedAt,
    })
    .run();

  const result = await runCommand({
    command: command.command,
    cwd,
    env,
    timeoutMs: command.timeoutMs,
  });

  const outcome: OperationalRunOutcome = result.aborted
    ? 'cancelled'
    : result.spawnError || result.timedOut
      ? 'error'
      : result.exitCode === 0
        ? 'pass'
        : 'fail';

  db.update(operationalCommandRuns)
    .set({
      outcome,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.spawnError,
      finishedAt: result.finishedAt,
    })
    .where(eq(operationalCommandRuns.id, rowId))
    .run();

  return requireOperationalCommandRun(rowId);
}
