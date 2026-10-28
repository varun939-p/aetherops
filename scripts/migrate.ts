/**
 * Applies drizzle/ migrations to DATABASE_URL (Postgres or pglite:) and reports failures explicitly.
 * Replaces `drizzle-kit migrate`, which exits 1 without printing connection errors. Uses the same
 * drizzle.__drizzle_migrations table, so both tools see the same history.
 */
import path from "node:path";
import { mkdirSync } from "node:fs";

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file); // never overrides variables that are already set
  } catch {
    // file absent
  }
}

const migrationsFolder = path.resolve("drizzle");
const url = process.env.DATABASE_URL?.trim();

function hint(err: unknown, host: string | null): string {
  const code = (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
  switch (code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `DNS could not resolve ${host}. If it resolves with \`nslookup ${host} 1.1.1.1\`, your network's DNS server is blocking it: switch the adapter's DNS (e.g. 1.1.1.1 / 8.8.8.8) or use DATABASE_URL=pglite:./.data/pglite.`;
    case "ECONNREFUSED":
    case "ETIMEDOUT":
      return `Could not connect to ${host}. Check that the database is running and reachable from this network.`;
    case "28P01":
      return "Authentication failed: check the user and password in DATABASE_URL.";
    case "3D000":
      return "The database named in DATABASE_URL does not exist.";
    default:
      return "";
  }
}

async function main(): Promise<number> {
  if (!url) {
    console.error("✗ DATABASE_URL is not set (add it to .env).");
    return 1;
  }
  if (url.startsWith("pglite:")) {
    const dir = path.resolve(url.slice("pglite:".length) || ".data/pglite");
    mkdirSync(dir, { recursive: true });
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const client = new PGlite(dir);
    try {
      await migrate(drizzle(client), { migrationsFolder });
      console.log(`✓ Migrations applied (embedded database at ${path.relative(process.cwd(), dir)})`);
      return 0;
    } finally {
      await client.close();
    }
  }

  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  })();
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const ssl = process.env.DATABASE_SSL === "disable" ? false : process.env.DATABASE_SSL === "no-verify" ? { rejectUnauthorized: false } : undefined;
  const pool = new Pool({ connectionString: url, ssl, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
    console.log(`✓ Migrations applied (${host ?? "postgres"})`);
    return 0;
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause ?? err;
    console.error(`✗ Migration failed on ${host ?? "postgres"}: ${cause instanceof Error ? cause.message : String(cause)}`);
    const h = hint(cause, host);
    if (h) console.error(`  ${h}`);
    return 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`✗ Migration failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
);
