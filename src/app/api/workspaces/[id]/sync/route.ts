import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { assertLocalRequest, handle, ok, parseId, readJson } from "@/lib/api";
import { manifestSchema, type SyncResultDto } from "@/lib/contracts";
import { assertSchemaReady } from "@/lib/db-init";
import { AppError } from "@/lib/errors";
import { walkWorkspace } from "@/lib/fs-desktop";
import { getWorkspaceOr404, listWorkspaceDtos } from "@/server/queries";
import { applyManifest, applySync } from "@/server/sync";
import { refreshGit } from "@/server/workspaces";

export const runtime = "nodejs";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/**
 * server workspace: walks the root on disk and applies a delta sync (no body).
 * browser workspace: body is the client's manifest ({ entries: [{ path, hash }] }); vanished files are
 * pruned and the response lists paths whose content must be uploaded via POST /api/files.
 */
export const POST = handle<Ctx>(async (req: NextRequest, { params }) => {
  await assertSchemaReady();
  const db = await getDb();
  let ws = await getWorkspaceOr404(db, parseId((await params).id));

  if (ws.kind === "demo") {
    throw new AppError(409, "CONFLICT", "The sample project has no folder to sync; use POST /api/workspaces/{id}/reset to restore it");
  }
  if (ws.kind === "browser") {
    const { entries } = await readJson(req, manifestSchema, 4 * 1024 * 1024);
    return ok(await applyManifest(db, ws, entries));
  }

  assertLocalRequest(req);
  const started = performance.now();
  ws = await refreshGit(db, ws);
  const walk = await walkWorkspace(ws.rootPath);
  const skipped = Object.values(walk.skipped).reduce((a, b) => a + b, 0);
  const counts = await applySync(db, ws, walk.files, { prune: true, skipped, truncated: walk.truncated });
  const workspace = (await listWorkspaceDtos(db)).find((w) => w.id === ws.id)!;
  const result: SyncResultDto = { workspace, ...counts, skipped, truncated: walk.truncated, durationMs: Math.round(performance.now() - started) };
  return ok(result, { skippedBreakdown: walk.skipped });
});
