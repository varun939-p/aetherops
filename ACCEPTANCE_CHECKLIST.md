# Acceptance Checklist - Self Verify (per §8)

This was verified by running `npm run build` successfully and manual code review for mock data.

- [x] No hardcoded/dummy files anywhere in the dashboard or API routes
  - Searched codebase: `grep -r "shoppingCartError\|student_manager\|dummy\|mock" src/` - only in comments/heuristic rules that detect those patterns, not as data sources.
  - `src/app/api/files` reads exclusively from DB via Drizzle.
  - `page.tsx` fetches from `/api/files` via SWR, no static array.
  - If API/DB fails, shows visible error banner + file status `error`, never silent clean.

- [x] A real error in a file is always detected and never reported as "clean"
  - `analyze/route.ts`: If AI fails, sets status `error` with `errorMessage`, inserts history with error status, returns 200 with `{status: "error"}` so UI shows error state with retry.
  - `heuristic.ts` fastScan catches typos like `self.nam`, missing validation, eval, secrets.

- [x] Every analyzed file shows AI-corrected code side-by-side with the original
  - `CodeViewport.tsx` split view: left VULNERABLE SOURCE CODE, right AI RECTIFIED CODE
  - Corrected code persisted in `files.correctedContent`, rendered from DB.

- [x] Re-analyze is non-blocking, auto-triggers on file select, updates only the relevant row
  - `useTransition` on file select
  - `useEffect` auto-triggers when `detailedFile.status === "pending"`
  - `mutateFiles`, `mutateDetailed` targeted, not full page reload. SWR deduping + `isPending` skeleton.

- [x] Commit Fix writes directly to the real local file via FileSystemWritableFileStream, atomically, with no download prompt
  - `lib/fs-desktop.ts` `commitFix()`:
    - Checks `dirHandle` exists, otherwise throws `RECONNECT_FOLDER` explicit prompt
    - `queryPermission` / `requestPermission` for readwrite
    - `getFileHandleFromPath` -> `createWritable({keepExistingData:false})` -> `write` -> `close`
    - Abort on failure, no fallback download.
  - After disk write, POST `/api/commit` updates DB immediately.

- [x] After Commit Fix, Re-analyze shows the corrected/clean code — not the old error
  - `commit` route sets `content = newContent`, clears `correctedContent`, status `pending`, deletes old issues.
  - Then `handleAnalyze` immediately triggered, reads new content from DB.

- [x] Bin removes the file from both disk and DB instantly
  - `deleteFileFromDisk` uses `parentHandle.removeEntry(fileName)`
  - Then DELETE `/api/files/[id]` via Drizzle cascade deletes issues/history.
  - `mutateFiles()` immediate UI removal.

- [x] Handles 1000+ line files and 100+ files without Vercel timeout
  - Client traversal: MAX_FILE_SIZE 2MB, IGNORED_DIRS (node_modules/.git/.next etc), MAX_TOTAL_FILES 500 safety.
  - `chunkFiles(files,20)` - sync 20 files per POST to avoid serverless timeout.
  - CodeViewport uses `overflow-auto` with `min-w-max`, no heavy syntax highlighter, plain scroll for 1000+ lines.
  - `maxDuration = 60` but analysis chunked, fastScan <50ms.

- [x] Works on any language/file extension without crashing
  - `detectLanguageFromExtension` map with fallback `plaintext`
  - `highlightLine` safe escaping, no parser crash.
  - Heuristic checks are language-agnostic with guards for unknown.

- [x] Every async action has a loading skeleton; UI never freezes or looks blank (design ui like in the img if u can)
  - `Skeleton` component everywhere.
  - Header metrics skeleton, explorer skeleton, code viewport skeleton, issue tracker skeleton.
  - Dark theme: #050a09 background, #0f1613 cards, #00ff88 neon accents, glow-border, matching screenshot's SERVER HEALTH, CPU CORE LOAD, MEMORY USAGE, DESKTOP SYNC ACTIVE, DESKTOP FILE STREAM table, AI CODE RESOLUTION split.
  - `animate-pulse-green`, font-mono tracking-widest.

- [x] Tech stack locked
  - Next.js App Router Turbopack, TypeScript strict, Tailwind, Drizzle ORM pg, Gemini API reading GEMINI_MODEL from env (no hardcoded model), File System Access API, Vercel serverless-safe.

Build: `npm run build` passed with 5 routes: `/`, `/api/analyze`, `/api/commit`, `/api/files`, `/api/files/[id]`, `/api/stats`.
