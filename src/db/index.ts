import path from "node:path";
import { mkdirSync } from "node:fs";
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

function stripQuotes(val: string): string {
  const trimmed = val.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function getDatabaseUrl(): string {
  const raw = process.env.DATABASE_URL;
  const url = raw ? stripQuotes(raw) : "";
  if (!url) {
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
  // Runtime-only location; excluded from Turbopack's file tracing.
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), clean.slice(PGLITE_PREFIX.length) || ".data/pglite");
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

async function createPgliteHandle(dir: string): Promise<DbHandle> {
  mkdirSync(dir, { recursive: true });
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite(dir);
  await client.waitReady;
  const db = drizzlePglite(client, { schema });
  const migrationsFolder = path.resolve(/*turbopackIgnore: true*/ process.cwd(), "drizzle");
  await migrate(db, { migrationsFolder });
  return {
    db: db as unknown as AppDb,
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
    return {
      db: drizzlePg(pool, { schema }) as unknown as AppDb,
      driver: "pg",
      close: () => pool.end(),
    };
  } catch (err) {
    await pool.end().catch(() => undefined);
    if (!process.env.VERCEL && process.env.DATABASE_FALLBACK?.toLowerCase() !== "off") {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[db] Primary Postgres (${sanitized.host ?? "remote"}) unreachable (${reason}); falling back to embedded local database (.data/pglite).`
      );
      return createPgliteHandle(resolvePgliteDir("pglite:./.data/pglite"));
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
