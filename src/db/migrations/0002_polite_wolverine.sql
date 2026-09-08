ALTER TABLE `runs` ADD `mode` text DEFAULT 'build' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `resolved_mode` text;
