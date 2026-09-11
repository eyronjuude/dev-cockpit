-- Iteration usage: what an iteration cost, and what it was configured with.
--
-- `cost_usd` has been on the row since the beginning and cannot explain
-- itself. An iteration that spent most of its money re-reading its own
-- transcript and one that spent it thinking are the same dollar figure and
-- want opposite fixes. The provider reports the split on its result line;
-- until now it was parsed past and left only in the raw stream artifact,
-- which retention deletes.
--
-- The settings columns exist for the other half of the question. Effort is
-- resolved from `profiles.ts` by name, so editing a profile silently
-- re-labels every past run; `runs.agent_model` is written back from the
-- session's init message, which is what the provider chose rather than what
-- was requested. Neither can answer "which setting was different on this run".
ALTER TABLE `iterations` ADD `model` text;--> statement-breakpoint
ALTER TABLE `iterations` ADD `effort` text;--> statement-breakpoint
ALTER TABLE `iterations` ADD `permission_mode` text;--> statement-breakpoint
-- Nullable throughout: Codex reports no token counts, and null says "not
-- reported" where zero would claim the iteration used none.
ALTER TABLE `iterations` ADD `input_tokens` integer;--> statement-breakpoint
ALTER TABLE `iterations` ADD `output_tokens` integer;--> statement-breakpoint
-- A subset of `output_tokens`, not additional to it.
ALTER TABLE `iterations` ADD `thinking_tokens` integer;--> statement-breakpoint
ALTER TABLE `iterations` ADD `cache_read_tokens` integer;--> statement-breakpoint
ALTER TABLE `iterations` ADD `cache_creation_tokens` integer;
