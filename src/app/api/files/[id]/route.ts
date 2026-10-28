import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { files, workspaces } from "@/db/schema";
import { assertLocalRequest, handle, ok, parseId } from "@/lib/api";
import { assertSchemaReady } from "@/lib/db-init";
import { notFound } from "@/lib/errors";
import { deleteWorkspaceFile } from "@/lib/fs-desktop";
import { getFileDetail } from "@/server/queries";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** Full file: content, committable patch, open + fixed issues, and recent scans. */
export const GET = handle<Ctx>(async (_req: NextRequest, { params }) => {
  await assertSchemaReady();
  return ok(await getFileDetail(await getDb(), parseId((await params).id)));
});

/**
 * DELETE /api/files/{id}?disk=1 — removes the file record. With disk=1 on a server workspace the file
 * is deleted from disk first; the DB row is only removed once the disk operation succeeded.
 * Browser workspaces delete through the client's directory handle before calling this.
 */
export const DELETE = handle<Ctx>(async (req: NextRequest, { params }) => {
  await assertSchemaReady();
  const id = parseId((await params).id);
  const db = await getDb();
  const [row] = await db
    .select({ path: files.path, kind: workspaces.kind, rootPath: workspaces.rootPath })
    .from(files)
    .innerJoin(workspaces, eq(workspaces.id, files.workspaceId))
    .where(eq(files.id, id))
    .limit(1);
  if (!row) throw notFound(`File ${id}`);

  let removedFromDisk = false;
  if (req.nextUrl.searchParams.get("disk") === "1" && row.kind === "server") {
    assertLocalRequest(req);
    removedFromDisk = await deleteWorkspaceFile(row.rootPath, row.path);
  }
  await db.delete(files).where(eq(files.id, id));
  return ok({ id, path: row.path, removedFromDisk });
});
