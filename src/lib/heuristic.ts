import { lexLines, codeView, noCommentView } from "./lexer";
import { splitLines } from "./text";
import type { IssueCategory, IssueSeverity } from "@/db/schema";

/**
 * Deterministic SRE / security analyzer. Rules run on lexed lines so nothing fires inside comments or
 * string literals unless a rule explicitly inspects literals (secrets, injection). Every finding carries
 * a stable rule ID, exact line/column span, and a concrete remediation.
 */

export interface Finding {
  ruleId: string;
  title: string;
  category: IssueCategory;
  severity: IssueSeverity;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  message: string;
  remediation: string;
  source: "heuristic";
}

export interface HeuristicResult {
  findings: Finding[];
  durationMs: number;
  rulesEvaluated: number;
}

type Family = "js" | "python" | "other";

interface Scope {
  inAsync: boolean;
  inLoop: boolean;
  depth: number;
}

interface Context {
  language: string;
  family: Family;
  raw: string[];
  code: string[];
  literal: string[];
  scope: Scope[];
  content: string;
}

interface RuleMeta {
  id: string;
  title: string;
  category: IssueCategory;
  severity: IssueSeverity;
  families: Family[] | "all";
  remediation: string;
}

type Emit = (line: number, column: number, length: number, message: string, overrides?: Partial<Pick<Finding, "severity" | "remediation">>) => void;

interface Rule extends RuleMeta {
  run: (ctx: Context, emit: Emit) => void;
}

const JS_LANGUAGES = new Set(["javascript", "typescript", "vue", "svelte"]);

function familyOf(language: string): Family {
  if (JS_LANGUAGES.has(language)) return "js";
  if (language === "python") return "python";
  return "other";
}

// ---------------------------------------------------------------------------------------------
// Scope tracking (async functions and loop bodies)
// ---------------------------------------------------------------------------------------------

interface BraceFrame {
  async: boolean;
  loop: boolean;
  boundary: boolean;
}

