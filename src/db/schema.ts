import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Timestamps are ISO-8601 strings in UTC. SQLite has no date type and storing
 * text keeps the database readable with any sqlite client, which matters for a
 * local-first app the user may want to inspect by hand.
 */
const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

/* ------------------------------------------------------------------ *
 * Projects
 * ------------------------------------------------------------------ */

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    repositoryPath: text('repository_path').notNull(),
    defaultBranch: text('default_branch').notNull().default('main'),

    /** How the user normally starts this project, e.g. `pnpm dev`. */
    developmentCommand: text('development_command'),
    /** Runs once in a fresh worktree, e.g. `pnpm install --prefer-offline`. */
    setupCommand: text('setup_command'),
    /** Command used by "Open worktree", e.g. `code {path}`. */
    openCommand: text('open_command'),

    /**
     * Paths copied or junctioned from the main checkout into each worktree,
     * newline-separated. `node_modules` and `.env.local` are the usual entries:
     * a fresh worktree has neither and most validation commands need both.
     */
    linkPaths: text('link_paths'),

    /** Branches a run may never target or commit onto, newline-separated. */
    protectedBranches: text('protected_branches').notNull().default('main\nmaster'),

    /* Policies */
    requireValidation: integer('require_validation', { mode: 'boolean' })
      .notNull()
      .default(true),
    requireE2eForUiChanges: integer('require_e2e_for_ui_changes', { mode: 'boolean' })
      .notNull()
      .default(false),
    /** Glob-ish fragments that mark a change as UI-affecting, newline-separated. */
    uiPathPatterns: text('ui_path_patterns'),
    captureScreenshots: integer('capture_screenshots', { mode: 'boolean' })
      .notNull()
      .default(true),
    allowAgentCommit: integer('allow_agent_commit', { mode: 'boolean' })
      .notNull()
      .default(false),
    reviewBlocksReady: integer('review_blocks_ready', { mode: 'boolean' })
      .notNull()
      .default(false),
    artifactRetentionDays: integer('artifact_retention_days').notNull().default(30),

    /** Agent configuration. */
    agentModel: text('agent_model'),
    agentPermissionMode: text('agent_permission_mode').notNull().default('acceptEdits'),
    /** Extra directories the agent may touch, newline-separated. */
    agentAddDirs: text('agent_add_dirs'),

    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
    archivedAt: text('archived_at'),
  },
  (t) => [uniqueIndex('projects_repository_path_idx').on(t.repositoryPath)],
);

/* ------------------------------------------------------------------ *
 * Validation commands
 * ------------------------------------------------------------------ */

export const validationCommands = sqliteTable(
  'validation_commands',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** One of `ValidationKind`. */
    kind: text('kind').notNull(),
    command: text('command').notNull(),
    /** Relative to the worktree root; null means the root itself. */
    workingDir: text('working_dir'),
    timeoutMs: integer('timeout_ms').notNull().default(900_000),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /**
     * A non-blocking command records pass/fail but never prevents READY.
     * Used for advisory checks such as a flaky E2E suite.
     */
    blocking: integer('blocking', { mode: 'boolean' }).notNull().default(true),
    /** Which execution profiles run this command, newline-separated. */
    profiles: text('profiles').notNull().default('quick\nstandard\ndeep'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('validation_commands_project_kind_idx').on(t.projectId, t.kind)],
);

/* ------------------------------------------------------------------ *
 * Runs
 * ------------------------------------------------------------------ */

export const runs = sqliteTable(
  'runs',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    /** Exactly what the user typed. Never rewritten. */
    request: text('request').notNull(),
    /** Transformer output, when a provider produced one. */
    spec: text('spec'),
    specProvider: text('spec_provider'),

    status: text('status').notNull().default('DRAFT'),
    statusReason: text('status_reason'),
    profile: text('profile').notNull().default('standard'),

    /**
     * Working mode as the user chose it: `plan`, `build` or `auto`. Kept
     * unchanged for the life of the run, so what was asked for stays readable
     * after a mode switch.
     */
    mode: text('mode').notNull().default('build'),
    /**
     * The mode the run is executing in — `plan` or `build`, never `auto`.
     * Written when the run is created and again if the mode is switched
     * mid-run. Null only on rows written before modes existed, which are read
     * as `build`.
     */
    resolvedMode: text('resolved_mode'),

    /* Git */
    baseBranch: text('base_branch'),
    baseCommit: text('base_commit'),
    branch: text('branch'),
    worktreePath: text('worktree_path'),
    /** Set when the user approves with "create a commit". Never pushed. */
    commitSha: text('commit_sha'),

    /* Agent */
    agentProvider: text('agent_provider').notNull().default('claude-code'),
    agentSessionId: text('agent_session_id'),
    agentModel: text('agent_model'),

    /**
     * Provider choices are stored per run, so changing a default in Settings
     * cannot retroactively change what an existing run reports having used.
     * `none` means the layer was deliberately skipped.
     */
    transformerProvider: text('transformer_provider').notNull().default('none'),
    reviewerProvider: text('reviewer_provider').notNull().default('none'),

    /* Outcome */
    disposition: text('disposition'),
    dispositionNote: text('disposition_note'),
    error: text('error'),

    /** Rolled-up cost across iterations, in USD, when the agent reports it. */
    costUsd: real('cost_usd'),

    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  (t) => [
    index('runs_project_idx').on(t.projectId),
    index('runs_status_idx').on(t.status),
    index('runs_created_idx').on(t.createdAt),
  ],
);

