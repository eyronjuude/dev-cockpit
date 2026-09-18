CREATE TABLE `project_integrations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`transport` text DEFAULT 'stdio' NOT NULL,
	`command` text,
	`args` text,
	`env` text,
	`url` text,
	`headers` text,
	`enabled` integer DEFAULT true NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_integrations_project_key_idx` ON `project_integrations` (`project_id`,`key`);--> statement-breakpoint
CREATE INDEX `project_integrations_project_position_idx` ON `project_integrations` (`project_id`,`position`);