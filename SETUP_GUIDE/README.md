# AetherOps — Setup Guide

1. **Install Node 20.12+ and git.** Check with `node -v` and `git --version`.
2. **Install dependencies:** `npm install`
3. **Create `.env`:** copy `.env.example` to `.env` and set:
   - `DATABASE_URL` — a Postgres URL (local, Neon, Supabase), or `pglite:./.data/pglite` for the embedded database that needs no server.
   - `AETHEROPS_ALLOWED_ROOTS` — the folder(s) AetherOps may read and write, e.g. `C:\Users\you\Desktop`. Without it only the browser folder picker is available.
   - `GEMINI_API_KEY` and `GEMINI_MODEL` (optional) — enable AI analysis and patches. Without them the deterministic engine runs offline.
4. **Create the schema:** `npm run db:migrate`
   - On a database used by the earlier prototype, the first migration drops the old `files`, `issues` and `analysis_history` tables. They only contained copies of local files and analysis results; re-link your folder to rebuild them.
5. **Run:** `npm run dev`, then open http://localhost:3000.
6. **Link a workspace:** *Link workspace* → paste an absolute path inside `AETHEROPS_ALLOWED_ROOTS` → *Link*. (Or *Choose folder…* in Chrome/Edge for browser mode.)
7. **Work the loop:** select a file → review findings (click one to jump to its line) → *Review patch* → *Apply & commit patch* (tick *git commit* to commit just that file).

## Verifying an install

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

`npm test` runs entirely locally: an in-memory database, a temporary git repository, and a fake AI provider.
