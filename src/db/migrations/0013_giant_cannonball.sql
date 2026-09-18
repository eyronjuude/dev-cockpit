CREATE TABLE `operational_command_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`operational_command_id` text NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text,
	`label` text NOT NULL,
	`command` text NOT NULL,
	`target` text NOT NULL,
	`cwd` text NOT NULL,
	`outcome` text DEFAULT 'running' NOT NULL,
	`exit_code` integer,
	`duration_ms` integer,
	`stdout` text,
	`stderr` text,
	`error` text,
	`started_at` text,
	`finished_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`operational_command_id`) REFERENCES `operational_commands`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `operational_command_runs_command_idx` ON `operational_command_runs` (`operational_command_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `operational_command_runs_project_idx` ON `operational_command_runs` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `operational_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`label` text NOT NULL,
	`command` text NOT NULL,
	`working_dir` text,
	`target` text DEFAULT 'non_production' NOT NULL,
	`env` text,
	`timeout_ms` integer DEFAULT 900000 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `operational_commands_project_idx` ON `operational_commands` (`project_id`);--> statement-breakpoint
ALTER TABLE `projects` ADD `env` text;