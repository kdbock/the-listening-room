CREATE TABLE `sounds` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT 'Sound effect' NOT NULL,
	`content_type` text DEFAULT 'audio/mpeg' NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`storage_key` text NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`license` text DEFAULT '' NOT NULL,
	`attribution` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sounds_storage_key_unique` ON `sounds` (`storage_key`);