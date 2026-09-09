-- Run expiry: reclaiming the storage a finished run leaves behind.
--
-- `artifact_retention_days` has existed since the first migration and nothing
-- ever enforced it. It is enforced from here, and gains a companion for the
-- other half of a run's disk footprint. Worktrees get their own, shorter,
-- window because they cost two orders of magnitude more per run: a checkout
-- plus whatever `link_paths` brought in, against a few megabytes of logs.
--
-- `expired_at` is set when retention deleted an artifact's bytes. The row
-- stays: "expired under the 30-day policy, 4.2 MB" is a true statement about
-- the run, and deleting the row would leave the UI calling the file missing.
ALTER TABLE `artifacts` ADD `expired_at` text;--> statement-breakpoint
-- Seven days by default, including for projects registered before this
-- existed. Reclaiming a worktree refuses a dirty checkout and an unmerged
-- branch rather than forcing either, so a shorter window cannot lose work.
-- Zero on either retention column keeps that target forever.
ALTER TABLE `projects` ADD `worktree_retention_days` integer DEFAULT 7 NOT NULL;
