import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { workspaces } from "@/db/schema";
import { handle, ok, parseId } from "@/lib/api";
import { assertSchemaReady } from "@/lib/db-init";
import { getWorkspaceOr404, listWorkspaceDtos } from "@/server/queries";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle<Ctx>(async (_req: NextRequest, { params }) => {
  await assertSchemaReady();
  const id = parseId((await params).id);
  const db = await getDb();
  await getWorkspaceOr404(db, id);
  const dto = (await listWorkspaceDtos(db)).find((w) => w.id === id)!;
  return ok(dto);
});

/** Unlinks a workspace: removes its stored files, issues, and scans. Never touches the disk. */
export const DELETE = handle<Ctx>(async (_req: NextRequest, { params }) => {
  await assertSchemaReady();
  const id = parseId((await params).id);
  const db = await getDb();
  await getWorkspaceOr404(db, id);
  await db.delete(workspaces).where(eq(workspaces.id, id));
  return ok({ id, deleted: true });
});
