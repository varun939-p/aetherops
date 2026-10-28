import { test } from "node:test";
import assert from "node:assert/strict";
import { scanSource } from "@/lib/heuristic";

const ids = (content: string, language: string) => scanSource(content, language).findings.map((f) => f.ruleId);

test("flags dynamic code execution, but not inside strings or comments", () => {
  assert.deepEqual(ids("const r = eval(input);", "javascript"), ["SEC-INJ-001"]);
  assert.deepEqual(ids('// eval(x) is dangerous\nconst s = "eval(x)";', "javascript"), []);
  assert.ok(ids("result = eval(expr)", "python").includes("SEC-INJ-001"));
});

test("SQL injection via template literal and concatenation; tagged templates are safe", () => {
  assert.ok(ids("await db.query(`SELECT * FROM users WHERE id = ${id}`);", "typescript").includes("SEC-INJ-004"));
  assert.ok(ids("db.query('SELECT * FROM t WHERE a = ' + a);", "javascript").includes("SEC-INJ-004"));
  assert.ok(!ids("await db.execute(sql`select * from t where id = ${id}`);", "typescript").includes("SEC-INJ-004"));
  assert.ok(ids('cursor.execute(f"SELECT * FROM t WHERE id = {uid}")', "python").includes("SEC-INJ-004"));
  assert.ok(!ids('cursor.execute("SELECT * FROM t WHERE id = %s", (uid,))', "python").includes("SEC-INJ-004"));
});

test("command injection requires a shell-string sink", () => {
  const js = 'import { exec } from "child_process";\nexec(`git log ${branch}`);';
  assert.ok(ids(js, "javascript").includes("SEC-INJ-002"));
  assert.ok(!ids("const m = /x/.exec(`a${b}`);", "javascript").includes("SEC-INJ-002"));
  assert.ok(ids('os.system("rm -rf " + path)', "python").includes("SEC-INJ-002"));
});

test("hardcoded secrets are masked in the message; placeholders are ignored", () => {
  const f = scanSource('const API_KEY = "sk-live9f8a7b6c5d4e3f2a1b0c";', "javascript").findings.find((x) => x.ruleId === "SEC-SECRET-001");
  assert.ok(f);
  assert.ok(!f!.message.includes("9f8a7b6c5d4e3f2a1b0c"));
  assert.deepEqual(ids('GEMINI_API_KEY="your_gemini_api_key_here"', "plaintext"), []);
  assert.ok(ids("aws = 'AKIAIOSFODNN7EXAMPLE'", "python").includes("SEC-SECRET-001"));
});

test("TLS verification disabled", () => {
  assert.ok(ids("new Pool({ ssl: { rejectUnauthorized: false } })", "typescript").includes("SEC-TLS-001"));
  assert.ok(ids("requests.get(url, verify=False, timeout=5)", "python").includes("SEC-TLS-001"));
});

test("unhandled promise chain vs handled", () => {
  assert.ok(ids("fetchUser(id).then((u) => render(u));", "javascript").includes("SRE-ASYNC-001"));
  assert.ok(!ids("fetchUser(id).then((u) => render(u)).catch(report);", "javascript").includes("SRE-ASYNC-001"));
  assert.ok(!ids("return fetchUser(id).then((u) => u.name);", "javascript").includes("SRE-ASYNC-001"));
});

test("async forEach, swallowed errors, undeclared loop variables", () => {
  assert.ok(ids("items.forEach(async (i) => { await save(i); });", "javascript").includes("SRE-ASYNC-002"));
  assert.ok(ids("try { run(); } catch (e) {}", "javascript").includes("SRE-ERR-001"));
  assert.ok(ids("for (item of cart) { total += item.price; }", "javascript").includes("REL-JS-001"));
  assert.ok(!ids("for (const item of cart) { total += item.price; }", "javascript").includes("REL-JS-001"));
});

test("blocking I/O only inside async functions", () => {
  const inside = "async function load() {\n  const raw = fs.readFileSync(p, 'utf8');\n  return raw;\n}";
  const outside = "function load() {\n  return fs.readFileSync(p, 'utf8');\n}";
  assert.ok(ids(inside, "javascript").includes("SRE-IO-001"));
  assert.ok(!ids(outside, "javascript").includes("SRE-IO-001"));
  assert.ok(ids("async def handler():\n    time.sleep(2)\n", "python").includes("SRE-IO-001"));
});

test("N+1 queries inside loops", () => {
  const js = "for (const id of ids) {\n  const row = await db.select().from(users).where(eq(users.id, id));\n}";
  assert.ok(ids(js, "typescript").includes("PERF-DB-001"));
  assert.ok(!ids("const rows = await db.select().from(users);", "typescript").includes("PERF-DB-001"));
  assert.ok(ids("for u in users:\n    cursor.execute('SELECT 1 WHERE id = %s', (u,))\n", "python").includes("PERF-DB-001"));
});

test("HTTP calls without timeouts", () => {
  assert.ok(ids("const r = await fetch(url);", "javascript").includes("SRE-NET-001"));
  assert.ok(!ids("const r = await fetch(url, { signal: AbortSignal.timeout(5000) });", "javascript").includes("SRE-NET-001"));
  assert.ok(ids("r = requests.get(url)", "python").includes("SRE-NET-001"));
  assert.ok(!ids("r = requests.get(url, timeout=5)", "python").includes("SRE-NET-001"));
});

test("unbounded module-level collections and lazy-init races", () => {
  const leak = "const cache = new Map();\nexport function remember(k, v) {\n  cache.set(k, v);\n}";
  assert.ok(ids(leak, "javascript").includes("SRE-MEM-002"));
  const bounded = leak + "\nexport function evict(k) {\n  cache.delete(k);\n}";
  assert.ok(!ids(bounded, "javascript").includes("SRE-MEM-002"));
  const race = "let client;\nasync function get() {\n  if (!client) {\n    client = await connect();\n  }\n  return client;\n}";
  assert.ok(ids(race, "javascript").includes("SRE-CONC-001"));
});

test("python typo detectors catch the demo bugs generically", () => {
  const src = [
    "import logging",
    "class Logger:",
    "    def __init__(self, level):",
    "        self.level = levl",
    "    def log(self, message):",
    "        logging.infos(message)",
    "def main():",
    "    logger = Logger('info')",
    "    logger.logg('x')",
  ].join("\n");
  const findings = scanSource(src, "python").findings;
  const messages = findings.map((f) => `${f.ruleId}@${f.line}`);
  assert.ok(messages.includes("PY-NAME-001@4"), messages.join(","));
  assert.ok(messages.includes("PY-ATTR-001@6"));
  assert.ok(messages.includes("PY-ATTR-001@9"));

  const student = "class Student:\n    def __init__(self, name):\n        self.nam = name\n    def __str__(self):\n        return f'{self.name}'\n";
  // self.name inside an f-string is a literal for the lexer; the attribute rule must not crash on it.
  assert.doesNotThrow(() => scanSource(student, "python"));
});

test("clean code produces no findings and reports exact spans", () => {
  const clean = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
  assert.deepEqual(scanSource(clean, "typescript").findings, []);
  const [f] = scanSource("const x = eval(y);", "javascript").findings;
  assert.equal(f.line, 1);
  assert.equal(f.column, 11);
  assert.ok(f.endColumn > f.column);
  assert.ok(f.remediation.length > 10);
});

test("findings are ordered critical first", () => {
  const src = "if (a == b) {}\nconst k = eval(c);";
  const sev = scanSource(src, "javascript").findings.map((f) => f.severity);
  assert.equal(sev[0], "critical");
});
