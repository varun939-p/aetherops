import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { files, workspaces } from "@/db/schema";
import { assertLocalRequest, handle, ok, readJson } from "@/lib/api";
import { commitSchema } from "@/lib/contracts";
import { assertSchemaReady } from "@/lib/db-init";
import { commitPatch } from "@/server/commit";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * POST /api/commit { fileId, baseHash, writtenHash?, git? }
 * Applies the stored patch for `fileId` (server mode writes to disk here; browser mode must have
 * written it already and report the verified hash), marks resolved issues fixed, and optionally
 * creates a git commit for that single file.
 */
export const POST = handle(async (req: NextRequest) => {
  await assertSchemaReady();
  const input = await readJson(req, commitSchema, 16 * 1024);
  const db = await getDb();
  const [row] = await db
    .select({ kind: workspaces.kind })
    .from(files)
    .innerJoin(workspaces, eq(workspaces.id, files.workspaceId))
    .where(eq(files.id, input.fileId))
    .limit(1);
  if (row?.kind === "server") assertLocalRequest(req);
  const result = await commitPatch(db, input);
  return ok(result, { gitCommitted: result.gitSha !== null });
});
