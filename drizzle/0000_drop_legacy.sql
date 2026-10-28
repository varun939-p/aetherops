-- Removes the pre-migration prototype schema (created at request time by the old ensureTables()).
-- Those tables only held cached copies of local files and derived analysis; re-linking a folder rebuilds them.
-- On a fresh database every statement is a no-op.
DROP TABLE IF EXISTS "analysis_history" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "issues" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "files" CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS "file_status";--> statement-breakpoint
DROP TYPE IF EXISTS "severity";--> statement-breakpoint
DROP TYPE IF EXISTS "source";
