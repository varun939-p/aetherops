import { sql } from "drizzle-orm";
import { getDb, rowsOf } from "@/db";
import { AppError } from "./errors";

/**
 * Schema is owned by versioned migrations (`npm run db:migrate`), never by request-time DDL.
 * This check only verifies the migrated shape is present and caches a positive result.
 */
declare global {
  var __aetherSchemaReady: boolean | undefined;
}

export async function assertSchemaReady(): Promise<void> {
  if (globalThis.__aetherSchemaReady) return;
  const db = await getDb();
  const result = await db.execute(sql`
    select
      to_regclass('public.workspaces') is not null as has_workspaces,
      to_regclass('public.scans') is not null as has_scans,
      exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'files' and column_name = 'content_hash'
      ) as has_hash
  `);
  const [row] = rowsOf<{ has_workspaces: boolean; has_scans: boolean; has_hash: boolean }>(result);
  if (!row?.has_workspaces || !row.has_scans || !row.has_hash) {
    throw new AppError(
      503,
      "SCHEMA_NOT_MIGRATED",
      "Database schema is not migrated. Run `npm run db:migrate`, then retry."
    );
  }
  globalThis.__aetherSchemaReady = true;
}
