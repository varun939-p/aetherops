import { test } from "node:test";
import assert from "node:assert/strict";
import { GoogleGenerativeAIFetchError } from "@google/generative-ai";
import { analyzeDeep, chunkLines, parseChunkResponse, selectEdits, withBackoff } from "@/lib/ai";
import { applyLineEdits, PatchConflictError, sha256Hex } from "@/lib/text";
import { buildDiff } from "@/lib/diff-rows";
import { normalizeRelativePath, isSensitiveFile } from "@/lib/policy";

test("applyLineEdits preserves CRLF and trailing newline", () => {
  const src = "a\r\nb\r\nc\r\n";
  assert.equal(applyLineEdits(src, [{ startLine: 2, endLine: 2, replacement: "B1\nB2" }]), "a\r\nB1\r\nB2\r\nc\r\n");
  assert.equal(applyLineEdits("x\ny", [{ startLine: 1, endLine: 0, replacement: "top" }]), "top\nx\ny");
  assert.equal(applyLineEdits("x\ny\n", [{ startLine: 2, endLine: 2, replacement: "" }]), "x\n");
});

test("applyLineEdits rejects overlap and out-of-range edits", () => {
  assert.throws(() => applyLineEdits("a\nb\nc", [{ startLine: 1, endLine: 2, replacement: "" }, { startLine: 2, endLine: 3, replacement: "" }]), PatchConflictError);
  assert.throws(() => applyLineEdits("a", [{ startLine: 3, endLine: 3, replacement: "" }]), PatchConflictError);
});

test("selectEdits drops conflicting edits deterministically", () => {
  const { accepted, dropped } = selectEdits(
    [
      { startLine: 5, endLine: 6, replacement: "x" },
      { startLine: 1, endLine: 2, replacement: "y" },
      { startLine: 2, endLine: 3, replacement: "z" },
      { startLine: 99, endLine: 99, replacement: "w" },
    ],
    10
  );
  assert.deepEqual(accepted.map((e) => e.startLine), [1, 5]);
  assert.equal(dropped, 2);
});

test("chunkLines covers every line exactly once within budget", () => {
  const lines = Array.from({ length: 2000 }, (_, i) => (i % 40 === 0 ? "" : `const v${i} = compute(${i}); // padding padding padding`));
  const chunks = chunkLines(lines, 1500);
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[chunks.length - 1].endLine, 2000);
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i].startLine, chunks[i - 1].endLine + 1);
});

test("parseChunkResponse enforces the schema and tolerates fences", () => {
  const ok = parseChunkResponse('```json\n{"summary":"s","qualityScore":"80","issues":[],"edits":[]}\n```');
  assert.equal(ok.qualityScore, 80);
  assert.throws(() => parseChunkResponse("not json"));
  assert.throws(() => parseChunkResponse('{"summary":"s","qualityScore":1,"issues":[{"line":"x"}],"edits":[]}'));
});

test("withBackoff retries 429/5xx with jitter and gives up on 4xx", async () => {
  let calls = 0;
  const { value, attempts } = await withBackoff(
    async () => {
      calls++;
      if (calls < 3) throw new GoogleGenerativeAIFetchError("rate limited", 429);
      return "ok";
    },
    { maxAttempts: 4, baseMs: 1, capMs: 2, deadline: Date.now() + 5000 }
  );
  assert.equal(value, "ok");
  assert.equal(attempts, 3);

  let badCalls = 0;
  await assert.rejects(
    withBackoff(
      async () => {
        badCalls++;
        throw new GoogleGenerativeAIFetchError("bad key", 400);
      },
      { maxAttempts: 4, baseMs: 1, capMs: 2, deadline: Date.now() + 5000 }
    )
  );
  assert.equal(badCalls, 1);
});

test("analyzeDeep falls back to heuristics without a provider", async () => {
  const r = await analyzeDeep("const x = eval(y);\n", "a.js", "javascript", { config: null });
  assert.equal(r.engine, "heuristic");
  assert.equal(r.aiError, null);
  assert.equal(r.correctedContent, null);
  assert.ok(r.findings.some((f) => f.ruleId === "SEC-INJ-001"));
});

test("analyzeDeep applies range edits per chunk and never truncates", async () => {
  const lines = Array.from({ length: 400 }, (_, i) => `line_${i + 1} = ${i};`);
  lines[199] = "danger = eval(input);";
  const content = lines.join("\n") + "\n";
  process.env.AETHEROPS_AI_CHUNK_TOKENS = "800"; // force several chunks
  const calls: number[] = [];
  const r = await analyzeDeep(content, "big.py", "python", {
    config: { apiKey: "test", model: "fake-model" },
    call: async (prompt) => {
      const [, start, end] = /lines (\d+)-(\d+)/.exec(prompt)!.map(Number);
      calls.push(start);
      const edits = start <= 200 && end >= 200 ? [{ startLine: 200, endLine: 200, replacement: "danger = ast.literal_eval(input)" }] : [];
      // An edit outside the chunk must be ignored.
      edits.push({ startLine: end + 5, endLine: end + 5, replacement: "outside" });
      return { summary: `chunk ${start}`, qualityScore: 90, issues: [], edits };
    },
  });
  delete process.env.AETHEROPS_AI_CHUNK_TOKENS;
  assert.ok(calls.length > 1, `expected multiple chunks, got ${calls.length}`);
  assert.equal(r.engine, "hybrid");
  assert.ok(r.coverage.complete);
  const out = r.correctedContent!.split("\n");
  assert.equal(out.length, 401);
  assert.equal(out[199], "danger = ast.literal_eval(input)");
  assert.equal(out[0], "line_1 = 0;");
  assert.equal(out[399], "line_400 = 399;");
});

test("analyzeDeep reports total provider failure as aiError with heuristic findings", async () => {
  const r = await analyzeDeep("x = eval(y)\n", "a.py", "python", {
    config: { apiKey: "k", model: "m" },
    deadline: Date.now() + 2000,
    call: async () => {
      throw new GoogleGenerativeAIFetchError("forbidden", 403);
    },
  });
  assert.equal(r.engine, "heuristic");
  assert.match(r.aiError ?? "", /403/);
  assert.ok(r.findings.length > 0);
});

test("diff model counts and collapses context", () => {
  const before = Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n");
  const after = before.replace("l25", "L25");
  const d = buildDiff(before, after);
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.ok(d.unified.some((r) => r.kind === "gap"));
  assert.ok(d.unified.length < 20);
});

test("policy: path normalization and sensitive files", async () => {
  assert.equal(normalizeRelativePath("src\\a\\b.ts"), "src/a/b.ts");
  assert.equal(normalizeRelativePath("../etc/passwd"), null);
  assert.equal(normalizeRelativePath("C:/Windows/x"), null);
  assert.equal(normalizeRelativePath("/abs"), null);
  assert.equal(normalizeRelativePath("a/../../b"), null);
  assert.ok(isSensitiveFile(".env"));
  assert.ok(isSensitiveFile(".env.production"));
  assert.ok(!isSensitiveFile(".env.example"));
  assert.ok(isSensitiveFile("server.pem"));
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
