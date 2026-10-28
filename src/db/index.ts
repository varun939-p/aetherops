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

export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new DatabaseConfigError(
      "DATABASE_URL is not set. Use a postgres:// URL or pglite:./.data/pglite for the embedded local database."
    );
  }
  return url;
}

export function resolveDriver(url: string): DbDriver {
  return url.startsWith(PGLITE_PREFIX) ? "pglite" : "pg";
}

export function resolvePgliteDir(url: string): string {
  // Runtime-only location; excluded from Turbopack's file tracing.
  return path.resolve(/*turbopackIgnore: true*/ process.cwd(), url.slice(PGLITE_PREFIX.length) || ".data/pglite");
}

function poolSsl(): PoolConfig["ssl"] {
  const mode = process.env.DATABASE_SSL?.toLowerCase();
  if (mode === "disable") return false;
  // Explicit opt-in only: skipping certificate verification enables MITM on the DB link.
  if (mode === "no-verify") return { rejectUnauthorized: false };
  // Otherwise let sslmode in the connection string decide (verify by default).
  return undefined;
}

async function createHandle(url: string): Promise<DbHandle> {
  if (resolveDriver(url) === "pglite") {
    const dir = resolvePgliteDir(url);
    mkdirSync(dir, { recursive: true });
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
    const client = new PGlite(dir);
    await client.waitReady;
    return {
      db: drizzlePglite(client, { schema }) as unknown as AppDb,
      driver: "pglite",
      close: () => client.close(),
    };
  }

  const pool = new Pool({
    connectionString: url,
    ssl: poolSsl(),
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    query_timeout: 20_000,
  });
  pool.on("error", (err) => {
    // Idle client errors (e.g. server-side disconnects) must not crash the process.
    console.error("[db] idle client error:", err.message);
  });
  return {
    db: drizzlePg(pool, { schema }) as unknown as AppDb,
    driver: "pg",
    close: () => pool.end(),
  };
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
  const db = await getDb();
  const started = performance.now();
  await db.execute(sql`select 1`);
  return { latencyMs: Math.round(performance.now() - started), driver: await getDbDriver() };
}

export { schema };
