CREATE TABLE `ai_usage` (
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`cost_micro_usd` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `day`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
