import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { handle, ok, parseId } from "@/lib/api";
import { assertSchemaReady } from "@/lib/db-init";
import { AppError } from "@/lib/errors";
import { resetDemoWorkspace } from "@/server/demo";
import { getWorkspaceOr404, listWorkspaceDtos } from "@/server/queries";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/workspaces/{id}/reset — restores the sample project to its original, unfixed files. */
export const POST = handle<Ctx>(async (_req: NextRequest, { params }) => {
  await assertSchemaReady();
  const db = await getDb();
  const ws = await getWorkspaceOr404(db, parseId((await params).id));
  if (ws.kind !== "demo") throw new AppError(409, "CONFLICT", "Only the sample project can be reset");
  await resetDemoWorkspace(db, ws);
  return ok((await listWorkspaceDtos(db)).find((w) => w.id === ws.id)!);
});
