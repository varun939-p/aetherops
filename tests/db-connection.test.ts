import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pingDb, sanitizePostgresUrl, resolvePoolSsl } from "@/db";
import { toAppError } from "@/lib/api";
import { systemStatus } from "@/server/workspaces";

test("sanitizePostgresUrl encodes unescaped @ in password and strips ORM-only query params", () => {
  const raw =
    '  "postgresql://postgres.arwxingvaqevfjljkarv:MySecret@99669@aws-1-eu-west-3.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1&sslmode=require"  ';
  const res = sanitizePostgresUrl(raw);
  assert.equal(res.host, "aws-1-eu-west-3.pooler.supabase.com");
  assert.equal(res.isCloudPooler, true);
  assert.equal(res.sslMode, "require");
  const parsed = new URL(res.connectionString);
  assert.equal(parsed.username, "postgres.arwxingvaqevfjljkarv");
  assert.equal(decodeURIComponent(parsed.password), "MySecret@99669");
  assert.equal(parsed.searchParams.get("pgbouncer"), null);
  assert.equal(parsed.searchParams.get("connection_limit"), null);
  assert.equal(parsed.searchParams.get("sslmode"), null);
});

test("resolvePoolSsl enables lenient TLS for Supabase/Neon poolers and respects DATABASE_SSL overrides", () => {
  const prev = process.env.DATABASE_SSL;
  try {
    delete process.env.DATABASE_SSL;
    const supaSsl = resolvePoolSsl("aws-1-eu-west-3.pooler.supabase.com", null);
    assert.deepEqual(supaSsl, { rejectUnauthorized: false });

    const localSsl = resolvePoolSsl("localhost", null);
    assert.equal(localSsl, undefined);

    process.env.DATABASE_SSL = "disable";
    assert.equal(resolvePoolSsl("aws-1-eu-west-3.pooler.supabase.com", "require"), false);
  } finally {
    if (prev === undefined) delete process.env.DATABASE_SSL;
    else process.env.DATABASE_SSL = prev;
  }
});

test("toAppError maps Supavisor XX000 tenant not found and TLS chain errors to 503 DB_UNAVAILABLE", () => {
  const supavisorErr = new Error("Failed query: select 1", {
    cause: Object.assign(new Error("(ENOTFOUND) tenant/user postgres.arwxingvaqevfjljkarv not found"), {
      code: "XX000",
    }),
  });
  const appErr = toAppError(supavisorErr);
  assert.equal(appErr.status, 503);
  assert.equal(appErr.code, "DB_UNAVAILABLE");
  assert.match(appErr.message, /tenant\/user postgres\.arwxingvaqevfjljkarv not found/i);

  const tlsErr = new Error("self-signed certificate in certificate chain");
  Object.assign(tlsErr, { code: "SELF_SIGNED_CERT_IN_CHAIN" });
  const tlsAppErr = toAppError(tlsErr);
  assert.equal(tlsAppErr.status, 503);
  assert.equal(tlsAppErr.code, "DB_UNAVAILABLE");
});

// Nothing listens on port 1, so this stands in for a paused or deleted cloud database.
const UNREACHABLE_POSTGRES = "postgresql://postgres.pausedtenant:Pass@99669@127.0.0.1:1/postgres?pgbouncer=true";

async function releaseDbHandle(): Promise<void> {
  if (globalThis.__aetherDb) await globalThis.__aetherDb.handle.then((h) => h.close()).catch(() => undefined);
  globalThis.__aetherDb = undefined;
  globalThis.__aetherSchemaReady = undefined;
}

/** Runs `fn` against a fresh database handle with exactly the given environment, then restores everything. */
async function withDbEnv(env: { DATABASE_URL?: string; VERCEL?: string }, fn: () => Promise<void>): Promise<void> {
  const keys = ["DATABASE_URL", "VERCEL", "DATABASE_FALLBACK"] as const;
  const previous = keys.map((k) => [k, process.env[k]] as const);
  const scratch = mkdtempSync(path.join(tmpdir(), "aetherops-db-"));
  const cwd = process.cwd();
  await releaseDbHandle();
  try {
    for (const k of keys) delete process.env[k];
    if (env.DATABASE_URL !== undefined) process.env.DATABASE_URL = env.DATABASE_URL;
    if (env.VERCEL !== undefined) process.env.VERCEL = env.VERCEL;
    // The local fallback writes to ./.data/pglite; keep it out of the repository's real database.
    process.chdir(scratch);
    await fn();
  } finally {
    await releaseDbHandle();
    process.chdir(cwd);
    for (const [k, v] of previous) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
}

test("locally, an unreachable Postgres falls back to the embedded database", async () => {
  await withDbEnv({ DATABASE_URL: UNREACHABLE_POSTGRES }, async () => {
    const ping = await pingDb();
    assert.equal(ping.driver, "pglite");
  });
});

test("on Vercel, an unreachable Postgres is reported as unreachable instead of serving a private embedded database", async () => {
  await withDbEnv({ DATABASE_URL: UNREACHABLE_POSTGRES, VERCEL: "1" }, async () => {
    const { db } = await systemStatus();
    assert.equal(db.configured, true);
    assert.equal(db.connected, false);
    assert.equal(db.migrated, false);
    assert.equal(db.driver, null);
    assert.equal(typeof db.error, "string");
  });
});

test("on Vercel, a missing DATABASE_URL is a configuration error, not an embedded database", async () => {
  await withDbEnv({ VERCEL: "1" }, async () => {
    const { db } = await systemStatus();
    assert.equal(db.configured, false);
    assert.equal(db.connected, false);
    assert.equal(db.driver, null);
    assert.match(db.error ?? "", /DATABASE_URL/);
  });
});

test("on Vercel, an explicit pglite: URL is refused because each function would get its own copy", async () => {
  await withDbEnv({ DATABASE_URL: "pglite:memory", VERCEL: "1" }, async () => {
    const { db } = await systemStatus();
    assert.equal(db.configured, false);
    assert.equal(db.connected, false);
    assert.equal(db.driver, null);
  });
});

