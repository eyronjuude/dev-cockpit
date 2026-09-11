-- Validation pipelines, preview configuration, and the AI that may write both.
--
-- Hand-edited after generation, twice, and both edits matter:
--
--  1. drizzle-kit re-emitted migration 0007's `iterations` columns, because
--     `meta/0007_snapshot.json` was never committed and the diff therefore ran
--     against 0006. Those `ALTER TABLE` statements are removed here: they would
--     fail with "duplicate column name" on any database that has 0007, and a
--     database that somehow missed it already gets them from
--     `repairSkippedAdditiveMigrations` in `src/db/client.ts`.
--
--  2. The generated rebuild of `validation_results` selected `step_key` and
--     `step_label` from the old table, which has neither. Left alone it would
--     throw, and a rebuild that dropped the backfill would silently lose every
--     historical validation row. `step_key` is filled from `kind`, which is
--     exactly what identity meant before a project could run two steps of one
--     kind.
--
-- `validation_commands` is deliberately left in place, unread. Nothing queries
-- it after this; it is where a rollback goes.

CREATE TABLE `config_probes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`phase` text DEFAULT 'starting' NOT NULL,
	`report` text,
	`error` text,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `config_probes_project_idx` ON `config_probes` (`project_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `project_config_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`snapshot` text NOT NULL,
	`source` text DEFAULT 'user' NOT NULL,
	`note` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_config_revisions_project_idx` ON `project_config_revisions` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `validation_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`kind` text,
	`command` text NOT NULL,
	`working_dir` text,
	`env` text,
	`timeout_ms` integer DEFAULT 900000 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`blocking` integer DEFAULT true NOT NULL,
	`profiles` text DEFAULT 'quick
standard
deep' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`run_when` text DEFAULT 'always' NOT NULL,
	`run_when_arg` text,
	`retries` integer DEFAULT 0 NOT NULL,
	`retry_on` text DEFAULT 'error' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `validation_steps_project_key_idx` ON `validation_steps` (`project_id`,`key`);--> statement-breakpoint
CREATE INDEX `validation_steps_project_position_idx` ON `validation_steps` (`project_id`,`position`);--> statement-breakpoint
INSERT INTO `validation_steps` (
	`project_id`, `key`, `label`, `kind`, `command`, `working_dir`,
	`timeout_ms`, `enabled`, `blocking`, `profiles`, `position`,
	`run_when`, `retries`, `retry_on`, `created_at`, `updated_at`
)
SELECT
	`project_id`,
	`kind`,
	CASE `kind`
		WHEN 'typecheck' THEN 'Typecheck'
		WHEN 'lint' THEN 'Lint'
		WHEN 'unit' THEN 'Unit'
		WHEN 'integration' THEN 'Integration'
		WHEN 'e2e' THEN 'E2E'
		WHEN 'build' THEN 'Build'
		ELSE `kind`
	END,
	`kind`,
	`command`,
	`working_dir`,
	`timeout_ms`,
	`enabled`,
	`blocking`,
	`profiles`,
	CASE `kind`
		WHEN 'typecheck' THEN 0
		WHEN 'lint' THEN 10
		WHEN 'unit' THEN 20
		WHEN 'integration' THEN 30
		WHEN 'e2e' THEN 40
		WHEN 'build' THEN 50
		ELSE 60
	END,
	'always',
	0,
	'error',
	`created_at`,
	`updated_at`
FROM `validation_commands`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_validation_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`step_key` text DEFAULT '' NOT NULL,
	`step_label` text,
	`kind` text,
	`command_source` text DEFAULT 'project' NOT NULL,
	`command` text,
	`working_dir` text,
	`outcome` text DEFAULT 'running' NOT NULL,
	`blocking` integer DEFAULT true NOT NULL,
	`exit_code` integer,
	`duration_ms` integer,
	`stdout` text,
	`stderr` text,
	`error` text,
	`started_at` text,
	`finished_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_validation_results`("id", "run_id", "attempt", "step_key", "step_label", "kind", "command_source", "command", "working_dir", "outcome", "blocking", "exit_code", "duration_ms", "stdout", "stderr", "error", "started_at", "finished_at", "created_at") SELECT "id", "run_id", "attempt", "kind", NULL, "kind", "command_source", "command", "working_dir", "outcome", "blocking", "exit_code", "duration_ms", "stdout", "stderr", "error", "started_at", "finished_at", "created_at" FROM `validation_results`;--> statement-breakpoint
DROP TABLE `validation_results`;--> statement-breakpoint
ALTER TABLE `__new_validation_results` RENAME TO `validation_results`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `validation_results_run_idx` ON `validation_results` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `validation_results_run_attempt_step_idx` ON `validation_results` (`run_id`,`attempt`,`step_key`);--> statement-breakpoint
ALTER TABLE `projects` ADD `preview_working_dir` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `preview_env` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `preview_port_strategy` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `preview_fixed_port` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `preview_ready_path` text DEFAULT '/' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `preview_ready_timeout_ms` integer DEFAULT 120000 NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `preview_auto_start` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `ai_config_mode` text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `ai_config_provider` text;
