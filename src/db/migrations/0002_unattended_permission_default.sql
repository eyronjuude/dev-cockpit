-- Projects registered before unattended runs became the default still carry
-- `acceptEdits`, which refuses every shell command. Nobody is present during a
-- run to approve anything, so those projects were working blind by accident of
-- when they were created rather than by choice. Move them onto the new default.
--
-- Only the old default is touched. A project deliberately set to `plan`, or to
-- anything another provider adds later, is left exactly as it is.
UPDATE `projects` SET `agent_permission_mode` = 'bypassPermissions' WHERE `agent_permission_mode` = 'acceptEdits';
