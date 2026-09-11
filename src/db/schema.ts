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
    /**
     * Retention windows for the two kinds of storage a finished run leaves
     * behind, in days. Zero keeps that target forever. Worktrees get the
     * shorter window because they cost far more per run; see `domain/expiry`.
     */
    artifactRetentionDays: integer('artifact_retention_days').notNull().default(30),
    worktreeRetentionDays: integer('worktree_retention_days').notNull().default(7),
    /**
     * Removes a run's worktrees once it lands or is rejected. On by default:
     * both states are terminal, and the removal refuses a dirty worktree or an
     * unmerged branch rather than forcing either.
     *
     * Independent of `worktree_retention_days`: this reclaims immediately on
     * the two terminal statuses, retention catches everything else later.
     */
    cleanUpWorktreeOnFinish: integer('clean_up_worktree_on_finish', { mode: 'boolean' })
      .notNull()
      .default(true),

    /* ------------------------------------------------------------------ *
     * Preview configuration
     *
     * One preview per run, deliberately. `development_command` above is the
     * command; everything here says how to run it and how to tell when it is
     * up. All nullable or defaulted, so a project configured before these
     * existed keeps exactly the behaviour it had.
     * ------------------------------------------------------------------ */

    /** Relative to the worktree root; null means the root itself. */
    previewWorkingDir: text('preview_working_dir'),
    /** Extra environment for the preview process, newline-separated KEY=VALUE. */
    previewEnv: text('preview_env'),
    /**
     * `auto` asks the OS for a free port, which is what V1 always did. `fixed`
     * uses `preview_fixed_port` instead, for a project whose configuration
     * hard-codes a URL and cannot take whatever it is given.
     */
    previewPortStrategy: text('preview_port_strategy').notNull().default('auto'),
    previewFixedPort: integer('preview_fixed_port'),
    /** Path appended to the preview URL when probing for readiness. */
    previewReadyPath: text('preview_ready_path').notNull().default('/'),
    /**
     * How long to wait for the first response before calling the preview
     * failed. V1 polled forever, which left a server that never binds showing
     * `starting` with no way out but stopping it.
     */
    previewReadyTimeoutMs: integer('preview_ready_timeout_ms').notNull().default(120_000),
    /** Start the preview automatically once a build run reaches READY. */
    previewAutoStart: integer('preview_auto_start', { mode: 'boolean' })
      .notNull()
      .default(false),

    /**
     * How much authority the setup advisor has over this project.
     *
     *  - `off`    deterministic detection only
     *  - `draft`  propose; the user reviews and saves. The default.
     *  - `auto`   draft, save, verify in a disposable worktree, revise once
     *
     * `auto` executes commands a model wrote, which is why it is opt-in and
     * why every save is preceded by a revision snapshot.
     */
    aiConfigMode: text('ai_config_mode').notNull().default('draft'),
    /** Which advisor provider to use. Null falls back to the registry default. */
    aiConfigProvider: text('ai_config_provider'),

    /** Agent configuration. */
    agentModel: text('agent_model'),
    /**
     * The column default is historical and never used: `createProject` always
     * writes a value, and the effective default lives in
     * `DEFAULT_AGENT_PERMISSION_MODE` (`domain/types.ts`). Left alone because
     * changing a SQLite column default means rebuilding the table for no
     * behavioural gain. Migration 0002 moved existing rows.
     */
    agentPermissionMode: text('agent_permission_mode').notNull().default('acceptEdits'),
    /** Extra directories the agent may touch, newline-separated. */
    agentAddDirs: text('agent_add_dirs'),

    /**
     * Whether Dev Cockpit's own generated commits (run approval, landing
     * repair) get a Conventional Commits type prefix. On by default; merge
     * commits are never touched regardless of this setting.
     */
    conventionalCommits: integer('conventional_commits', { mode: 'boolean' })
      .notNull()
      .default(true),
    /** `'conventional'` uses the built-in type list; `'custom'` uses the one below. */
    commitConvention: text('commit_convention').notNull().default('conventional'),
    /** The type allow-list when `commitConvention` is `'custom'`, newline-separated. */
    customCommitTypes: text('custom_commit_types'),
    /**
     * Asks the project's transformer to write the commit subject instead of
     * the fixed feat/chore fallback. Off by default: an extra model call per
     * commit is a real cost/latency trade-off, not something to default on.
     */
    aiFormatsCommitMessages: integer('ai_formats_commit_messages', { mode: 'boolean' })
      .notNull()
      .default(false),

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
 * Validation steps
 *
 * Supersedes `validation_commands`, which is left in place unread so a
 * rollback has somewhere to go. The difference that matters: a step is
 * identified by `key`, not by `kind`, so a project can run as many steps as it
 * needs, in an order it chooses, and two of them may share a kind — or carry
 * none at all.
 *
 * `kind` survives as a *tag*. Readiness still reports coverage over the six
 * kinds, the reviewer still receives them, and the implementation map still
 * draws them. What it no longer does is decide identity or order.
 * ------------------------------------------------------------------ */

