CREATE TABLE `commits` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`sha` text NOT NULL,
	`short_sha` text NOT NULL,
	`subject` text NOT NULL,
	`author_name` text NOT NULL,
	`author_date` text NOT NULL,
	`additions` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	`files_changed` integer DEFAULT 0 NOT NULL,
	`diff_artifact_id` text,
	`landed` integer DEFAULT false NOT NULL,
	`landed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `commits_run_idx` ON `commits` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `commits_run_sha_idx` ON `commits` (`run_id`,`sha`);