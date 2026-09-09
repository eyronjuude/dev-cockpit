CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`file_name` text NOT NULL,
	`file_path` text NOT NULL,
	`mime_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachments_run_idx` ON `attachments` (`run_id`);