export const validationSteps = sqliteTable(
  'validation_steps',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Slug, unique per project. The step's identity, and the result row key. */
    key: text('key').notNull(),
    /** What the user calls it. Shown wherever a result is reported. */
    label: text('label').notNull(),
    /** One of `ValidationKind`, or null for a step that fits none of them. */
    kind: text('kind'),
    command: text('command').notNull(),
    /** Relative to the worktree root; null means the root itself. */
    workingDir: text('working_dir'),
    /** Extra environment for this step, newline-separated KEY=VALUE. */
    env: text('env'),
    timeoutMs: integer('timeout_ms').notNull().default(900_000),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /**
     * A non-blocking step records pass/fail but never prevents READY.
     * Used for advisory checks such as a flaky E2E suite.
     */
    blocking: integer('blocking', { mode: 'boolean' }).notNull().default(true),
    /** Which execution profiles run this step, newline-separated. */
    profiles: text('profiles').notNull().default('quick\nstandard\ndeep'),
    /** Explicit order. Spaced by ten so a step can be inserted between two. */
    position: integer('position').notNull().default(0),
    /** One of `RUN_WHEN_CONDITIONS`. */
    runWhen: text('run_when').notNull().default('always'),
    /**
     * Patterns for `changed_files_match`, newline-separated; a step key for
     * `depends_on`; unused for `always`.
     */
    runWhenArg: text('run_when_arg'),
    /** How many times to re-run before accepting the outcome. 0 means once. */
    retries: integer('retries').notNull().default(0),
    /** One of `RETRY_ON_MODES`. Which outcomes a retry applies to. */
    retryOn: text('retry_on').notNull().default('error'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('validation_steps_project_key_idx').on(t.projectId, t.key),
    index('validation_steps_project_position_idx').on(t.projectId, t.position),
  ],
);

/* ------------------------------------------------------------------ *
 * Project configuration revisions
 *
 * Written before every save of a project's validation and preview
 * configuration, whoever made it. This is what makes it safe for the advisor
 * to save on its own: the previous configuration is never lost, and reverting
 * a draft that went wrong costs one click rather than an afternoon of
 * remembering what the commands used to be.
 * ------------------------------------------------------------------ */

export const projectConfigRevisions = sqliteTable(
  'project_config_revisions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** JSON: the validation steps and preview configuration as they were. */
    snapshot: text('snapshot').notNull(),
    /** One of `CONFIG_REVISION_SOURCES`: who wrote the configuration. */
    source: text('source').notNull().default('user'),
    /** A short human-facing account of what changed and why. */
    note: text('note'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('project_config_revisions_project_idx').on(t.projectId, t.createdAt)],
);

/* ------------------------------------------------------------------ *
 * Configuration probes
 *
 * A probe runs a proposed configuration in a disposable worktree to find out
 * whether it actually works, before it is trusted.
 *
 * Progress is polled rather than streamed: `events.run_id` is a NOT NULL
 * foreign key to `runs`, and a probe has no run. Giving it one, or making that
 * column nullable, would cost more than the feature is worth — so the row
 * carries its own status and a JSON result, and the form polls it.
 * ------------------------------------------------------------------ */

