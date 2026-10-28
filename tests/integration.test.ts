import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { AppDb } from "@/db";
import { resolveInside, walkWorkspace, writeWorkspaceFileAtomic } from "@/lib/fs-desktop";
import { sha256Hex } from "@/lib/text";
import { createWorkspace } from "@/server/workspaces";
import { applyManifest, applySync } from "@/server/sync";
import { acquireLease, analyzeFile, runBatch } from "@/server/analysis";
import { computeStats } from "@/server/stats";
import { commitPatch } from "@/server/commit";
import { getFileDetail, listFileSummaries, recoverExpiredLeases } from "@/server/queries";
import type { BatchEvent } from "@/lib/contracts";

let root: string;
let outside: string;
let client: PGlite;
let db: AppDb;

const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" }).toString().trim();

before(async () => {
  const base = mkdtempSync(path.join(tmpdir(), "aetherops-"));
  root = path.join(base, "repo");
  outside = path.join(base, "outside");
  mkdirSync(path.join(root, "src", "nested"), { recursive: true });
  mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
  mkdirSync(path.join(root, "build"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(outside, "secret.txt"), "top secret");
  writeFileSync(path.join(root, ".gitignore"), "build/\n*.log\n");
  writeFileSync(path.join(root, "src", "nested", ".gitignore"), "generated.ts\n");
  writeFileSync(path.join(root, "src", "app.js"), "const total = eval(expr);\r\nmodule.exports = total;\r\n");
  writeFileSync(path.join(root, "src", "clean.ts"), "export const add = (a: number, b: number) => a + b;\n");
  writeFileSync(path.join(root, "src", "nested", "generated.ts"), "export const x = 1;\n");
  writeFileSync(path.join(root, "src", "nested", "keep.py"), "def f(items=[]):\n    return items\n");
  writeFileSync(path.join(root, "node_modules", "dep", "index.js"), "eval('x')");
  writeFileSync(path.join(root, "build", "out.js"), "eval('x')");
  writeFileSync(path.join(root, "debug.log"), "noise");
  writeFileSync(path.join(root, ".env"), "SECRET=abc123456789");
  writeFileSync(path.join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  process.env.AETHEROPS_ALLOWED_ROOTS = root;
  delete process.env.GEMINI_API_KEY;

  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init");

  client = new PGlite();
  db = drizzle(client, { schema }) as unknown as AppDb;
  await migrate(drizzle(client), { migrationsFolder: path.resolve("drizzle") });
});

after(async () => {
  await client.close();
  rmSync(path.dirname(root), { recursive: true, force: true });
});

test("walker honours nested .gitignore, ignored dirs, sensitive and binary files", async () => {
  const walk = await walkWorkspace(root);
  assert.deepEqual(walk.files.map((f) => f.path), [".gitignore", "src/app.js", "src/clean.ts", "src/nested/.gitignore", "src/nested/keep.py"]);
  assert.equal(walk.skipped.sensitive, 1);
  assert.ok(walk.skipped.binary >= 1);
  assert.equal(walk.files.find((f) => f.path === "src/app.js")!.eol, "crlf");
});

test("path boundary checks reject traversal and absolute escapes", async () => {
  await assert.rejects(resolveInside(root, "../outside/secret.txt"), /Unsafe path|escapes/);
  await assert.rejects(resolveInside(root, path.join(outside, "secret.txt")), /Unsafe path/);
  assert.equal(await resolveInside(root, "src/app.js"), path.join(realpathSync.native(root), "src", "app.js"));
});

test("atomic write refuses on disk drift and verifies the result", async () => {
  const rel = "src/clean.ts";
  const original = readFileSync(path.join(root, rel), "utf8");
  await assert.rejects(writeWorkspaceFileAtomic(root, rel, "x", "0".repeat(64)), /changed on disk/);
  const newHash = await writeWorkspaceFileAtomic(root, rel, original, await sha256Hex(original));
  assert.equal(newHash, await sha256Hex(original));
});

test("sync → delta re-sync → batch scan → stats → commit → git", async () => {
  const ws = await createWorkspace(db, { kind: "server", rootPath: root });
  assert.equal(ws.isGitRepo, true);

  const first = await applySync(db, ws, (await walkWorkspace(root)).files, { prune: true });
  assert.equal(first.added, 5);
  assert.ok(first.findings >= 2, "eval + mutable default");

  const second = await applySync(db, ws, (await walkWorkspace(root)).files, { prune: true });
  assert.deepEqual({ added: second.added, updated: second.updated, unchanged: second.unchanged }, { added: 0, updated: 0, unchanged: 5 });

  writeFileSync(path.join(root, "src", "nested", "keep.py"), "def f(items=None):\n    return items or []\n");
  rmSync(path.join(root, "src", "clean.ts"));
  const third = await applySync(db, ws, (await walkWorkspace(root)).files, { prune: true });
  assert.equal(third.updated, 1);
  assert.equal(third.removed, 1);

  const summaries = await listFileSummaries(db, ws.id);
  const app = summaries.find((f) => f.path === "src/app.js")!;
  assert.equal(app.status, "issues");
  assert.equal(app.criticalIssues, 1);
  assert.equal(summaries.find((f) => f.path === "src/nested/keep.py")!.openIssues, 0);

  // Lease: a second concurrent claim is rejected until the first is released or expires.
  await acquireLease(db, app.id);
  await assert.rejects(acquireLease(db, app.id), /already being analyzed/);
  await db.update(schema.files).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.files.id, app.id));
  assert.equal(await recoverExpiredLeases(db, ws.id), 1);

  const events: BatchEvent[] = [];
  await runBatch(db, ws.id, "all", "heuristic", (e) => events.push(e));
  assert.equal(events[0].type, "start");
  assert.equal(events.at(-1)!.type, "done");
  assert.equal(events.filter((e) => e.type === "file").length, 4);

  const analysis = await analyzeFile(db, app.id, "hybrid"); // no AI key: deterministic fallback
  assert.equal(analysis.engine, "heuristic");
  assert.equal(analysis.file.status, "issues");

  const stats = await computeStats(db, ws.id);
  assert.equal(stats.files.total, 4);
  assert.equal(stats.coveragePct, 100);
  assert.equal(stats.openIssues.bySeverity.critical, 1);
  assert.ok(stats.healthIndex !== null && stats.healthIndex < 100 && stats.healthIndex > 0);
  assert.ok(stats.scanLatency.samples > 0);

  // Simulate a reviewed AI patch for the current content, then commit it.
  const detail = await getFileDetail(db, app.id);
  const patched = "const total = JSON.parse(expr);\r\nmodule.exports = total;\r\n";
  await db.update(schema.files).set({ correctedContent: patched, correctedForHash: detail.contentHash, engine: "hybrid", modelUsed: "fake" }).where(eq(schema.files.id, app.id));

  await assert.rejects(commitPatch(db, { fileId: app.id, baseHash: "f".repeat(64), git: false }), /older version/);
  const result = await commitPatch(db, { fileId: app.id, baseHash: detail.contentHash, git: true });
  assert.equal(readFileSync(path.join(root, "src", "app.js"), "utf8"), patched);
  assert.equal(result.newHash, await sha256Hex(patched));
  assert.ok(result.issuesFixed >= 1);
  assert.ok(result.gitSha, result.gitError ?? "no sha");
  assert.match(git("log", "-1", "--format=%s"), /fix\(aetherops\): remediate \d+ issues? in src\/app\.js/);
  assert.equal(result.file.status, "clean");
  assert.ok(result.file.issues.some((i) => i.status === "fixed"));

  // A second commit of the same patch is refused: it no longer applies to the current content.
  await assert.rejects(commitPatch(db, { fileId: app.id, baseHash: result.newHash, git: false }), /No patch/);
});

