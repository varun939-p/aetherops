# What You Still Need to Do

These steps need your credentials or your decision, so they are not automated.

1. **Choose where the database lives and migrate it.**
   - Keep Neon: run `npm run db:migrate` once. This drops the prototype tables (cached file copies and analysis only) and creates the new schema.
   - Or go fully local: set `DATABASE_URL=pglite:./.data/pglite`, then `npm run db:migrate`.
2. **Grant filesystem scope.** Add `AETHEROPS_ALLOWED_ROOTS=<folder>` to `.env` (for example your Desktop, or a single repository) to enable server mode, git commits, and atomic disk writes.
3. **Rotate the Gemini key if the old deployment was public.** The prototype's `GET /api/files` was unauthenticated and its folder sync uploaded `.env` files; any key that was ever inside a synced folder should be treated as exposed.
4. **Decide on the Vercel deployment.** Hosted instances run in browser mode only and have no authentication. Either keep it private (Vercel deployment protection) or take it down.
5. **(Optional) Demo data.** Link `Desktop\AetherOps_Watch`; `broken_logger.py` exercises the typo detectors and the AI patch flow.
