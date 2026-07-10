# What You Still Need to Do (Manual)

After unzipping the project, I have already built the full codebase with zero mock data, but YOU must do these manual steps because they require your private credentials and local machine:

### 1. Create `.env` in root

Copy `.env.example` to `.env` and fill:

```
DATABASE_URL=postgresql://...
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-1.5-flash
```

- Get DATABASE_URL from Neon (https://neon.tech) or local Postgres (`createdb aetherops`)
- Get GEMINI_API_KEY from https://aistudio.google.com/app/apikey
- GEMINI_MODEL = `gemini-1.5-flash` or `gemini-1.5-pro`

**This is mandatory - without it, API routes will return visible `error` status per §5.2, never fake clean.**

### 2. Push DB schema

```bash
npx drizzle-kit push
```

Or skip - app auto-creates tables on first request via `ensureTables()` in `src/lib/db-init.ts`.

### 3. Install & Run

```bash
npm install
npm run dev
```

Open http://localhost:3000 in **Chrome/Edge only** (File System Access API requirement).

### 4. Create a demo folder

On Desktop, create `AetherOps_Watch` with 2 buggy files to match screenshot:

- `student_manager.py` with typos + missing validation
- `shoppingCartError.js` with eval + XSS

Then in dashboard click "Link Folder" and select that folder with readwrite permission.

### 5. Demo flows for recruiters

- Show Desktop Sync Active
- Click file -> auto analysis (pending -> analyzing -> issues/clean)
- Show side-by-side AI rectified code
- Click Commit Fix -> verify file on disk changed (no download prompt, direct FileSystemWritableFileStream write)
- Click Re-analyze -> should now show Clean
- Click Bin -> file deleted from disk + DB instantly
- Show handling of 1000+ line files and any language extension without crash

### 6. Vercel Deploy (optional)

- Push to GitHub
- Import in Vercel
- Add same 3 env vars in Vercel dashboard
- Deploy - despite being hosted, local file write still works because handle lives in browser

That's all you need to do.

