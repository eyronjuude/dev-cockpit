PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`request` text NOT NULL,
	`spec` text,
	`spec_provider` text,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`status_reason` text,
	`profile` text DEFAULT 'standard' NOT NULL,
	`mode` text DEFAULT 'plan' NOT NULL,
	`resolved_mode` text,
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
INSERT INTO `__new_runs`("id", "project_id", "title", "request", "spec", "spec_provider", "status", "status_reason", "profile", "mode", "resolved_mode", "base_branch", "base_commit", "branch", "worktree_path", "commit_sha", "agent_provider", "agent_session_id", "agent_model", "transformer_provider", "reviewer_provider", "disposition", "disposition_note", "error", "cost_usd", "created_at", "updated_at", "started_at", "finished_at") SELECT "id", "project_id", "title", "request", "spec", "spec_provider", "status", "status_reason", "profile", "mode", "resolved_mode", "base_branch", "base_commit", "branch", "worktree_path", "commit_sha", "agent_provider", "agent_session_id", "agent_model", "transformer_provider", "reviewer_provider", "disposition", "disposition_note", "error", "cost_usd", "created_at", "updated_at", "started_at", "finished_at" FROM `runs`;--> statement-breakpoint
DROP TABLE `runs`;--> statement-breakpoint
ALTER TABLE `__new_runs` RENAME TO `runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `runs_project_idx` ON `runs` (`project_id`);--> statement-breakpoint
CREATE INDEX `runs_status_idx` ON `runs` (`status`);--> statement-breakpoint
CREATE INDEX `runs_created_idx` ON `runs` (`created_at`);