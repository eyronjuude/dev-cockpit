ALTER TABLE `runs` ADD `last_review_attempt` integer;--> statement-breakpoint
UPDATE `runs` SET `last_review_attempt` = (
  SELECT MAX(`attempt`) FROM `review_findings` WHERE `review_findings`.`run_id` = `runs`.`id`
) WHERE EXISTS (
  SELECT 1 FROM `review_findings` WHERE `review_findings`.`run_id` = `runs`.`id`
);