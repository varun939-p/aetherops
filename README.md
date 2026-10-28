# AetherOps

**Live demo:** [https://aetherops-flame.vercel.app](https://aetherops-flame.vercel.app) (hosted builds run in browser mode; see [Filesystem modes](#filesystem-modes))

Real-time SRE codebase analysis and remediation workspace. Link a local repository, get deterministic
security/reliability findings in milliseconds, add AI root-cause analysis with line-range patches, review
the diff, and write the fix back to disk (optionally as a git commit) — with hashes verified at every step.

### Key capabilities

- **Closed-loop remediation:** findings → AI line-range patch → reviewed diff → atomic, hash-verified write → optional single-file git commit → issues marked fixed.
- **Responsive at repository scale:** SHA-256 delta sync, virtualized explorer/source/diff views, and NDJSON-streamed batch scans keep the UI interactive on thousands of files.
- **Safe file handling:** atomic writes that refuse to overwrite files changed since analysis, in both server mode and the browser File System Access fallback.

### Prerequisites

- Node.js 20.12+ and git.
- Chrome or Edge for browser mode (File System Access API). Server mode works in any browser.

## How it works

| Layer | What it does |
| --- | --- |
| **Ingestion** (`src/lib/fs-desktop.ts`, `fs-browser.ts`, `policy.ts`) | Walks a workspace honouring nested `.gitignore` files, skips build/vendor dirs, binaries, non-UTF-8 files, symlinks, and credential files (`.env`, `*.pem`, `id_rsa`, …). Every file gets a SHA-256 so re-syncs only touch changed files. |
| **Deterministic engine** (`src/lib/heuristic.ts`, `lexer.ts`) | 26 rules over lexed source (never fires inside comments/strings unless the rule inspects literals): injection (`SEC-INJ-*`), secrets, TLS bypass, XSS sinks, unhandled promises, async `forEach`, blocking I/O in async code, HTTP calls without timeouts, N+1 queries, unbounded caches, lazy-init and read-modify-write races, Python name/attribute typos, mutable defaults. Each finding has a rule ID, exact line/column span, severity, category, and a remediation. |
| **AI engine** (`src/lib/ai.ts`) | Gemini with a JSON response schema, validated again with zod. Files are split into token-budgeted chunks with absolute line numbers; fixes come back as non-overlapping line-range edits, so a patch can never truncate code the model did not see. Exponential backoff with full jitter on 408/429/5xx; falls back to the deterministic engine when no key is configured. |
| **Persistence** (`src/db/*`, `src/server/*`) | Postgres (or embedded PGlite) via Drizzle. Versioned migrations, workspace-scoped files, issue history (`open` → `fixed`), scans, and commits. Syncs and analyses are transactional; analysis results are only written if the file's hash is unchanged. |
| **API** (`src/app/api/*`) | Every route returns `{ ok, data, meta, error }` with deterministic status codes. Mutating requests reject cross-origin `Origin`s; filesystem operations only answer on loopback hosts. |
| **UI** (`src/app/page.tsx`, `src/components/*`) | Full-viewport three-pane workspace: virtualized explorer with fuzzy filter, virtualized source/diff viewport with severity gutter, filterable issue tracker with jump-to-line, and a telemetry strip computed from the database. |

### Filesystem modes

- **Server mode (local-first, default for local use).** Set `AETHEROPS_ALLOWED_ROOTS`. The server walks the
  folder, writes patches atomically (temp file + fsync + rename, then re-read and hash-verify), refuses to
  write if the file changed on disk since analysis, and can `git commit` exactly the patched file.
- **Browser mode (fallback for hosted deployments).** Uses the File System Access API (Chrome/Edge). The
  directory handle is persisted in IndexedDB; the browser hashes, uploads, and writes; the server verifies
  hashes. No git integration.

## Setup

```bash
npm install
cp .env.example .env        # then edit .env
npm run db:migrate          # applies drizzle/ migrations to DATABASE_URL
npm run dev                 # http://localhost:3000
```

Minimum `.env` for fully local, offline use:

```env
DATABASE_URL=pglite:./.data/pglite
AETHEROPS_ALLOWED_ROOTS=C:\Users\you\Desktop
```

Add `GEMINI_API_KEY` and `GEMINI_MODEL` to enable deep analysis and patches.

> **Upgrading an existing database:** migration `0000_drop_legacy` drops the prototype's `files`, `issues`,
> and `analysis_history` tables (cached file copies and derived analysis only). Re-link your folder afterwards.

## Using it

1. **Link workspace** → paste an absolute path inside `AETHEROPS_ALLOWED_ROOTS` (server mode), or **Choose folder…** (browser mode).
2. The initial sync runs the deterministic engine on every file. **Sync** re-reads disk and only processes changed hashes.
3. Select a file: if AI is configured and the current content is not AI-verified yet, deep analysis runs automatically.
4. Click an issue to jump to its line. **Review patch** opens the unified/split diff; **Apply & commit patch** writes it.
5. **Scan** re-runs the deterministic engine on changed files; **Deep scan** runs AI analysis on every file not yet AI-verified (asks first).

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js |
| `npm test` | Node test runner: rules, patching, AI orchestration (fake provider), filesystem boundaries, and full DB flows on in-memory PGlite including a real git commit |
| `npm run typecheck` / `lint` | `tsc --noEmit` / ESLint |
| `npm run db:migrate` | Applies `drizzle/` migrations to `DATABASE_URL` (Postgres or `pglite:`) and prints the real error, with a hint, if the database is unreachable |
| `npm run db:generate` / `db:check` | Drizzle Kit |

## API

All responses: `{ "ok": boolean, "data": T | null, "meta": { "requestId", "durationMs", ... }, "error": { "code", "message", "details"? } | null }`.

| Method & path | Body / query | Result |
| --- | --- | --- |
| `GET /api/system` | — | DB connectivity/migration, AI config, filesystem mode |
| `GET /api/workspaces` | — | Workspaces with file counts |
| `POST /api/workspaces` | `{ kind: "server", rootPath }` or `{ kind: "browser", name }` | Created/existing workspace (201) |
| `DELETE /api/workspaces/{id}` | — | Unlinks (DB only; disk untouched) |
| `POST /api/workspaces/{id}/sync` | server: `{}` · browser: `{ entries: [{ path, hash }] }` | Delta sync counts · paths whose content is needed |
| `GET /api/files?workspaceId=` | — | File summaries (no content) with open/critical/high counts |
| `POST /api/files` | `{ workspaceId, files: [{ path, content, hash }] }` | Browser-mode upload; hashes re-verified server-side |
| `GET /api/files/{id}` | — | Content, committable patch, issues, recent scans |
| `DELETE /api/files/{id}?disk=1` | — | Removes from disk (server mode) and index |
| `POST /api/analyze` | `{ fileId, engine?: "hybrid" \| "heuristic" }` | Analysis result incl. `scanDurationMs`, coverage, `aiError` |
| `POST /api/analyze` | `{ workspaceId, scope?: "changed" \| "all", engine? }` | NDJSON stream: `start`, `file`…, `done` |
| `GET /api/issues?workspaceId=` | `fileId`, `status=open\|fixed\|all`, `severity=a,b`, `category=a,b`, `source` | Issues sorted critical first |
| `GET /api/stats?workspaceId=` | — | Health index, severity/category breakdown, coverage, LOC, scan latency (mean/p95), recent scans |
| `POST /api/commit` | `{ fileId, baseHash, git?, writtenHash? }` | Writes the stored patch, marks issues fixed, optional git commit |

Error codes: `VALIDATION_FAILED` 400 · `PATH_OUTSIDE_WORKSPACE` 400/403 · `FORBIDDEN_ORIGIN` 403 · `SERVER_FS_DISABLED` 403 · `NOT_FOUND` 404 · `ANALYSIS_IN_PROGRESS` / `STALE_CONTENT` / `DISK_DRIFT` / `PATCH_UNAVAILABLE` / `INTEGRITY_FAILED` 409/422 · `PAYLOAD_TOO_LARGE` 413 · `UNSUPPORTED_MEDIA_TYPE` 415 · `DB_NOT_CONFIGURED` / `DB_UNAVAILABLE` / `SCHEMA_NOT_MIGRATED` 503.

### curl

```bash
curl -s -X POST http://localhost:3000/api/workspaces -H "Content-Type: application/json" -d '{"kind":"server","rootPath":"C:/Users/you/Desktop/my-repo"}'
curl -s -X POST http://localhost:3000/api/workspaces/1/sync -H "Content-Type: application/json" -d '{}'
curl -s -X POST http://localhost:3000/api/analyze -H "Content-Type: application/json" -d '{"workspaceId":1,"scope":"changed","engine":"heuristic"}'
curl -s "http://localhost:3000/api/issues?workspaceId=1&severity=critical,high"
```

### JavaScript

```js
async function call(path, body) {
  const res = await fetch(`http://localhost:3000${path}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const env = await res.json();
  if (!env.ok) throw new Error(`${env.error.code}: ${env.error.message}`);
  return env.data;
}

