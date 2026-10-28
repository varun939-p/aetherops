CREATE TYPE "public"."analysis_engine" AS ENUM('heuristic', 'hybrid');--> statement-breakpoint
CREATE TYPE "public"."file_status" AS ENUM('pending', 'analyzing', 'issues', 'clean', 'error');--> statement-breakpoint
CREATE TYPE "public"."issue_category" AS ENUM('security', 'reliability', 'performance', 'concurrency', 'maintainability');--> statement-breakpoint
CREATE TYPE "public"."issue_severity" AS ENUM('critical', 'high', 'medium', 'low', 'info');--> statement-breakpoint
CREATE TYPE "public"."issue_source" AS ENUM('heuristic', 'ai');--> statement-breakpoint
CREATE TYPE "public"."issue_status" AS ENUM('open', 'fixed');--> statement-breakpoint
CREATE TYPE "public"."scan_kind" AS ENUM('sync', 'file', 'batch');--> statement-breakpoint
CREATE TYPE "public"."scan_status" AS ENUM('running', 'completed', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."workspace_kind" AS ENUM('server', 'browser');--> statement-breakpoint
CREATE TABLE "commits" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"file_id" integer NOT NULL,
	"path" varchar(1024) NOT NULL,
	"previous_hash" char(64) NOT NULL,
	"new_hash" char(64) NOT NULL,
	"issues_fixed" integer DEFAULT 0 NOT NULL,
	"git_sha" varchar(64),
	"git_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"path" varchar(1024) NOT NULL,
	"content" text NOT NULL,
	"content_hash" char(64) NOT NULL,
	"language" varchar(50) DEFAULT 'plaintext' NOT NULL,
	"extension" varchar(32) DEFAULT '' NOT NULL,
	"eol" varchar(4) DEFAULT 'lf' NOT NULL,
	"file_size" integer DEFAULT 0 NOT NULL,
	"line_count" integer DEFAULT 0 NOT NULL,
	"status" "file_status" DEFAULT 'pending' NOT NULL,
	"engine" "analysis_engine",
	"analyzed_hash" char(64),
	"corrected_content" text,
	"corrected_for_hash" char(64),
	"quality_score" integer,
	"summary" text,
	"error_message" text,
	"model_used" varchar(100),
	"lease_expires_at" timestamp with time zone,
	"last_analyzed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"file_id" integer NOT NULL,
	"rule_id" varchar(64) NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"remediation" text,
	"severity" "issue_severity" NOT NULL,
	"category" "issue_category" NOT NULL,
	"source" "issue_source" NOT NULL,
	"status" "issue_status" DEFAULT 'open' NOT NULL,
	"line" integer NOT NULL,
	"column" integer DEFAULT 1 NOT NULL,
	"end_line" integer NOT NULL,
	"end_column" integer DEFAULT 1 NOT NULL,
	"content_hash" char(64) NOT NULL,
	"fixed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scans" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"file_id" integer,
	"kind" "scan_kind" NOT NULL,
	"status" "scan_status" DEFAULT 'running' NOT NULL,
	"engine" "analysis_engine" NOT NULL,
	"model_used" varchar(100),
	"files_total" integer DEFAULT 0 NOT NULL,
	"files_scanned" integer DEFAULT 0 NOT NULL,
	"files_skipped" integer DEFAULT 0 NOT NULL,
	"issues_found" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"error" text,
	"meta" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" "workspace_kind" NOT NULL,
	"name" varchar(255) NOT NULL,
	"root_path" text NOT NULL,
	"root_key" varchar(1024) NOT NULL,
	"is_git_repo" boolean DEFAULT false NOT NULL,
	"git_branch" varchar(255),
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scans" ADD CONSTRAINT "scans_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "commits_file_idx" ON "commits" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "files_workspace_path_uq" ON "files" USING btree ("workspace_id","path");--> statement-breakpoint
CREATE INDEX "files_workspace_status_idx" ON "files" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "issues_file_status_idx" ON "issues" USING btree ("file_id","status");--> statement-breakpoint
CREATE INDEX "issues_workspace_status_severity_idx" ON "issues" USING btree ("workspace_id","status","severity");--> statement-breakpoint
CREATE INDEX "scans_workspace_started_idx" ON "scans" USING btree ("workspace_id","started_at");--> statement-breakpoint
CREATE INDEX "scans_file_idx" ON "scans" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_kind_root_key_uq" ON "workspaces" USING btree ("kind","root_key");