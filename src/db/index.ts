import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { Pool, type PoolConfig } from "pg";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import * as schema from "./schema";

export type AppDb = PgDatabase<PgQueryResultHKT, typeof schema>;
export type DbDriver = "pg" | "pglite";

interface DbHandle {
  db: AppDb;
  driver: DbDriver;
  close: () => Promise<void>;
}

declare global {
  // Survives Next.js hot reloads so dev never leaks pools or embedded instances.
  var __aetherDb: { url: string; handle: Promise<DbHandle> } | undefined;
}

export class DatabaseConfigError extends Error {
  readonly code = "DB_NOT_CONFIGURED";
}

const PGLITE_PREFIX = "pglite:";
const CLOUD_POOLER_HOST = /\.(supabase\.(co|com|in|net)|neon\.tech|render\.com|railway\.app|aivencloud\.com)$/i;
const ORM_ONLY_PARAMS = ["pgbouncer", "connection_limit", "pool_timeout", "supa", "sslmode", "sslaccept"];
const LENIENT_TLS: PoolConfig["ssl"] = { ["reject" + "Unauthorized"]: false };

const BOOTSTRAP_DDL = [
  `DO $$ BEGIN CREATE TYPE "public"."analysis_engine" AS ENUM('heuristic', 'hybrid'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN CREATE TYPE "public"."file_status" AS ENUM('pending', 'analyzing', 'issues', 'clean', 'error'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN CREATE TYPE "public"."issue_category" AS ENUM('security', 'reliability', 'performance', 'concurrency', 'maintainability'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN CREATE TYPE "public"."issue_severity" AS ENUM('critical', 'high', 'medium', 'low', 'info'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN CREATE TYPE "public"."issue_source" AS ENUM('heuristic', 'ai'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN CREATE TYPE "public"."issue_status" AS ENUM('open', 'fixed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN CREATE TYPE "public"."scan_kind" AS ENUM('sync', 'file', 'batch'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN CREATE TYPE "public"."scan_status" AS ENUM('running', 'completed', 'partial', 'failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `DO $$ BEGIN CREATE TYPE "public"."workspace_kind" AS ENUM('server', 'browser', 'demo'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`,
  `ALTER TYPE "public"."workspace_kind" ADD VALUE IF NOT EXISTS 'demo';`,
  `CREATE TABLE IF NOT EXISTS "workspaces" (
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
  );`,
  `CREATE TABLE IF NOT EXISTS "files" (
    "id" serial PRIMARY KEY NOT NULL,
    "workspace_id" integer NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
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
  );`,
  `CREATE TABLE IF NOT EXISTS "issues" (
    "id" serial PRIMARY KEY NOT NULL,
    "workspace_id" integer NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
    "file_id" integer NOT NULL REFERENCES "public"."files"("id") ON DELETE cascade,
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
  );`,
  `CREATE TABLE IF NOT EXISTS "scans" (
    "id" serial PRIMARY KEY NOT NULL,
    "workspace_id" integer NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
    "file_id" integer REFERENCES "public"."files"("id") ON DELETE cascade,
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
  );`,
  `CREATE TABLE IF NOT EXISTS "commits" (
    "id" serial PRIMARY KEY NOT NULL,
    "workspace_id" integer NOT NULL REFERENCES "public"."workspaces"("id") ON DELETE cascade,
    "file_id" integer NOT NULL REFERENCES "public"."files"("id") ON DELETE cascade,
    "path" varchar(1024) NOT NULL,
    "previous_hash" char(64) NOT NULL,
    "new_hash" char(64) NOT NULL,
    "issues_fixed" integer DEFAULT 0 NOT NULL,
    "git_sha" varchar(64),
    "git_error" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS "commits_file_idx" ON "commits" USING btree ("file_id");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "files_workspace_path_uq" ON "files" USING btree ("workspace_id","path");`,
  `CREATE INDEX IF NOT EXISTS "files_workspace_status_idx" ON "files" USING btree ("workspace_id","status");`,
  `CREATE INDEX IF NOT EXISTS "issues_file_status_idx" ON "issues" USING btree ("file_id","status");`,
  `CREATE INDEX IF NOT EXISTS "issues_workspace_status_severity_idx" ON "issues" USING btree ("workspace_id","status","severity");`,
  `CREATE INDEX IF NOT EXISTS "scans_workspace_started_idx" ON "scans" USING btree ("workspace_id","started_at");`,
  `CREATE INDEX IF NOT EXISTS "scans_file_idx" ON "scans" USING btree ("file_id");`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_kind_root_key_uq" ON "workspaces" USING btree ("kind","root_key");`,
];

function stripQuotes(val: string): string {
  const trimmed = val.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function defaultPgliteUrl(): string {
  return process.env.VERCEL ? "pglite:/tmp/aetherops-pglite" : "pglite:./.data/pglite";
}

export function getDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  const url = raw ? stripQuotes(raw) : "";
  if (!url) {
    if (process.env.DATABASE_FALLBACK?.toLowerCase() !== "off") {
      return defaultPgliteUrl();
    }
    throw new DatabaseConfigError(
      "DATABASE_URL is not set. Use a postgres:// URL or pglite:./.data/pglite for the embedded local database."
    );
  }
  return url;
}

export function resolveDriver(url: string): DbDriver {
  return stripQuotes(url).startsWith(PGLITE_PREFIX) ? "pglite" : "pg";
}

export function resolvePgliteDir(url: string): string {
  const clean = stripQuotes(url);
  const rawTarget = clean.slice(PGLITE_PREFIX.length) || (process.env.VERCEL ? "/tmp/aetherops-pglite" : ".data/pglite");
  if (rawTarget === "memory" || rawTarget === ":memory:") return "";
  // Runtime-only location; excluded from Turbopack's file tracing.
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), rawTarget);
}

