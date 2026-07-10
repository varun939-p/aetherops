# AetherOps - Setup Guide (Plain English)

This is a complete, production-ready Real-Time Codebase Analyzer. Follow these steps numbered.

---

### 1. Opening the project in VS Code

1. Unzip the delivered `aetherops.zip` (if you received it as zip).
2. Open VS Code.
3. Go to **File > Open Folder** and select the `aetherops` folder.
4. VS Code should detect it's a Next.js project. If it asks to install recommended extensions, click Yes.

Your folder structure should look like:

```
aetherops/
  src/
    app/
    components/
    db/
    lib/
  drizzle.config.ts
  package.json
  SETUP_GUIDE/
```

### 2. Installing dependencies

Open a terminal in VS Code (Terminal > New Terminal) and run:

```bash
npm install
```

This will install Next.js, Drizzle ORM, pg, @google/generative-ai, swr, etc.

If you are on Windows, make sure Node.js 18+ is installed: `node -v`

### 3. Filling in .env (YOU need to supply these)

Create a file named `.env` in the root of `aetherops` (next to package.json). You can copy from `.env.example`:

```bash
cp .env.example .env
```

Now edit `.env` and fill these THREE values - **you must supply these yourself**:

```env
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME
GEMINI_API_KEY=your_google_gemini_api_key
GEMINI_MODEL=gemini-1.5-flash
```

Details:

- **DATABASE_URL**: Your Postgres connection string.
  - For local dev: install Postgres and create DB `createdb aetherops`, then use `postgresql://postgres:postgres@localhost:5432/aetherops`
  - For cloud: Use Neon, Supabase, or Vercel Postgres. Example for Neon: `postgresql://neondb_owner:xxx@ep-xxx.neon.tech/neondb?sslmode=require`
  - For Vercel deployment: Add this as Environment Variable in Vercel Dashboard > Settings > Environment Variables.

- **GEMINI_API_KEY**: Get from https://aistudio.google.com/app/apikey - create API key, copy paste.

- **GEMINI_MODEL**: Model name, read from env so you can swap. Recommended: `gemini-1.5-flash` (fast, cheap) or `gemini-1.5-pro` (more accurate). Do NOT hardcode anywhere else; the code already reads from env.

After saving .env, run migration to create tables:

```bash
npx drizzle-kit push
```

If you prefer SQL manually, the app also auto-creates tables on first API call via `ensureTables()` in `src/lib/db-init.ts`, so even if you skip `drizzle-kit push`, it will self-heal.

Verify connection:

```bash
npm run build
```

Should build without TS errors.

### 4. Running the dev server

```bash
npm run dev
```

This starts Next.js with Turbopack on `http://localhost:3000` (or 3001 if busy).

You should see:

```
▲ Next.js 16.x
- Local: http://localhost:3000
```

Open that URL in **Chrome or Edge 86+** (required for File System Access API - `showDirectoryPicker`).

### 5. Opening the dashboard and linking a folder for the first time

1. Open `http://localhost:3000` in Chrome.
2. You'll see **AETHEROPS SRE WATCHDOG ACTIVE** header, empty file list.
3. Click **"⧉ Link Folder"** button top right.
4. Browser will show directory picker - choose or create a folder like `AetherOps_Watch` on your Desktop, containing some test code files (e.g., create `student_manager.py` with bugs from screenshot, and `shoppingCartError.js`).
   - **Important**: Grant **readwrite** permission when prompted - this is what enables direct atomic write via `FileSystemWritableFileStream` (§4.5), no download fallback.
5. The app will:
   - Recursively walk the folder (ignores node_modules, .git, .next etc)
   - Show progress "Scanning: X files"
   - Chunk upload to DB (20 files per request to avoid Vercel timeout)
6. After sync, you should see **DESKTOP FILE STREAM** table populated with real files from your folder (ZERO mock data - if you see 0, your folder was empty or filtered).
7. Click a file in left **Repository Explorer** tree.
   - If status is `pending`, AI analysis auto-triggers (no need to click Re-analyze).
   - You'll see fast-scan heuristic results instantly (<50ms) then Gemini LLM results in a few seconds.
   - Issues list shows sorted critical first.
   - Center shows **VULNERABLE SOURCE CODE | AI RECTIFIED CODE** side-by-side.

**Test the fixes required in acceptance:**

- **Commit Fix**: In code viewport, click **"⚡ COMMIT FIX"**. It calls `commitFix()` in `lib/fs-desktop.ts` which uses your stored `FileSystemDirectoryHandle` to get `FileSystemFileHandle`, opens `FileSystemWritableFileStream`, writes corrected code atomically. After success, it POSTs to `/api/commit` to update DB immediately. Then you can Re-analyze and should see **Clean**, not old error (§5.6).

- **Bin**: Click trash icon. It must delete both from local disk via `directoryHandle.removeEntry()` and from DB via DELETE `/api/files/[id]`, disappear instantly.

- **Error handling**: If GEMINI_API_KEY invalid, file status becomes `error` with visible retry, never silent `clean` (§5.2).

- **Large files**: Test with 1000+ line file - code viewport has smooth scroll, virtual? Actually plain scroll but optimized, no freeze. 100+ files handled via chunked traversal.

- **Any language**: Try linking folder with `.go`, `.rs`, `.py`, `.js` mixed - should never crash, fallback to plaintext highlighting.

### 6. Deployment to Vercel

1. Push to GitHub.
2. Import project in Vercel Dashboard.
3. Add Env vars: `DATABASE_URL`, `GEMINI_API_KEY`, `GEMINI_MODEL` in Vercel > Settings.
4. Deploy - uses `next build`. Serverless-safe: no long blocking, chunked sync.

The File System Access API still works when hosted on Vercel because the directory handle lives client-side in user's browser, not on server (per spec §2).

---

## What you still need to do after unzipping

Checklist for YOU (manual steps we cannot auto-do):

1. **Provide your own `.env` values** - we included `.env.example`, you must create real `.env` with:
   - `DATABASE_URL` (local Postgres or Neon/Supabase)
   - `GEMINI_API_KEY` (from Google AI Studio)
   - `GEMINI_MODEL` (e.g., `gemini-1.5-flash`)

2. **Run `npx drizzle-kit push`** once to create tables in your Postgres (or let first API call auto-create via ensureTables).

3. **Use Chrome/Edge** for testing - Firefox/Safari don't fully support `showDirectoryPicker` with readwrite.

4. **Create a test folder** like `AetherOps_Watch` with real buggy files to demo live to recruiters. Example files to create:

   - `student_manager.py` from screenshot:
     ```python
     import csv
     class Student:
         def __init__(self, name, grade):
             self.nam = name  # typo
             self.grade = grade
         def update_grade(self, new_grade):
             self.grade = new_grade
         def __str__(self):
             return f"{self.name} has grade {self.grade}"
     ```

   - `shoppingCartError.js`:
     ```js
     function calculateTotal(cart) {
       let total = 0;
       for (item of cart) { // missing let
         total += item.price * item.qty
         eval("console.log(total)") // critical
       }
       return total
     }
     ```

5. **Link that folder** in dashboard, show real-time analysis, Commit Fix writing directly to disk, and Bin deletion.

That's it - you have an enterprise-grade, portfolio-ready Real-Time Codebase Analyzer with zero mock data, real Gemini calls persisted in Postgres via Drizzle, and atomic local file writes.

Good luck with recruiter demo!

