import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizePostgresUrl, resolvePoolSsl } from "@/db";
import { toAppError } from "@/lib/api";

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

test("pingDb falls back to embedded PGlite when remote cloud Postgres is unreachable in local dev", async () => {
  const prevUrl = process.env.DATABASE_URL;
  const prevVercel = process.env.VERCEL;
  try {
    delete process.env.VERCEL;
    globalThis.__aetherDb = undefined;
    process.env.DATABASE_URL = "postgresql://postgres.pausedtenant:Pass@99669@127.0.0.1:1/postgres?pgbouncer=true";
    const { pingDb } = await import("@/db");
    const ping = await pingDb();
    assert.equal(ping.driver, "pglite");
    assert.ok(ping.latencyMs >= 0);
  } finally {
    if (globalThis.__aetherDb) {
      await globalThis.__aetherDb.handle.then((h) => h.close()).catch(() => undefined);
      globalThis.__aetherDb = undefined;
    }
    if (prevUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevUrl;
    if (prevVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prevVercel;
  }
});

