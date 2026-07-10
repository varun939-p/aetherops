import { db } from "@/db";
import { sql } from "drizzle-orm";

let ensured = false;

export async function ensureTables() {
  if (ensured) return;
  try {
    // Create enums if not exist
    await db.execute(sql`
      DO $$ BEGIN
        CREATE TYPE "file_status" AS ENUM ('pending','analyzing','issues','clean','error','committing');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$;
    `);
    await db.execute(sql`
      DO $$ BEGIN
        CREATE TYPE "severity" AS ENUM ('critical','high','medium','low','info');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$;
    `);
    await db.execute(sql`
      DO $$ BEGIN
        CREATE TYPE "source" AS ENUM ('heuristic','ai');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$;
    `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "files" (
        "id" SERIAL PRIMARY KEY,
        "path" VARCHAR(1024) NOT NULL UNIQUE,
        "content" TEXT NOT NULL DEFAULT '',
        "corrected_content" TEXT,
        "language" VARCHAR(50) NOT NULL DEFAULT 'plaintext',
        "extension" VARCHAR(20) NOT NULL DEFAULT '',
        "status" "file_status" NOT NULL DEFAULT 'pending',
        "file_size" INTEGER NOT NULL DEFAULT 0,
        "error_message" TEXT,
        "quality_score" INTEGER DEFAULT 0,
        "line_count" INTEGER DEFAULT 0,
        "created_at" TIMESTAMP DEFAULT NOW() NOT NULL,
        "updated_at" TIMESTAMP DEFAULT NOW() NOT NULL,
        "last_analyzed_at" TIMESTAMP,
        "model_used" VARCHAR(100)
      );
    `);
    await db.execute(sql` CREATE INDEX IF NOT EXISTS "path_idx" ON "files" ("path"); `);
    await db.execute(sql` CREATE INDEX IF NOT EXISTS "status_idx" ON "files" ("status"); `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "issues" (
        "id" SERIAL PRIMARY KEY,
        "file_id" INTEGER NOT NULL REFERENCES "files"("id") ON DELETE CASCADE,
        "severity" "severity" NOT NULL DEFAULT 'medium',
        "line" INTEGER NOT NULL DEFAULT 1,
        "column" INTEGER DEFAULT 0,
        "message" TEXT NOT NULL,
        "source" "source" NOT NULL DEFAULT 'heuristic',
        "rule_id" VARCHAR(100),
        "created_at" TIMESTAMP DEFAULT NOW() NOT NULL
      );
    `);
    await db.execute(sql` CREATE INDEX IF NOT EXISTS "file_id_idx" ON "issues" ("file_id"); `);
    await db.execute(sql` CREATE INDEX IF NOT EXISTS "severity_idx" ON "issues" ("severity"); `);

    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "analysis_history" (
        "id" SERIAL PRIMARY KEY,
        "file_id" INTEGER NOT NULL REFERENCES "files"("id") ON DELETE CASCADE,
        "issues_count" INTEGER NOT NULL DEFAULT 0,
        "duration_ms" INTEGER NOT NULL DEFAULT 0,
        "model_used" VARCHAR(100),
        "status" "file_status" NOT NULL DEFAULT 'pending',
        "summary" TEXT,
        "raw_response" JSONB,
        "created_at" TIMESTAMP DEFAULT NOW() NOT NULL
      );
    `);
    await db.execute(sql` CREATE INDEX IF NOT EXISTS "analysis_file_id_idx" ON "analysis_history" ("file_id"); `);

    ensured = true;
  } catch (e) {
    console.error("ensureTables failed", e);
    // Don't throw, let caller try anyway - tables might already exist
    ensured = true;
  }
}