export const configProbes = sqliteTable(
  'config_probes',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** One of `PROBE_STATUSES`. */
    status: text('status').notNull().default('running'),
    /** A one-line account of what the probe is doing now. */
    phase: text('phase').notNull().default('starting'),
    /** JSON `ProbeReport`: the proposal tried, every outcome, what was revised. */
    report: text('report'),
    error: text('error'),
    startedAt: text('started_at').notNull().default(now),
    finishedAt: text('finished_at'),
  },
  (t) => [index('config_probes_project_idx').on(t.projectId, t.startedAt)],
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
    mode: text('mode').notNull().default('plan'),
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

    /**
     * The settings actually in force for this iteration.
     *
     * Recorded rather than looked up, because both sources move. `profiles.ts`
     * holds the effort for a profile name, so editing it silently re-labels
     * every past run; and `runs.agent_model` is written back from the session's
     * init message, which is what the provider chose rather than what was
     * asked for. Attributing a cost change to a settings change needs the
     * settings as they were.
     */
    model: text('model'),
    effort: text('effort'),
    permissionMode: text('permission_mode'),

    /**
     * Token counts behind `cost_usd`, as the provider reported them.
     *
     * Null where the provider does not report them (Codex) — distinct from
     * zero, which would claim the iteration used none. Held on the row rather
     * than left in the raw stream artifact because artifacts expire and the
     * question "did that change help" outlives them.
     */
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    /** A subset of `output_tokens`, not additional to it. */
    thinkingTokens: integer('thinking_tokens'),
    cacheReadTokens: integer('cache_read_tokens'),
    cacheCreationTokens: integer('cache_creation_tokens'),

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
    /**
     * Which configured step produced this row. Identity moved here from `kind`
     * when a project gained the ability to run two steps of the same kind.
     * Rows written before that migration carry their kind as the key.
     */
    stepKey: text('step_key').notNull().default(''),
    /** A human label, so a report does not have to say `lint-2`. */
    stepLabel: text('step_label'),
    /** One of `ValidationKind`, or null for a step that fits none of them. */
    kind: text('kind'),
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
    uniqueIndex('validation_results_run_attempt_step_idx').on(t.runId, t.attempt, t.stepKey),
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
    /**
     * Set when retention deleted the bytes. The row survives on purpose: it
     * still records that the run produced this, and how large it was, which is
     * a different and more useful statement than the file being missing.
     */
    expiredAt: text('expired_at'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('artifacts_run_idx').on(t.runId), index('artifacts_kind_idx').on(t.kind)],
);

/* ------------------------------------------------------------------ *
 * Commits
 * ------------------------------------------------------------------ */

/**
 * One row per commit found on a run's branch since its base commit.
 *
 * Recorded rather than derived live on every read: a run's worktree and branch
 * are reclaimed once it lands or is rejected, and a reviewer still needs to
 * see what shipped after that happens. The patch itself lives in an
 * `artifacts` row of kind `commit_diff`, for the same reason `changedFiles`
 * keeps a rollup instead of re-diffing on request.
 */
export const commits = sqliteTable(
  'commits',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    sha: text('sha').notNull(),
    shortSha: text('short_sha').notNull(),
    subject: text('subject').notNull(),
    authorName: text('author_name').notNull(),
    /** ISO-8601, the commit's own author date rather than when this was recorded. */
    authorDate: text('author_date').notNull(),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    filesChanged: integer('files_changed').notNull().default(0),
    /** The commit's own patch, as an `artifacts` row of kind `commit_diff`. */
    diffArtifactId: text('diff_artifact_id'),
    /**
     * Set once this run's branch has been merged into its target branch by the
     * landing flow. There is no push or remote in this app, so "landed" is the
     * closest analogue to "shipped" that a commit can reach.
     */
    landed: integer('landed', { mode: 'boolean' }).notNull().default(false),
    landedAt: text('landed_at'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    index('commits_run_idx').on(t.runId),
    uniqueIndex('commits_run_sha_idx').on(t.runId, t.sha),
  ],
);

/* ------------------------------------------------------------------ *
 * Request attachments
 * ------------------------------------------------------------------ */

/**
 * Files the developer attached to a request.
 *
 * A separate table from `artifacts` even though the shape is close, because
 * the direction of travel is opposite. An artifact is evidence a run produced
 * and retention is allowed to delete it; an attachment is an input the
 * developer supplied and is the only copy the app has. Sharing one table would
 * mean every cleanup path had to remember the difference.
 */
export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    /** Sanitised for the filesystem and the UI; see `safeAttachmentFileName`. */
    fileName: text('file_name').notNull(),
    /** Absolute path on disk. Always inside the attachments directory. */
    filePath: text('file_path').notNull(),
    /** Derived from the extension, never taken from the browser. */
    mimeType: text('mime_type').notNull().default('application/octet-stream'),
    bytes: integer('bytes').notNull().default(0),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('attachments_run_idx').on(t.runId)],
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
export type ValidationStepRow = typeof validationSteps.$inferSelect;
export type NewValidationStepRow = typeof validationSteps.$inferInsert;
export type ProjectConfigRevisionRow = typeof projectConfigRevisions.$inferSelect;
export type ConfigProbeRow = typeof configProbes.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;
export type IterationRow = typeof iterations.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type ChangedFileRow = typeof changedFiles.$inferSelect;
export type ValidationResultRow = typeof validationResults.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type AttachmentRow = typeof attachments.$inferSelect;
export type NewAttachmentRow = typeof attachments.$inferInsert;
export type ReviewFindingRow = typeof reviewFindings.$inferSelect;
export type CommitRow = typeof commits.$inferSelect;
