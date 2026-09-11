ALTER TABLE `projects` ADD `conventional_commits` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `commit_convention` text DEFAULT 'conventional' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `custom_commit_types` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `ai_formats_commit_messages` integer DEFAULT false NOT NULL;