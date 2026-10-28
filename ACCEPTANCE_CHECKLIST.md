# Acceptance Checklist

Each item names the evidence that verifies it. "Test" refers to `npm test` (tests/), "E2E" to a manual run of
the app against an embedded PGlite database and a scratch git repository.

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| 1 | No hardcoded or synthetic data in UI or API | Met | All telemetry comes from `/api/stats` SQL aggregates (`src/server/stats.ts`) and `/api/system`; missing values render as "—". |
| 2 | A real defect is never reported as clean | Met | `deriveStatus` (`src/server/analysis.ts`): a configured AI that fails or covers part of a file yields `error` unless findings exist. Test: "analyzeDeep reports total provider failure". |
| 3 | Analyzed files show the fix next to the original | Met | Unified and split diff views (`CodeViewport.tsx`, `diff-rows.ts`). E2E: patch reviewed in the UI. |
| 4 | Re-analysis is non-blocking and targeted | Met | Per-file SWR keys, lease-based locking (`acquireLease`), auto deep analysis once per content hash. Test: lease conflict + expiry recovery. |
| 5 | Commit writes the real local file atomically | Met | Server: temp + fsync + rename + re-read hash check (`writeWorkspaceFileAtomic`). Browser: hash-guarded `createWritable` with post-write verification. Test + E2E. |
| 6 | After commit, the file reflects the fix | Met | Commit updates content/hash, marks issues `fixed`, re-scans deterministically; UI then re-verifies with AI. Test: status becomes `clean`, fixed issues retained. |
| 7 | Delete removes from disk and index | Met | `DELETE /api/files/{id}?disk=1` deletes on disk first (server) or via handle (browser), then the row. |
| 8 | Large files and repositories | Met | 2 MB/file, 5,000 files/workspace (configurable); virtualized explorer/viewport/diff; byte-bounded upload batches < 4.5 MB; AI chunking with absolute line numbers. Test: multi-chunk patch never truncates. |
| 9 | Any language without crashing | Met | Lexer covers 30+ languages with plaintext fallback; rule failures are isolated per rule. |
| 10 | Every async action has visible progress | Met | Skeleton rows, indeterminate/determinate progress bar, status-bar activity, NDJSON batch progress. |
| 11 | Strict TypeScript, lint-clean, builds | Met | `npm run typecheck`, `npm run lint`, `npm run build` all pass with zero warnings. |
| 12 | Path traversal impossible | Met | `normalizeRelativePath` + `resolveInside` (lexical and post-realpath checks) + allow-listed roots. Test: `../` and absolute escapes rejected. |
| 13 | Incremental (delta) scanning | Met | SHA-256 comparison in `applySync`/`applyManifest`. Test: second sync reports 5 unchanged. |
| 14 | Works with no AI key | Met | Deterministic fallback. Test: "falls back to heuristics without a provider". |

## Known limits

- No authentication layer: intended for localhost (see README "Security notes").
- The browser-mode folder picker requires Chrome or Edge and a user gesture; it cannot be exercised by automated tests.
- Files over `AETHEROPS_AI_MAX_CHUNKS` × chunk budget are AI-analyzed only partially; the UI reports partial coverage and never marks such a file clean without findings.
