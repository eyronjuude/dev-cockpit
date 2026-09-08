CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`file_path` text NOT NULL,
	`mime_type` text DEFAULT 'text/plain' NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`preview_url` text,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `artifacts_run_idx` ON `artifacts` (`run_id`);--> statement-breakpoint
CREATE INDEX `artifacts_kind_idx` ON `artifacts` (`kind`);--> statement-breakpoint
CREATE TABLE `changed_files` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`path` text NOT NULL,
	`change_type` text NOT NULL,
	`additions` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	`previous_path` text,
	`binary` integer DEFAULT false NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `changed_files_run_path_idx` ON `changed_files` (`run_id`,`path`);--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`run_id` text NOT NULL,
	`type` text NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`message` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_run_seq_idx` ON `events` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_type_idx` ON `events` (`type`);--> statement-breakpoint
CREATE TABLE `iterations` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`kind` text DEFAULT 'initial' NOT NULL,
	`prompt` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`session_id` text,
	`resumed` integer DEFAULT false NOT NULL,
	`exit_code` integer,
	`num_turns` integer,
	`cost_usd` real,
	`final_text` text,
	`error` text,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `iterations_run_idx` ON `iterations` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `iterations_run_ordinal_idx` ON `iterations` (`run_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repository_path` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`development_command` text,
	`setup_command` text,
	`open_command` text,
	`link_paths` text,
	`protected_branches` text DEFAULT 'main
master' NOT NULL,
	`require_validation` integer DEFAULT true NOT NULL,
	`require_e2e_for_ui_changes` integer DEFAULT false NOT NULL,
	`ui_path_patterns` text,
	`capture_screenshots` integer DEFAULT true NOT NULL,
	`allow_agent_commit` integer DEFAULT false NOT NULL,
	`review_blocks_ready` integer DEFAULT false NOT NULL,
	`artifact_retention_days` integer DEFAULT 30 NOT NULL,
	`agent_model` text,
	`agent_permission_mode` text DEFAULT 'acceptEdits' NOT NULL,
	`agent_add_dirs` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_repository_path_idx` ON `projects` (`repository_path`);--> statement-breakpoint
CREATE TABLE `review_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`provider` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`detail` text,
	`file` text,
	`line` integer,
	`suggestion` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `review_findings_run_idx` ON `review_findings` (`run_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`request` text NOT NULL,
	`spec` text,
	`spec_provider` text,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`status_reason` text,
	`profile` text DEFAULT 'standard' NOT NULL,
	`base_branch` text,
	`base_commit` text,
	`branch` text,
	`worktree_path` text,
	`commit_sha` text,
	`agent_provider` text DEFAULT 'claude-code' NOT NULL,
	`agent_session_id` text,
	`agent_model` text,
	`transformer_provider` text DEFAULT 'none' NOT NULL,
	`reviewer_provider` text DEFAULT 'none' NOT NULL,
	`disposition` text,
	`disposition_note` text,
	`error` text,
	`cost_usd` real,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `runs_project_idx` ON `runs` (`project_id`);--> statement-breakpoint
CREATE INDEX `runs_status_idx` ON `runs` (`status`);--> statement-breakpoint
CREATE INDEX `runs_created_idx` ON `runs` (`created_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `validation_commands` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`command` text NOT NULL,
	`working_dir` text,
	`timeout_ms` integer DEFAULT 900000 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`blocking` integer DEFAULT true NOT NULL,
	`profiles` text DEFAULT 'quick
standard
deep' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `validation_commands_project_kind_idx` ON `validation_commands` (`project_id`,`kind`);--> statement-breakpoint
CREATE TABLE `validation_results` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`kind` text NOT NULL,
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
CREATE INDEX `validation_results_run_idx` ON `validation_results` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `validation_results_run_attempt_kind_idx` ON `validation_results` (`run_id`,`attempt`,`kind`);