/* ------------------------------------------------------------------ *
 * Iterations
 * ------------------------------------------------------------------ */

export const iterations = sqliteTable(
  'iterations',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    /** 1-based, ordered. */
    ordinal: integer('ordinal').notNull(),
    kind: text('kind').notNull().default('initial'),
    /** The prompt actually handed to the agent for this iteration. */
    prompt: text('prompt').notNull(),
    status: text('status').notNull().default('running'),
    /** Session id in effect for this iteration; lets resume be auditable. */
    sessionId: text('session_id'),
    resumed: integer('resumed', { mode: 'boolean' }).notNull().default(false),
    exitCode: integer('exit_code'),
    numTurns: integer('num_turns'),
    costUsd: real('cost_usd'),
    /** The agent's own closing message, verbatim. Never rewritten. */
    finalText: text('final_text'),
    /**
     * A transformer's plain-language reading of `finalText`.
     *
     * Stored alongside the original rather than replacing it: the interpreted
     * version is a convenience, and losing the implementer's actual words would
     * make the run less auditable, not more.
     */
    summary: text('summary'),
    summaryProvider: text('summary_provider'),
    error: text('error'),
    startedAt: text('started_at').notNull().default(now),
    finishedAt: text('finished_at'),
  },
  (t) => [
    index('iterations_run_idx').on(t.runId),
    uniqueIndex('iterations_run_ordinal_idx').on(t.runId, t.ordinal),
  ],
);

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

export const events = sqliteTable(
  'events',
  {
    /** Monotonic per database. Doubles as the SSE resume cursor. */
    seq: integer('seq').primaryKey({ autoIncrement: true }),
    id: text('id').notNull(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    level: text('level').notNull().default('info'),
    message: text('message').notNull(),
    /** JSON. Typed per event via `EventPayloads`. */
    payload: text('payload').notNull().default('{}'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('events_run_seq_idx').on(t.runId, t.seq), index('events_type_idx').on(t.type)],
);

/* ------------------------------------------------------------------ *
 * Changed files
 * ------------------------------------------------------------------ */

export const changedFiles = sqliteTable(
  'changed_files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    changeType: text('change_type').notNull(),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    /** Set for renames. */
    previousPath: text('previous_path'),
    binary: integer('binary', { mode: 'boolean' }).notNull().default(false),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [uniqueIndex('changed_files_run_path_idx').on(t.runId, t.path)],
);

/* ------------------------------------------------------------------ *
 * Validation results
 * ------------------------------------------------------------------ */

export const validationResults = sqliteTable(
  'validation_results',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    /** Which validation pass this belongs to; increments on re-run. */
    attempt: integer('attempt').notNull().default(1),
    kind: text('kind').notNull(),
    /** `project` for a configured command. V1 never records `dynamic`. */
    commandSource: text('command_source').notNull().default('project'),
    command: text('command'),
    workingDir: text('working_dir'),
    outcome: text('outcome').notNull().default('running'),
    blocking: integer('blocking', { mode: 'boolean' }).notNull().default(true),
    exitCode: integer('exit_code'),
    durationMs: integer('duration_ms'),
    /** Truncated and redacted; the full stream lives in an artifact. */
    stdout: text('stdout'),
    stderr: text('stderr'),
    /** Set when the runner itself failed, e.g. the binary was missing. */
    error: text('error'),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    index('validation_results_run_idx').on(t.runId),
    uniqueIndex('validation_results_run_attempt_kind_idx').on(t.runId, t.attempt, t.kind),
  ],
);

/* ------------------------------------------------------------------ *
 * Artifacts
 * ------------------------------------------------------------------ */

export const artifacts = sqliteTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    label: text('label').notNull(),
    /** Absolute path on disk. Always inside the data directory. */
    filePath: text('file_path').notNull(),
    mimeType: text('mime_type').notNull().default('text/plain'),
    bytes: integer('bytes').notNull().default(0),
    /** Optional local preview URL, e.g. a dev server the run started. */
    previewUrl: text('preview_url'),
    /** Free-form JSON: which validation produced it, screenshot dimensions, etc. */
    meta: text('meta').notNull().default('{}'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('artifacts_run_idx').on(t.runId), index('artifacts_kind_idx').on(t.kind)],
);

/* ------------------------------------------------------------------ *
 * Review findings
 * ------------------------------------------------------------------ */

export const reviewFindings = sqliteTable(
  'review_findings',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull().default(1),
    provider: text('provider').notNull(),
    severity: text('severity').notNull(),
    title: text('title').notNull(),
    detail: text('detail'),
    file: text('file'),
    line: integer('line'),
    /** Model-suggested remedy. Advisory only: nothing applies it automatically. */
    suggestion: text('suggestion'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('review_findings_run_idx').on(t.runId)],
);

/* ------------------------------------------------------------------ *
 * Settings (single-row key/value)
 * ------------------------------------------------------------------ */

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull().default(now),
});

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
export type ValidationCommandRow = typeof validationCommands.$inferSelect;
export type NewValidationCommandRow = typeof validationCommands.$inferInsert;
export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;
export type IterationRow = typeof iterations.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type ChangedFileRow = typeof changedFiles.$inferSelect;
export type ValidationResultRow = typeof validationResults.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type ReviewFindingRow = typeof reviewFindings.$inferSelect;