test("browser manifest prunes vanished files and requests only changed content", async () => {
  const ws = await createWorkspace(db, { kind: "browser", name: "demo" });
  const a = { path: "a.js", hash: await sha256Hex("a") };
  const b = { path: "b.js", hash: await sha256Hex("b") };
  assert.deepEqual((await applyManifest(db, ws, [a, b])).needed, ["a.js", "b.js"]);
  await applySync(db, ws, [
    { path: "a.js", content: "a", hash: a.hash, size: 1, language: "javascript", extension: "js", eol: "lf", lineCount: 1 },
    { path: "b.js", content: "b", hash: b.hash, size: 1, language: "javascript", extension: "js", eol: "lf", lineCount: 1 },
  ], { prune: false });
  const res = await applyManifest(db, ws, [a]);
  assert.deepEqual(res, { needed: [], removed: 1, unchanged: 1 });
});

test("sample project: seeded once, patch applies in the database only, reset restores originals", async () => {
  const { ensureDemoWorkspace, resetDemoWorkspace } = await import("@/server/demo");
  const { SAMPLE_FILES } = await import("@/demo/samples");
  globalThis.__aetherDemoReady = undefined;
  await ensureDemoWorkspace(db);
  globalThis.__aetherDemoReady = undefined;
  await ensureDemoWorkspace(db); // idempotent
  const demos = await db.select().from(schema.workspaces).where(eq(schema.workspaces.kind, "demo"));
  assert.equal(demos.length, 1);
  const ws = demos[0];

  const summaries = await listFileSummaries(db, ws.id);
  assert.deepEqual(summaries.map((f) => f.path).sort(), SAMPLE_FILES.map((f) => f.path).sort());
  assert.ok(summaries.every((f) => f.openIssues > 0), "every sample file has findings");

  const target = summaries.find((f) => f.path.endsWith(".py"))!;
  const detail = await getFileDetail(db, target.id);
  const patched = detail.content.replace("batch_sise", "batch_size");
  await db.update(schema.files).set({ correctedContent: patched, correctedForHash: detail.contentHash }).where(eq(schema.files.id, target.id));
  const result = await commitPatch(db, { fileId: target.id, baseHash: detail.contentHash, git: true });
  assert.equal(result.gitSha, null);
  assert.match(result.gitError ?? "", /server-mode/);
  assert.ok(!result.file.issues.some((i) => i.status === "open" && i.ruleId === "PY-NAME-001"));

  await resetDemoWorkspace(db, ws);
  const restored = await listFileSummaries(db, ws.id);
  const py = await getFileDetail(db, restored.find((f) => f.path.endsWith(".py"))!.id);
  assert.ok(py.content.includes("batch_sise"));
  assert.ok(py.issues.every((i) => i.status === "open"), "history cleared on reset");
});