function jsScopes(code: string[]): Scope[] {
  const stack: BraceFrame[] = [];
  let pendingAsync = false;
  let pendingLoop = false;
  let pendingBoundary = false;
  const out: Scope[] = [];

  const current = (): Scope => {
    let inAsync = false;
    let inLoop = false;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].async) inAsync = true;
      if (stack[i].loop) inLoop = true;
      if (stack[i].boundary) break;
    }
    return { inAsync, inLoop, depth: stack.length };
  };

  for (const line of code) {
    out.push(current());
    const tokens = line.matchAll(/\basync\b|\bfunction\b|\bfor\s*(?:await\s*)?\(|\bwhile\s*\(|\.(?:forEach|map|flatMap|filter|reduce|some|every)\s*\(|=>|[{};]/g);
    for (const match of tokens) {
      const tok = match[0];
      if (tok === "async") pendingAsync = true;
      else if (tok === "function" || tok === "=>") pendingBoundary = true;
      else if (tok === "{") {
        stack.push({ async: pendingAsync, loop: pendingLoop, boundary: pendingBoundary || pendingAsync });
        pendingAsync = pendingLoop = pendingBoundary = false;
      } else if (tok === "}") stack.pop();
      else if (tok === ";") pendingAsync = pendingLoop = pendingBoundary = false;
      else pendingLoop = true;
    }
    // Statement-level scopes for following lines are approximated by the stack; the per-line
    // state recorded above reflects the scope at the start of the line, refined below.
    out[out.length - 1] = mergeScope(out[out.length - 1], current());
  }
  return out;
}

function mergeScope(start: Scope, end: Scope): Scope {
  // A line that opens a scope (e.g. `for (...) { await x() }`) belongs to both; prefer the inner view.
  return { inAsync: start.inAsync || end.inAsync, inLoop: start.inLoop || end.inLoop, depth: Math.max(start.depth, end.depth) };
}

interface IndentFrame {
  indent: number;
  async: boolean;
  loop: boolean;
  boundary: boolean;
}

function pythonScopes(code: string[]): Scope[] {
  const stack: IndentFrame[] = [];
  const out: Scope[] = [];
  for (const line of code) {
    if (line.trim() === "") {
      const top = current();
      out.push(top);
      continue;
    }
    const indent = line.length - line.trimStart().length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    out.push(current());
    const trimmed = line.trim();
    if (/^async\s+def\b.*:\s*$/.test(trimmed)) stack.push({ indent, async: true, loop: false, boundary: true });
    else if (/^def\b.*:\s*$/.test(trimmed) || /^class\b.*:\s*$/.test(trimmed)) stack.push({ indent, async: false, loop: false, boundary: true });
    else if (/^(async\s+)?(for|while)\b.*:\s*$/.test(trimmed)) stack.push({ indent, async: false, loop: true, boundary: false });
  }
  return out;

  function current(): Scope {
    let inAsync = false;
    let inLoop = false;
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].async) inAsync = true;
      if (stack[i].loop) inLoop = true;
      if (stack[i].boundary) break;
    }
    return { inAsync, inLoop, depth: stack.length };
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

export function levenshtein(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

function nearMiss(name: string, candidates: Iterable<string>): string | null {
  const limit = name.length >= 7 ? 2 : 1;
  let best: string | null = null;
  let bestDistance = limit + 1;
  for (const c of candidates) {
    if (c === name || c.length < 3) continue;
    const d = levenshtein(name, c, limit);
    if (d <= limit && d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best;
}

/** Joins the statement starting at `start` until parentheses balance (bounded lookahead). */
function statementWindow(code: string[], start: number, from: number, maxLines = 12): string {
  let depth = 0;
  let text = "";
  for (let i = start; i < Math.min(code.length, start + maxLines); i++) {
    const segment = i === start ? code[i].slice(from) : code[i];
    for (const ch of segment) {
      text += ch;
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth <= 0) return text;
      }
    }
    text += "\n";
  }
  return text;
}

function eachMatch(text: string, re: RegExp, fn: (m: RegExpExecArray) => void) {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  let m: RegExpExecArray | null;
  while ((m = global.exec(text))) {
    fn(m);
    if (m[0].length === 0) global.lastIndex++;
  }
}

const PLACEHOLDER = /^(your|my|xxx|changeme|change_me|example|placeholder|dummy|sample|test|todo|redacted|none|null|undefined|<|\$\{|\{\{|%\(|process\.env|os\.environ|\*+$|\.+$)/i;

function maskSecret(value: string): string {
  return value.length <= 6 ? "***" : `${value.slice(0, 4)}…(${value.length} chars)`;
}

const PY_BUILTINS = new Set(
  "abs all any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip __name__ __file__ __doc__ __init__ self cls True False None Exception ValueError TypeError KeyError IndexError AttributeError RuntimeError NameError OSError IOError StopIteration NotImplementedError ZeroDivisionError FileNotFoundError PermissionError TimeoutError ImportError".split(" ")
);

const PY_KEYWORDS = new Set(
  "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case True False None".split(" ")
);

const KNOWN_APIS: Record<Family, Record<string, string[]>> = {
  python: {
    logging: ["debug", "info", "warning", "warn", "error", "exception", "critical", "fatal", "log", "basicConfig", "getLogger", "Logger", "Handler", "StreamHandler", "FileHandler", "Formatter", "disable", "captureWarnings", "DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
    json: ["dumps", "loads", "dump", "load", "JSONDecodeError", "JSONEncoder", "JSONDecoder"],
    os: ["path", "environ", "getenv", "listdir", "makedirs", "mkdir", "remove", "rename", "replace", "walk", "getcwd", "chdir", "system", "popen", "sep", "stat", "unlink", "rmdir", "scandir", "cpu_count", "urandom", "kill", "getpid"],
    time: ["time", "sleep", "monotonic", "perf_counter", "strftime", "strptime", "localtime", "gmtime", "time_ns", "process_time"],
    math: ["sqrt", "floor", "ceil", "pow", "log", "log10", "log2", "exp", "sin", "cos", "tan", "pi", "e", "inf", "nan", "isnan", "isinf", "isclose", "fabs", "gcd", "factorial", "hypot", "trunc"],
  },
  js: {
    console: ["log", "info", "warn", "error", "debug", "trace", "table", "dir", "group", "groupEnd", "groupCollapsed", "time", "timeEnd", "timeLog", "assert", "count", "countReset", "clear"],
    Math: ["abs", "ceil", "floor", "round", "max", "min", "pow", "sqrt", "random", "trunc", "sign", "log", "log2", "log10", "exp", "sin", "cos", "tan", "atan2", "hypot", "cbrt", "PI", "E", "fround", "clz32", "imul"],
    JSON: ["parse", "stringify"],
    Object: ["keys", "values", "entries", "assign", "freeze", "create", "defineProperty", "fromEntries", "getPrototypeOf", "setPrototypeOf", "is", "hasOwn", "getOwnPropertyNames", "seal", "groupBy"],
    Promise: ["all", "allSettled", "any", "race", "resolve", "reject", "withResolvers"],
    Array: ["isArray", "from", "of"],
    Number: ["isFinite", "isInteger", "isNaN", "parseFloat", "parseInt", "isSafeInteger", "MAX_SAFE_INTEGER", "MIN_SAFE_INTEGER", "EPSILON"],
  },
  other: {},
};

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

const RULES: Rule[] = [
  {
    id: "SEC-INJ-001",
    title: "Dynamic code execution",
    category: "security",
    severity: "critical",
    families: ["js", "python"],
    remediation: "Remove dynamic evaluation. Parse data with JSON.parse / ast.literal_eval, or dispatch through an explicit lookup table of allowed operations.",
    run(ctx, emit) {
      const re = ctx.family === "js" ? /\beval\s*\(|\bnew\s+Function\s*\(/ : /(?<![\w.])(eval|exec)\s*\(/;
      ctx.code.forEach((line, i) =>
        eachMatch(line, re, (m) => emit(i, m.index, m[0].length, `${m[0].replace(/\s*\($/, "")}() executes arbitrary code; any attacker-influenced input becomes remote code execution.`))
      );
    },
  },
  {
    id: "SEC-INJ-002",
    title: "Shell command injection",
    category: "security",
    severity: "critical",
    families: ["js", "python"],
    remediation: "Never build shell strings. Use execFile/spawn (JS) or subprocess.run([...], shell=False) (Python) with an argument array, and validate inputs against an allow-list.",
    run(ctx, emit) {
      if (ctx.family === "js") {
        if (!/child_process/.test(ctx.content)) return;
        ctx.literal.forEach((line, i) => {
          eachMatch(line, /\b(exec|execSync)\s*\(\s*(`[^`]*\$\{|["'][^"']*["']\s*\+|[A-Za-z_$][\w$.]*\s*\+)/, (m) =>
            emit(i, m.index, m[1].length, `${m[1]}() runs its argument through a shell; the interpolated value can inject arbitrary commands.`)
          );
          eachMatch(line, /\bspawn(Sync)?\s*\([^)]*shell\s*:\s*true/, (m) =>
            emit(i, m.index, 5, "spawn() with shell: true re-enables shell parsing of arguments.", { severity: "high" })
          );
        });
      } else {
        ctx.literal.forEach((line, i) => {
          eachMatch(line, /\bos\.(system|popen)\s*\(\s*(f["']|[^)]*(\+|%|\.format\())/, (m) =>
            emit(i, m.index, m[0].length, `os.${m[1]}() with an interpolated string executes attacker-controllable shell syntax.`)
          );
          eachMatch(line, /\bsubprocess\.(run|call|Popen|check_output|check_call)\s*\([^)]*shell\s*=\s*True/, (m) =>
            emit(i, m.index, m[0].length, `subprocess.${m[1]}(shell=True) passes the command through /bin/sh.`, { severity: /\(\s*f["']/.test(m[0]) ? "critical" : "high" })
          );
        });
      }
    },
  },
  {
    id: "SEC-INJ-004",
    title: "SQL built by string interpolation",
    category: "security",
    severity: "critical",
    families: ["js", "python"],
    remediation: "Use bound parameters: db.query('... WHERE id = $1', [id]) / cursor.execute('... WHERE id = %s', (id,)), or a query builder's tagged template.",
    run(ctx, emit) {
      const re =
        ctx.family === "js"
          ? /\.(query|execute|raw|unsafe|\$queryRawUnsafe|\$executeRawUnsafe)\s*\(\s*(`[^`]*\b(select|insert|update|delete|from|where)\b[^`]*\$\{|["'][^"']*\b(select|insert|update|delete)\b[^"']*["']\s*\+)/i
          : /\.(execute|executemany|raw)\s*\(\s*(f["'][^"']*\b(select|insert|update|delete)\b|["'][^"']*\b(select|insert|update|delete)\b[^"']*["']\s*(%|\+|\.format\())/i;
      ctx.literal.forEach((line, i) =>
        eachMatch(line, re, (m) => emit(i, m.index + 1, m[1].length, `.${m[1]}() receives SQL assembled from runtime values; this is an injection vector.`))
      );
    },
  },
  {
    id: "SEC-XSS-001",
    title: "Unsanitized HTML sink",
    category: "security",
    severity: "high",
    families: ["js"],
    remediation: "Assign textContent instead of innerHTML, or sanitize with DOMPurify.sanitize() before inserting markup.",
    run(ctx, emit) {
      ctx.code.forEach((line, i) => {
        eachMatch(line, /\.(innerHTML|outerHTML)\s*\+?=(?!=)/, (m) => emit(i, m.index + 1, m[1].length, `Assigning to ${m[1]} renders markup; unsanitized input enables XSS.`));
        eachMatch(line, /\bdocument\.write(ln)?\s*\(/, (m) => emit(i, m.index, m[0].length - 1, "document.write() injects raw markup into the page."));
        eachMatch(line, /\bdangerouslySetInnerHTML\b/, (m) =>
          emit(i, m.index, m[0].length, "dangerouslySetInnerHTML bypasses React escaping; the value must be sanitized.", { severity: "medium" })
        );
      });
    },
  },
  {
    id: "SEC-SECRET-001",
    title: "Hardcoded credential",
    category: "security",
    severity: "critical",
    families: "all",
    remediation: "Move the value to an environment variable or secret manager, rotate the exposed credential, and purge it from version-control history.",
    run(ctx, emit) {
      const known: Array<[RegExp, string]> = [
        [/AKIA[0-9A-Z]{16}/, "AWS access key ID"],
        [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "GitHub token"],
        [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
        [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
        [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/, "API secret key"],
        [/-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, "private key"],
        [/\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:[^\s@"'/]{6,}@/, "credentials embedded in a connection URL"],
      ];
      const assignment = /\b([A-Za-z_]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|client[_-]?secret|access[_-]?key|private[_-]?key)[A-Za-z0-9_]*)["']?\s*[:=]\s*["'`]([^"'`\s]{8,})["'`]/i;
      ctx.raw.forEach((line, i) => {
        for (const [re, label] of known) {
          const m = re.exec(line);
          if (m) {
            emit(i, m.index, m[0].length, `${label} committed in source (${maskSecret(m[0])}).`);
            return;
          }
        }
        const m = assignment.exec(line);
        if (m && !PLACEHOLDER.test(m[2]) && !/_here$|example|^x+$/i.test(m[2]) && /[0-9]/.test(m[2]) && /[A-Za-z]/.test(m[2])) {
          emit(i, m.index, m[0].length, `${m[1]} is assigned a literal credential (${maskSecret(m[2])}).`);
        }
      });
    },
  },
  {
    id: "SEC-TLS-001",
    title: "TLS certificate verification disabled",
    category: "security",
    severity: "high",
    families: "all",
    remediation: "Keep certificate verification on. Supply the CA bundle (ca: fs.readFileSync(...) / verify='/path/ca.pem') instead of disabling checks.",
    run(ctx, emit) {
      const re = /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|\bverify\s*=\s*False\b|InsecureSkipVerify\s*:\s*true/;
      ctx.code.forEach((line, i) => eachMatch(line, re, (m) => emit(i, m.index, m[0].length, "Disables TLS certificate validation, exposing the connection to man-in-the-middle interception.")));
      // NODE_TLS_REJECT_UNAUTHORIZED is usually written inside a string literal assignment.
      ctx.literal.forEach((line, i) => {
        if (!ctx.code[i].includes("NODE_TLS_REJECT_UNAUTHORIZED") && /NODE_TLS_REJECT_UNAUTHORIZED["']?\]?\s*=\s*["']0["']/.test(line)) {
          const idx = line.indexOf("NODE_TLS_REJECT_UNAUTHORIZED");
          emit(i, idx, "NODE_TLS_REJECT_UNAUTHORIZED".length, "Disables TLS certificate validation process-wide.");
        }
      });
    },
  },
  {
    id: "SEC-CRYPTO-001",
    title: "Weak hash algorithm",
    category: "security",
    severity: "low",
    families: ["js", "python"],
    remediation: "Use SHA-256 or stronger for integrity, and bcrypt/scrypt/argon2 for passwords. MD5/SHA-1 are only acceptable for non-security checksums.",
    run(ctx, emit) {
      ctx.literal.forEach((line, i) =>
        eachMatch(line, /createHash\(\s*["'](md5|sha1)["']|\bhashlib\.(md5|sha1)\s*\(/, (m) =>
          emit(i, m.index, m[0].length, `${(m[1] ?? m[2]).toUpperCase()} is collision-broken; do not use it for signatures, tokens, or passwords.`)
        )
      );
    },
  },
  {
    id: "SRE-ASYNC-001",
    title: "Unhandled promise rejection",
    category: "reliability",
    severity: "high",
    families: ["js"],
    remediation: "Terminate the chain with .catch(err => logger.error(...)) or await it inside try/catch. Unhandled rejections crash Node >= 15.",
    run(ctx, emit) {
      ctx.code.forEach((line, i) => {
        const idx = line.indexOf(".then(");
        if (idx === -1) return;
        const trimmed = line.trim();
        if (trimmed.startsWith(".")) return; // continuation; evaluated from the statement head
        const head = line.slice(0, idx);
        if (/\b(return|await|yield)\b/.test(head) || /(^|[^=!<>])=(?!=)/.test(head) || /\bexport\b/.test(head)) return;
        const window = ctx.code.slice(i, i + 15).join("\n");
        const end = window.search(/;\s*(\n|$)|\n\s*\n/);
        const statement = end === -1 ? window : window.slice(0, end);
        if (!/\.catch\s*\(/.test(statement)) {
          emit(i, idx + 1, 4, "Promise chain has no .catch(); a rejection here becomes an unhandledRejection.");
        }
      });
    },
  },
  {
    id: "SRE-ASYNC-002",
    title: "Async callback passed to forEach",
    category: "concurrency",
    severity: "high",
    families: ["js"],
    remediation: "Use `for (const item of items) { await work(item); }` for sequential work, or `await Promise.all(items.map(work))` (with a concurrency limit) for parallel work.",
    run(ctx, emit) {
      ctx.code.forEach((line, i) =>
        eachMatch(line, /\.forEach\s*\(\s*async\b/, (m) =>
          emit(i, m.index + 1, 7, "forEach ignores the returned promises: work runs unbounded in parallel, errors are unhandled, and the caller continues before completion.")
        )
      );
    },
  },
  {
    id: "SRE-ERR-001",
    title: "Swallowed exception",
    category: "reliability",
    severity: "medium",
    families: ["js", "python"],
    remediation: "Log the error with context and either rethrow, return a typed failure, or document why ignoring it is safe.",
    run(ctx, emit) {
      ctx.code.forEach((line, i) => {
        if (ctx.family === "js") {
          const m = /\bcatch\s*(\([^)]*\))?\s*\{\s*(\}|$)/.exec(line);
          if (!m) return;
          const closesHere = m[2] === "}";
          const next = ctx.code.slice(i + 1).find((l) => l.trim() !== "");
          if (closesHere || (next !== undefined && next.trim().startsWith("}"))) {
            emit(i, m.index, 5, "Empty catch block silently discards the error, hiding failures from logs and alerts.");
          }
        } else {
          const m = /^\s*except\b[^:]*:\s*(pass)?\s*$/.exec(line);
          if (!m) return;
          const next = ctx.code.slice(i + 1).find((l) => l.trim() !== "");
          if (m[1] || next?.trim() === "pass") {
            emit(i, line.indexOf("except"), 6, "Exception handler only contains `pass`; failures disappear without a trace.");
          }
        }
      });
    },
  },
  {
    id: "SRE-ERR-002",
    title: "Bare except clause",
    category: "reliability",
    severity: "medium",
    families: ["python"],
    remediation: "Catch the specific exception types you expect (e.g. `except (ValueError, KeyError) as exc:`). Bare except also traps KeyboardInterrupt and SystemExit.",
    run(ctx, emit) {
      ctx.code.forEach((line, i) => {
        const m = /^\s*except\s*:/.exec(line);
        if (m) emit(i, line.indexOf("except"), 7, "Bare `except:` catches SystemExit and KeyboardInterrupt, blocking clean shutdown.");
      });
    },
  },
  {
    id: "SRE-IO-001",
    title: "Blocking call inside async function",
    category: "performance",
    severity: "high",
    families: ["js", "python"],
    remediation: "Use the async equivalent (fs.promises.*, execFile with a callback/promise; asyncio.sleep, httpx.AsyncClient / aiohttp) so the event loop keeps serving requests.",
    run(ctx, emit) {
      const re =
        ctx.family === "js"
          ? /\b(readFileSync|writeFileSync|appendFileSync|readdirSync|statSync|lstatSync|existsSync|mkdirSync|rmSync|copyFileSync|execSync|execFileSync|spawnSync)\s*\(/
          : /(?<![\w.])(time\.sleep|requests\.(?:get|post|put|delete|patch|head|request)|urllib\.request\.urlopen)\s*\(/;
      ctx.code.forEach((line, i) => {
        if (!ctx.scope[i].inAsync) return;
        eachMatch(line, re, (m) => emit(i, m.index, m[1].length, `${m[1]}() blocks the event loop inside an async function; every concurrent request stalls until it returns.`));
      });
    },
  },
  {
    id: "SRE-NET-001",
    title: "HTTP call without timeout",
    category: "reliability",
    severity: "medium",
    families: ["js", "python"],
    remediation: "Bound every outbound call: fetch(url, { signal: AbortSignal.timeout(5000) }), axios({ timeout: 5000 }), requests.get(url, timeout=5). Pair with retries + backoff or a circuit breaker for critical dependencies.",
    run(ctx, emit) {
      if (ctx.family === "js") {
        const axiosDefaultTimeout = /axios\.create\s*\(\s*\{[^}]*timeout/.test(ctx.content.replace(/\n/g, " "));
        ctx.code.forEach((line, i) => {
          eachMatch(line, /(?<![\w.$])fetch\s*\(/, (m) => {
            const window = statementWindow(ctx.literal, i, m.index);
            if (!/\bsignal\b/.test(window)) emit(i, m.index, 5, "fetch() has no AbortSignal; a hung upstream holds this request (and its socket) open indefinitely.");
          });
          if (!axiosDefaultTimeout) {
            eachMatch(line, /\baxios(\.(get|post|put|delete|patch|request))?\s*\(/, (m) => {
              const window = statementWindow(ctx.literal, i, m.index);
              if (!/\btimeout\b/.test(window)) emit(i, m.index, m[0].length - 1, "axios request without a timeout waits forever on a stalled upstream.");
            });
          }
        });
      } else {
        ctx.code.forEach((line, i) =>
          eachMatch(line, /\brequests\.(get|post|put|delete|patch|head|request)\s*\(/, (m) => {
            const window = statementWindow(ctx.literal, i, m.index);
            if (!/\btimeout\s*=/.test(window)) emit(i, m.index, m[0].length - 1, `requests.${m[1]}() has no timeout; the library default is to wait forever.`);
          })
        );
      }
    },
  },
  {
    id: "PERF-DB-001",
    title: "N+1 query pattern",
    category: "performance",
    severity: "high",
    families: ["js", "python"],
    remediation: "Hoist the round-trip out of the loop: fetch with WHERE id IN (...)/inArray(), write with a single bulk insert/upsert, or run bounded-concurrency batches inside one transaction.",
    run(ctx, emit) {
      const re =
        ctx.family === "js"
          ? /\bawait\s+(?:[\w$]+\s*\.\s*)*(?:query|execute|findOne|findUnique|findFirst|findMany|findById|find|aggregate|insert|update|delete|upsert|select|count|get)\s*\(/
          : /\b(?:cursor|conn|connection|session|db)\.(?:execute|query|get|add|scalar|scalars)\s*\(|\.objects\.(?:get|filter|create|update_or_create|get_or_create)\s*\(/;
      ctx.code.forEach((line, i) => {
        if (!ctx.scope[i].inLoop) return;
        eachMatch(line, re, (m) => emit(i, m.index, m[0].length - 1, "Database round-trip inside a loop: latency and connection usage grow linearly with the collection size (N+1)."));
      });
    },
  },
  {
    id: "SRE-MEM-001",
    title: "Interval timer never cleared",
    category: "reliability",
    severity: "medium",
    families: ["js"],
    remediation: "Store the handle (`const id = setInterval(...)`) and call clearInterval(id) on shutdown/unmount (e.g. in a useEffect cleanup or process 'SIGTERM' handler).",
    run(ctx, emit) {
      if (/\bclearInterval\s*\(/.test(ctx.code.join("\n"))) return;
      ctx.code.forEach((line, i) => eachMatch(line, /\bsetInterval\s*\(/, (m) => emit(i, m.index, 11, "setInterval is never cleared in this module; the timer and its closure leak for the process lifetime.")));
    },
  },
  {
    id: "SRE-MEM-002",
    title: "Unbounded module-level collection",
    category: "performance",
    severity: "medium",
    families: ["js", "python"],
    remediation: "Bound the structure (LRU with max size / TTL eviction), or scope it to the request instead of the module.",
    run(ctx, emit) {
      const decls: Array<{ name: string; line: number }> = [];
      ctx.code.forEach((line, i) => {
        if (ctx.scope[i].depth !== 0) return;
        const m =
          ctx.family === "js"
            ? /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:\[\s*\]|new\s+(?:Map|Set)\s*(?:<[^>]*>)?\s*\(\s*\))\s*;?\s*$/.exec(line)
            : /^([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*(?:\[\s*\]|\{\s*\}|list\(\)|dict\(\)|set\(\))\s*$/.exec(line);
        if (m) decls.push({ name: m[1], line: i });
      });
      const all = ctx.code.join("\n");
      for (const { name, line } of decls) {
        const n = name.replace(/\$/g, "\\$");
        const grows = new RegExp(`\\b${n}\\s*(\\.(push|unshift|set|add|append|extend|setdefault)\\s*\\(|\\[[^\\]]+\\]\\s*=(?!=))`);
        const evicts = new RegExp(`\\b${n}\\s*(\\.(splice|shift|pop|clear|delete|remove|popitem|discard)\\s*\\(|\\.length\\s*=|=(?!=))|\\bdel\\s+${n}\\[`);
        const growLines = ctx.code.map((l, i) => (i !== line && ctx.scope[i].depth > 0 && grows.test(l) ? i : -1)).filter((i) => i >= 0);
        const evictElsewhere = ctx.code.some((l, i) => i !== line && evicts.test(l));
        if (growLines.length > 0 && !evictElsewhere && grows.test(all)) {
          emit(line, ctx.code[line].indexOf(name), name.length, `\`${name}\` lives for the process lifetime and only grows (line ${growLines[0] + 1}); memory increases without bound under load.`);
        }
      }
    },
  },
  {
    id: "SRE-CONC-001",
    title: "Non-atomic lazy initialization",
    category: "concurrency",
    severity: "medium",
    families: ["js", "python"],
    remediation: "Memoize the in-flight promise (`instance ??= createInstance(); return await instance;`) so concurrent callers share one initialization.",
    run(ctx, emit) {
      ctx.code.forEach((line, i) => {
        const m =
          ctx.family === "js"
            ? /\bif\s*\(\s*!\s*((?:this\.)?[A-Za-z_$][\w$]*)\s*\)/.exec(line)
            : /\bif\s+(?:not\s+((?:self\.)?\w+)|((?:self\.)?\w+)\s+is\s+None)\s*:/.exec(line);
        if (!m) return;
        const name = (m[1] ?? m[2]).replace(/[.$]/g, "\\$&");
        const assign = new RegExp(`${name}\\s*=\\s*await\\b`);
        for (let j = i; j < Math.min(ctx.code.length, i + 5); j++) {
          if (assign.test(ctx.code[j])) {
            emit(i, m.index, m[0].length, `Check-then-await-then-assign on ${m[1] ?? m[2]}: concurrent callers all pass the check before the first assignment lands, initializing it more than once.`);
            return;
          }
        }
      });
    },
  },
  {
    id: "SRE-CONC-002",
    title: "Read-modify-write across await",
    category: "concurrency",
    severity: "high",
    families: ["js"],
    remediation: "Compute the delta first (`const delta = await fetchDelta(); this.total += delta;`) or serialize updates with a mutex/queue.",
    run(ctx, emit) {
      ctx.code.forEach((line, i) =>
        eachMatch(line, /\b(this\.[A-Za-z_$][\w$]*)\s*([+\-*]=\s*await\b|=\s*\1\s*[+\-*]\s*await\b)/, (m) =>
          emit(i, m.index, m[0].length, `${m[1]} is read before the await and written after it; interleaved calls lose updates.`)
        )
      );
    },
  },
  {
    id: "REL-JS-001",
    title: "Undeclared loop variable",
    category: "reliability",
    severity: "high",
    families: ["js"],
    remediation: "Declare the binding: `for (const item of items)`.",
    run(ctx, emit) {
      ctx.code.forEach((line, i) =>
        eachMatch(line, /\bfor\s*\(\s*([A-Za-z_$][\w$]*)\s+(of|in)\b/, (m) =>
          emit(i, m.index, m[0].length, `Loop variable '${m[1]}' is not declared: ReferenceError in strict mode/modules, an implicit global otherwise.`)
        )
      );
    },
  },
  {
    id: "MNT-JS-001",
    title: "Loose equality",
    category: "maintainability",
    severity: "low",
    families: ["js"],
    remediation: "Use === / !== (keep `== null` only where matching both null and undefined is intended).",
    run(ctx, emit) {
      ctx.code.forEach((line, i) =>
        eachMatch(line, /[^=!<>]([!=]=)(?!=)(?!\s*(?:null|undefined)\b)/, (m) => {
          const before = line.slice(0, m.index + 1);
          if (/\bnull\s*$|\bundefined\s*$/.test(before)) return;
          emit(i, m.index + 1, 2, `'${m[1]}' performs type coercion (e.g. 0 == '' is true).`);
        })
      );
    },
  },
  {
    id: "MNT-JS-002",
    title: "debugger statement",
    category: "maintainability",
    severity: "low",
    families: ["js"],
    remediation: "Remove the debugger statement before shipping.",
    run(ctx, emit) {
      ctx.code.forEach((line, i) => eachMatch(line, /\bdebugger\s*;?/, (m) => emit(i, m.index, 8, "`debugger` pauses execution whenever devtools are attached.")));
    },
  },
  {
    id: "PY-REL-001",
    title: "Mutable default argument",
    category: "reliability",
    severity: "high",
    families: ["python"],
    remediation: "Default to None and create the object inside the function: `def f(items=None): items = [] if items is None else items`.",
    run(ctx, emit) {
      ctx.code.forEach((line, i) =>
        eachMatch(line, /\bdef\s+\w+\s*\([^)]*?(\w+)\s*(?::[^=,)]+)?=\s*(\[\s*\]|\{\s*\}|list\(\)|dict\(\)|set\(\))/, (m) =>
          emit(i, line.indexOf(m[1], m.index), m[1].length, `Default value for '${m[1]}' is created once and shared across calls; mutations leak between invocations.`)
        )
      );
    },
  },
  {
    id: "PY-RES-001",
    title: "File handle without context manager",
    category: "reliability",
    severity: "medium",
    families: ["python"],
    remediation: "Use `with open(path) as fh:` so the descriptor is closed even when an exception is raised.",
    run(ctx, emit) {
      ctx.code.forEach((line, i) => {
        if (/^\s*(async\s+)?with\b/.test(line) || /\breturn\s+open\s*\(/.test(line)) return;
        eachMatch(line, /(?<![\w.])open\s*\(/, (m) => emit(i, m.index, 4, "open() outside a with-block leaks the file descriptor if an exception occurs before close()."));
      });
    },
  },
  {
    id: "PY-NAME-001",
    title: "Undefined name (likely typo)",
    category: "reliability",
    severity: "critical",
    families: ["python"],
    remediation: "Correct the identifier to the defined name it was meant to reference.",
    run(ctx, emit) {
      const all = ctx.code.join("\n");
      if (/\bimport\s+\*/.test(all)) return;
      const defined = new Set<string>();
      const add = (re: RegExp, group = 1) => eachMatch(all, re, (m) => m[group] && defined.add(m[group]));
      add(/^\s*([A-Za-z_]\w*)\s*(?::[^=\n]+)?=(?!=)/m);
      eachMatch(all, /^[ \t]*([A-Za-z_][\w, \t]*?)\s*=(?!=)/m, (m) => m[1].split(",").forEach((n) => defined.add(n.trim())));
      add(/\b(?:def|class)\s+([A-Za-z_]\w*)/);
      add(/\bfor\s+([A-Za-z_]\w*)/);
      add(/\bas\s+([A-Za-z_]\w*)/);
      add(/\bglobal\s+([A-Za-z_]\w*)/);
      add(/^\s*import\s+([A-Za-z_]\w*)/m);
      eachMatch(all, /^\s*from\s+[\w.]+\s+import\s+\(?([^)\n]+)/m, (m) =>
        m[1].split(",").forEach((part) => defined.add(part.trim().split(/\s+as\s+/).pop()!.trim()))
      );
      eachMatch(all, /\bdef\s+\w+\s*\(([^)]*)\)|\blambda\b([^:]*):/, (m) =>
        eachMatch(m[1] ?? m[2] ?? "", /(?:^|,)\s*\*{0,2}([A-Za-z_]\w*)/, (p) => defined.add(p[1]))
      );
      ctx.code.forEach((line, i) => {
        if (/^\s*(def|class|import|from|global|nonlocal)\b/.test(line)) return;
        eachMatch(line, /(?<![\w.])([A-Za-z_]\w*)\b(?!\s*=(?!=))/, (m) => {
          const name = m[1];
          if (defined.has(name) || PY_BUILTINS.has(name) || PY_KEYWORDS.has(name) || name.length < 3) return;
          const intended = nearMiss(name, defined);
          if (intended) emit(i, m.index, name.length, `'${name}' is never defined; this raises NameError at runtime. Did you mean '${intended}'?`, { remediation: `Replace '${name}' with '${intended}'.` });
        });
      });
    },
  },
  {
    id: "PY-ATTR-001",
    title: "Unknown attribute or method (likely typo)",
    category: "reliability",
    severity: "high",
    families: ["python"],
    remediation: "Rename the reference (or the definition) so both sides use the same identifier.",
    run(ctx, emit) {
      const all = ctx.code.join("\n");
      // Class member index: methods and self.attributes per class (single-file, no inheritance).
      const classes = new Map<string, Set<string>>();
      const classAt: string[] = [];
      let currentClass: { name: string; indent: number } | null = null;
      ctx.code.forEach((line, i) => {
        const indent = line.length - line.trimStart().length;
        if (line.trim() && currentClass && indent <= currentClass.indent) currentClass = null;
        const cm = /^(\s*)class\s+([A-Za-z_]\w*)\s*(\(([^)]*)\))?\s*:/.exec(line);
        if (cm) {
          currentClass = { name: cm[2], indent: cm[1].length };
          // Classes with non-trivial bases inherit unknown members: skip them.
          const bases = (cm[4] ?? "").trim();
          if (!bases || bases === "object") classes.set(cm[2], new Set());
        }
        classAt[i] = currentClass?.name ?? "";
        const members = currentClass ? classes.get(currentClass.name) : undefined;
        if (!members) return;
        eachMatch(line, /\bdef\s+([A-Za-z_]\w*)/, (m) => members.add(m[1]));
        eachMatch(line, /\bself\.([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/, (m) => members.add(m[1]));
        if (indent === currentClass!.indent + 4 || indent === currentClass!.indent + 2) {
          eachMatch(line, /^\s*([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/, (m) => members.add(m[1]));
        }
      });

      const assignedLine = (cls: string, member: string) =>
        ctx.code.findIndex((l, i) => classAt[i] === cls && new RegExp(`\\bself\\.${member}\\s*(?::[^=]+)?=(?!=)|\\bdef\\s+${member}\\b`).test(l));

      // self.<member> inside a known class
      ctx.code.forEach((line, i) => {
        const cls = classAt[i];
        const members = cls ? classes.get(cls) : undefined;
        if (!members) return;
        eachMatch(line, /\bself\.([A-Za-z_]\w*)\b(?!\s*(?::[^=]+)?=(?!=))/, (m) => {
          if (members.has(m[1]) || m[1].startsWith("__")) return;
          const intended = nearMiss(m[1], members);
          if (intended) {
            const at = assignedLine(cls, intended);
            emit(i, m.index + 5, m[1].length, `self.${m[1]} is never assigned on ${cls}; this raises AttributeError. ${cls} defines '${intended}'${at >= 0 ? ` (line ${at + 1})` : ""}.`, {
              remediation: `Use one name consistently: rename '${m[1]}' or '${intended}' so the definition and the reference match.`,
            });
          }
        });
      });

      // instance.<member> where instance = KnownClass(...)
      const instances = new Map<string, string>();
      eachMatch(all, /\b([A-Za-z_]\w*)\s*=\s*([A-Z]\w*)\s*\(/, (m) => {
        if (classes.has(m[2])) instances.set(m[1], m[2]);
      });
      ctx.code.forEach((line, i) =>
        eachMatch(line, /(?<![\w.])([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b/, (m) => {
          const cls = instances.get(m[1]);
          const members = cls ? classes.get(cls) : undefined;
          if (!cls || !members || members.has(m[2]) || m[2].startsWith("__")) return;
          const intended = nearMiss(m[2], members);
          if (intended) emit(i, m.index + m[1].length + 1, m[2].length, `${cls} has no member '${m[2]}'; did you mean '${intended}'? This raises AttributeError.`, { remediation: `Call ${m[1]}.${intended}(...) instead.` });
        })
      );

      // module.<member> for well-known standard-library modules
      const apis = KNOWN_APIS.python;
      ctx.code.forEach((line, i) =>
        eachMatch(line, /(?<![\w.])(logging|json|os|time|math)\.([A-Za-z_]\w*)\b/, (m) => {
          const known = apis[m[1]];
          if (!known || known.includes(m[2])) return;
          const intended = nearMiss(m[2], known);
          if (intended) emit(i, m.index + m[1].length + 1, m[2].length, `${m[1]}.${m[2]} does not exist; did you mean ${m[1]}.${intended}? This raises AttributeError.`, { remediation: `Replace with ${m[1]}.${intended}.` });
        })
      );
    },
  },
  {
    id: "REL-JS-002",
    title: "Unknown built-in API (likely typo)",
    category: "reliability",
    severity: "high",
    families: ["js"],
    remediation: "Correct the member name to the built-in API it was meant to call.",
    run(ctx, emit) {
      const apis = KNOWN_APIS.js;
      ctx.code.forEach((line, i) =>
        eachMatch(line, /(?<![\w.$])(console|Math|JSON|Object|Promise|Array|Number)\.([A-Za-z_$][\w$]*)\b/, (m) => {
          const known = apis[m[1]];
          if (!known || known.includes(m[2])) return;
          const intended = nearMiss(m[2], known);
          if (intended) emit(i, m.index + m[1].length + 1, m[2].length, `${m[1]}.${m[2]} is not a function; did you mean ${m[1]}.${intended}? This throws TypeError.`, { remediation: `Replace with ${m[1]}.${intended}.` });
        })
      );
    },
  },
];

export const RULE_CATALOG: ReadonlyArray<RuleMeta> = RULES.map((r) => ({
  id: r.id,
  title: r.title,
  category: r.category,
  severity: r.severity,
  families: r.families,
  remediation: r.remediation,
}));

const SEVERITY_RANK: Record<IssueSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

const PENALTY: Record<IssueSeverity, number> = { critical: 20, high: 10, medium: 4, low: 1, info: 0 };

/** 0-100 quality score: 100 minus a severity-weighted penalty per open finding. */
export function scoreFindings(findings: ReadonlyArray<{ severity: IssueSeverity }>): number {
  return Math.max(0, 100 - findings.reduce((sum, f) => sum + PENALTY[f.severity], 0));
}

export function compareFindings(a: { severity: IssueSeverity; line: number; column: number }, b: { severity: IssueSeverity; line: number; column: number }): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.line - b.line || a.column - b.column;
}

export function scanSource(content: string, language: string): HeuristicResult {
  const started = performance.now();
  const family = familyOf(language);
  const raw = splitLines(content);
  const lexed = lexLines(raw, language);
  const code = lexed.map(codeView);
  const literal = lexed.map(noCommentView);
  const scope = family === "js" ? jsScopes(code) : family === "python" ? pythonScopes(code) : raw.map(() => ({ inAsync: false, inLoop: false, depth: 0 }));
  const ctx: Context = { language, family, raw, code, literal, scope, content };

  const findings: Finding[] = [];
  const seen = new Set<string>();
  let rulesEvaluated = 0;

  for (const rule of RULES) {
    if (rule.families !== "all" && !rule.families.includes(family)) continue;
    rulesEvaluated++;
    const emit: Emit = (lineIdx, column, length, message, overrides) => {
      const key = `${rule.id}:${lineIdx}:${column}`;
      if (seen.has(key)) return;
      seen.add(key);
      findings.push({
        ruleId: rule.id,
        title: rule.title,
        category: rule.category,
        severity: overrides?.severity ?? rule.severity,
        line: lineIdx + 1,
        column: Math.max(1, column + 1),
        endLine: lineIdx + 1,
        endColumn: Math.max(2, column + 1 + Math.max(1, length)),
        message,
        remediation: overrides?.remediation ?? rule.remediation,
        source: "heuristic",
      });
    };
    try {
      rule.run(ctx, emit);
    } catch (err) {
      // A defective rule must never take down the scan; it is reported and skipped.
      console.error(`[heuristic] rule ${rule.id} failed:`, err instanceof Error ? err.message : err);
    }
  }

  findings.sort(compareFindings);
  return { findings, durationMs: Math.round((performance.now() - started) * 100) / 100, rulesEvaluated };
}