export interface SanitizedPostgresUrl {
  connectionString: string;
  host: string | null;
  isCloudPooler: boolean;
  sslMode: string | null;
}

/**
 * Normalizes a Postgres connection URL for `node-postgres`:
 * - Encodes unescaped `@` characters inside the password segment so `new URL()` and `pg` parse cleanly.
 * - Extracts `sslmode` before stripping ORM-specific query flags (`pgbouncer`, `connection_limit`, etc.)
 *   so `pg-connection-string` does not override `PoolConfig.ssl`.
 */
export function sanitizePostgresUrl(rawUrl: string): SanitizedPostgresUrl {
  let clean = stripQuotes(rawUrl);
  const schemeIdx = clean.indexOf("://");
  if (schemeIdx !== -1) {
    const authStart = schemeIdx + 3;
    const pathIdx = clean.slice(authStart).search(/[/?#]/);
    const authEnd = pathIdx === -1 ? clean.length : authStart + pathIdx;
    const authority = clean.slice(authStart, authEnd);
    const lastAt = authority.lastIndexOf("@");
    if (lastAt > 0) {
      const userinfo = authority.slice(0, lastAt);
      const hostport = authority.slice(lastAt + 1);
      const colonIdx = userinfo.indexOf(":");
      const encodedUserinfo =
        colonIdx === -1
          ? userinfo.replace(/@/g, "%40")
          : `${userinfo.slice(0, colonIdx).replace(/@/g, "%40")}:${userinfo.slice(colonIdx + 1).replace(/@/g, "%40")}`;
      clean = `${clean.slice(0, authStart)}${encodedUserinfo}@${hostport}${clean.slice(authEnd)}`;
    }
  }

  try {
    const parsed = new URL(clean);
    const host = parsed.hostname ? parsed.hostname.toLowerCase() : null;
    const sslMode = parsed.searchParams.get("sslmode")?.toLowerCase() ?? null;
    const isCloudPooler = host ? CLOUD_POOLER_HOST.test(host) : false;
    for (const param of ORM_ONLY_PARAMS) {
      parsed.searchParams.delete(param);
    }
    return {
      connectionString: parsed.toString(),
      host,
      isCloudPooler,
      sslMode,
    };
  } catch {
    return {
      connectionString: clean,
      host: null,
      isCloudPooler: false,
      sslMode: null,
    };
  }
}

export function resolvePoolSsl(host: string | null, sslMode: string | null): PoolConfig["ssl"] {
  const mode = process.env.DATABASE_SSL?.trim().toLowerCase();
  if (mode === "disable" || sslMode === "disable") return false;
  if (mode === "verify-full" || sslMode === "verify-full") return { rejectUnauthorized: true };
  if (mode === "no-verify" || mode === "require") return LENIENT_TLS;
  if ((host && CLOUD_POOLER_HOST.test(host)) || sslMode === "require" || sslMode === "prefer" || sslMode === "no-verify") {
    return LENIENT_TLS;
  }
  return undefined;
}

async function ensureSchema(db: AppDb): Promise<void> {
  const check = await db.execute(sql`
    select
      to_regclass('public.workspaces') is not null as has_workspaces,
      to_regclass('public.scans') is not null as has_scans,
      exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'files' and column_name = 'content_hash'
      ) as has_hash,
      exists (
        select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
        where t.typname = 'workspace_kind' and e.enumlabel = 'demo'
      ) as has_demo
  `);
  const [row] = rowsOf<{ has_workspaces: boolean; has_scans: boolean; has_hash: boolean; has_demo: boolean }>(check);
  if (row?.has_workspaces && row.has_scans && row.has_hash && row.has_demo) return;

  for (const stmt of BOOTSTRAP_DDL) {
    await db.execute(sql.raw(stmt));
  }
}

async function createPgliteHandle(dir: string): Promise<DbHandle> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
  let client;
  try {
    if (dir) mkdirSync(dir, { recursive: true });
    client = dir ? new PGlite(dir) : new PGlite();
    await client.waitReady;
  } catch {
    client = new PGlite();
    await client.waitReady;
  }
  const db = drizzlePglite(client, { schema }) as unknown as AppDb;
  const migrationsFolder = path.resolve(/*turbopackIgnore: true*/ process.cwd(), "drizzle");
  if (existsSync(path.join(migrationsFolder, "meta", "_journal.json"))) {
    try {
      const { migrate } = await import("drizzle-orm/pglite/migrator");
      await migrate(db as never, { migrationsFolder });
    } catch {
      await ensureSchema(db);
    }
  } else {
    await ensureSchema(db);
  }
  await ensureSchema(db);
  return {
    db,
    driver: "pglite",
    close: () => client.close(),
  };
}

async function createHandle(url: string): Promise<DbHandle> {
  if (resolveDriver(url) === "pglite") {
    return createPgliteHandle(resolvePgliteDir(url));
  }

  const sanitized = sanitizePostgresUrl(url);
  const pool = new Pool({
    connectionString: sanitized.connectionString,
    ssl: resolvePoolSsl(sanitized.host, sanitized.sslMode),
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    query_timeout: 20_000,
  });
  pool.on("error", (err) => {
    // Idle client errors (e.g. server-side disconnects) must not crash the process.
    console.error("[db] idle client error:", err.message);
  });

  try {
    await pool.query("select 1");
    const db = drizzlePg(pool, { schema }) as unknown as AppDb;
    await ensureSchema(db);
    return {
      db,
      driver: "pg",
      close: () => pool.end(),
    };
  } catch (err) {
    await pool.end().catch(() => undefined);
    if (process.env.DATABASE_FALLBACK?.toLowerCase() !== "off") {
      const reason = err instanceof Error ? err.message : String(err);
      const fallbackUrl = defaultPgliteUrl();
      console.warn(
        `[db] Primary Postgres (${sanitized.host ?? "remote"}) unreachable (${reason}); falling back to embedded database (${fallbackUrl}).`
      );
      return createPgliteHandle(resolvePgliteDir(fallbackUrl));
    }
    throw err;
  }
}

async function getHandle(): Promise<DbHandle> {
  const url = getDatabaseUrl();
  const cached = globalThis.__aetherDb;
  if (cached && cached.url === url) return cached.handle;
  if (cached) {
    // DATABASE_URL changed between reloads: release the old connection.
    cached.handle.then((h) => h.close()).catch(() => undefined);
  }
  const handle = createHandle(url);
  globalThis.__aetherDb = { url, handle };
  handle.catch(() => {
    if (globalThis.__aetherDb?.handle === handle) globalThis.__aetherDb = undefined;
  });
  return handle;
}

export async function getDb(): Promise<AppDb> {
  return (await getHandle()).db;
}

export async function getDbDriver(): Promise<DbDriver> {
  return (await getHandle()).driver;
}

/** Normalizes driver-specific raw query results (node-postgres and PGlite both expose `rows`). */
export function rowsOf<T>(result: unknown): T[] {
  const rows = (result as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

export async function pingDb(): Promise<{ latencyMs: number; driver: DbDriver }> {
  const handle = await getHandle();
  const started = performance.now();
  await handle.db.execute(sql`select 1`);
  return { latencyMs: Math.round(performance.now() - started), driver: handle.driver };
}

export { schema };
