-- Run and landing worktrees used to accumulate under the data directory until
-- a run was rejected with cleanup or someone removed them by hand. This column
-- lets a project reclaim them automatically once a run lands or is rejected.
--
-- Defaulted on, including for projects registered before it existed: both
-- states are terminal, and the removal refuses a dirty worktree or an unmerged
-- branch rather than forcing either, so nothing unreviewed is lost.
ALTER TABLE `projects` ADD `clean_up_worktree_on_finish` integer DEFAULT true NOT NULL;
