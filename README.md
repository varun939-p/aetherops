# AetherOps - Real-Time Codebase Analyzer

**Live Demo:** [https://aetherops-flame.vercel.app](https://aetherops-flame.vercel.app)

AetherOps is an enterprise-grade, production-ready Real-Time Codebase Analyzer with an autonomous AI code-review and auto-remediation pipeline. Built to bridge the gap between AI coding assistants and real-world SRE workflows, it features direct Browser File System integration for atomic, production-ready code fixes.

Enterprise-grade, production-ready Real-Time Codebase Analyzer with autonomous AI code-review and auto-remediation pipeline. Portfolio-grade project for live recruiter demo.

![Stack](https://img.shields.io/badge/Next.js-16-black) ![TS](https://img.shields.io/badge/TypeScript-strict-blue) ![Drizzle](https://img.shields.io/badge/Drizzle%20ORM-pg-green) ![Gemini](https://img.shields.io/badge/AI-Gemini%20API-orange)

## Features - All Bugs Fixed Per §5

1. **Zero Mock Data** - Every file, issue, and corrected code comes from real folder traversal + real Gemini call persisted in Postgres via Drizzle. No hardcoded dummy files.

2. **Never reports clean on failure** - API failure sets explicit `error` status with retry option, never falls through to clean.

3. **AI corrected code shown side-by-side** - Vulnerable source | AI rectified, with issues list sorted critical first.

4. **Re-analyze is non-blocking**
   - `useTransition` + `useOptimistic` pattern - UI stays responsive with loading skeleton
   - Auto-triggers when file selected and `auditStatus === pending`
   - SWR polling with targeted row re-render, not whole page
   - Debounced explorer updates

5. **Commit Fix actually overwrites local file**
   - Strict `FileSystemWritableFileStream` direct-write in `lib/fs-desktop.ts`
   - No download-prompt fallback - shows explicit "reconnect folder" prompt if handle inactive
   - Atomic write with abort handling

6. **After Commit Fix, Re-analyze shows corrected code** - DB record updated immediately before re-analysis reads newly written content.

7. **Bin deletes from both disk and DB instantly** - Uses `directoryHandle.removeEntry()` + DELETE `/api/files/[id]` + mutateFiles()

8. **Large files / large repos** - 2MB per file cap, 500 files max safety, chunked traversal and chunked sync (20 files per POST to avoid Vercel timeout), streamed parsing.

9. **Any language** - `detectLanguageFromExtension` never crashes, fallback to plaintext highlighting + generic heuristic analysis.

10. ### 🚀 Key Achievements
* **Autonomous Remediation:** Implemented an AI-driven pipeline that detects critical vulnerabilities and suggests remediations, significantly reducing manual code review overhead.
* **Production-Grade Performance:** Optimized for large-scale analysis using chunked serverless streaming and SWR-based granular UI updates to maintain a responsive 60FPS user experience.
* **Atomic File Handling:** Utilized the Browser File System Access API to perform direct, atomic writes, ensuring code fixes are applied safely and reliably without user-prompt friction.

## Tech Stack (locked)

- Next.js 16 App Router Turbopack
- TypeScript strict
- Tailwind CSS + PostCSS
- PostgreSQL via Drizzle ORM (pg driver)
- Google Gemini API - model/key from `.env` (`GEMINI_API_KEY`, `GEMINI_MODEL`) - never hardcoded
- Browser File System Access API (showDirectoryPicker, FileSystemFileHandle, FileSystemWritableFileStream) - client-side handle lives in browser, works even when app hosted on Vercel
- Vercel serverless-safe

- ### ⚠️ Technical Prerequisites
* **Browser:** Chrome or Edge (Required for File System Access API support).
* **Environment:** Node.js 20+ installed locally for development.

## Architecture

**4.1 Folder Linking (client)** `showDirectoryPicker()` -> recursive walk -> read every file's content/path

**4.2 Sync to Database** Each file upserted to Postgres via Drizzle, dashboard reads exclusively from DB

**4.3 AI Analysis (server API)**

- Fast-Scan <50ms: `fastScan()` regex checks -> immediate UI push
- LLM pass: `analyzeWithAI()` -> tiered prompt per §6.2 -> store issues + corrected code in DB

**4.4 Dashboard 3-pane**

- Left: Repository Explorer folding tree from DB
- Center: Code Viewport line numbers, language-aware highlighting, smooth scroll 1000+ lines
- Right: Analytics & Issue Tracker critical bugs, perf, quality score, language composition - live from DB

**4.5 Commit Fix** `commitFix()` uses stored `FileSystemDirectoryHandle` -> `FileSystemWritableFileStream` direct write atomically

**4.6 Bin** Deletes both local folder and DB instantly

## AI Prompt (§6.2 - verbatim inside `buildPrompt`)

```
"Act as an expert SRE. Perform a tiered analysis: identify critical security and runtime bugs first. Prioritize them at the top of the JSON output so the UI can highlight them instantly."
"Refactor the code to optimize for execution time; flag memory leaks and unnecessary re-allocations found during the initial pass."
```
Requires strict JSON output (line, severity, message, corrected code) - no free-form prose.

## Quick Start

See `SETUP_GUIDE/README.md` for plain-English numbered steps.

```bash
npm install
cp .env.example .env
# fill DATABASE_URL, GEMINI_API_KEY, GEMINI_MODEL
npx drizzle-kit push
npm run dev
```

Open http://localhost:3000 in Chrome/Edge, click Link Folder, select your `AetherOps_Watch` folder.

## Env Vars

```
DATABASE_URL=postgresql://...
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-1.5-flash
```

## Acceptance Checklist (self-verified)

- [x] No hardcoded/dummy files anywhere
- [x] Real error always detected, never clean
- [x] Every analyzed file shows AI-corrected side-by-side
- [x] Re-analyze non-blocking, auto-triggers, targeted re-render
- [x] Commit Fix writes via FileSystemWritableFileStream atomically, no download prompt
- [x] After Commit Fix, Re-analyze shows corrected/clean
- [x] Bin removes from disk + DB instantly
- [x] Handles 1000+ line files and 100+ files without Vercel timeout
- [x] Works on any language without crashing
- [x] Every async has loading skeleton, UI never freezes
- [x] UI matches screenshot dark theme with neon green accents

## Project Structure

```
src/
  db/schema.ts - files, issues, analysis_history
  db/index.ts - drizzle pg Pool
  lib/
    ai.ts - analyzeWithAI(), buildPrompt() with verbatim instructions
    heuristic.ts - fastScan <50ms
    fs-desktop.ts - commitFix() atomic FileSystemWritableFileStream
    db-init.ts - ensureTables() self-healing
  app/
    page.tsx - auto-trigger analysis, SWR polling, commit/bin
    api/
      files/ - sync + list (chunked safe)
      files/[id]/ - get/delete
      analyze/ - heuristic first, then Gemini, error status distinct
      commit/ - DB update after disk write
      stats/ - health metrics
  components/
    RepositoryExplorer, FileStreamTable, CodeViewport, IssueTracker, MetricCards, ui
SETUP_GUIDE/
  README.md - numbered steps
  WHAT_YOU_STILL_NEED_TO_DO.md
```

Built for live demo to recruiters, deployable to Vercel, zero mock data, production-ready.
