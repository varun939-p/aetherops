import { and, eq } from "drizzle-orm";
import type { AppDb } from "@/db";
import { files, workspaces, type WorkspaceRecord } from "@/db/schema";
import { DEMO_NAME, DEMO_ROOT_KEY, SAMPLE_FILES } from "@/demo/samples";
import { describeFile } from "@/lib/ingest";
import { applySync } from "./sync";

/**
 * The sample project lives only in the database: analysis works as usual, and applying a patch
 * updates the stored content instead of a file on disk. Disable with AETHEROPS_DEMO=off.
 */

declare global {
  var __aetherDemoReady: boolean | undefined;
}

export const demoEnabled = () => process.env.AETHEROPS_DEMO?.toLowerCase() !== "off";

async function loadSamples(ws: WorkspaceRecord, db: AppDb, prune: boolean) {
  const described = await Promise.all(SAMPLE_FILES.map((f) => describeFile(f.path, f.content)));
  await applySync(db, ws, described, { prune });
}

/** Creates and seeds the sample project once; concurrent first requests converge on one row. */
export async function ensureDemoWorkspace(db: AppDb): Promise<void> {
  if (!demoEnabled() || globalThis.__aetherDemoReady) return;
  let [ws] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.kind, "demo"), eq(workspaces.rootKey, DEMO_ROOT_KEY)))
    .limit(1);
  if (!ws) {
    [ws] = await db
      .insert(workspaces)
      .values({ kind: "demo", name: DEMO_NAME, rootPath: "Built-in sample files", rootKey: DEMO_ROOT_KEY })
      .onConflictDoNothing({ target: [workspaces.kind, workspaces.rootKey] })
      .returning();
    if (ws) await loadSamples(ws, db, false);
  }
  globalThis.__aetherDemoReady = true;
}

/** Restores the sample files to their original, unfixed content and clears their history. */
export async function resetDemoWorkspace(db: AppDb, ws: WorkspaceRecord): Promise<void> {
  await db.delete(files).where(eq(files.workspaceId, ws.id));
  await loadSamples(ws, db, true);
}