const file = (await call("/api/files?workspaceId=1")).find((f) => f.criticalIssues > 0);
const { file: detail } = await call("/api/analyze", { fileId: file.id, engine: "hybrid" });
if (detail.patchCommittable) await call("/api/commit", { fileId: detail.id, baseHash: detail.contentHash, git: true });
```

### Python

```python
import requests

BASE = "http://localhost:3000"

def call(path, body=None):
    r = requests.post(BASE + path, json=body, timeout=120) if body is not None else requests.get(BASE + path, timeout=30)
    env = r.json()
    if not env["ok"]:
        raise RuntimeError(f'{env["error"]["code"]}: {env["error"]["message"]}')
    return env["data"]

stats = call("/api/stats?workspaceId=1")
print(stats["healthIndex"], stats["openIssues"]["bySeverity"])

# Stream a batch scan
with requests.post(BASE + "/api/analyze", json={"workspaceId": 1, "scope": "all", "engine": "heuristic"}, stream=True, timeout=600) as r:
    for line in r.iter_lines():
        if line:
            print(line.decode())
```

## Security notes

- There is no user authentication. Run it on localhost; filesystem endpoints refuse non-loopback `Host` headers
  (`localhost`, `127.0.0.1`, `::1` and `*.localhost`, which covers Pinokio's `https://<port>.localhost` proxy)
  — add names to `AETHEROPS_TRUSTED_HOSTS` only if you put an authenticating proxy in front.
- Hosted deployments (e.g. Vercel) automatically disable server filesystem access. Anyone who can reach a hosted
  instance can read stored file contents; do not expose one publicly without adding authentication.
- Credential files are never ingested, stored, or sent to the AI provider. Secrets found inside regular source
  files are reported (masked) but the file content is still analyzed.
