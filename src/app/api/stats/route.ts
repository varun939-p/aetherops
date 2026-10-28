import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { handle, ok, parseId } from "@/lib/api";
import { assertSchemaReady } from "@/lib/db-init";
import { getWorkspaceOr404 } from "@/server/queries";
import { computeStats } from "@/server/stats";

export const runtime = "nodejs";

/** GET /api/stats?workspaceId=N — live aggregates computed in SQL; no synthetic values. */
export const GET = handle(async (req: NextRequest) => {
  await assertSchemaReady();
  const workspaceId = parseId(req.nextUrl.searchParams.get("workspaceId"), "workspaceId");
  const db = await getDb();
  await getWorkspaceOr404(db, workspaceId);
  return ok(await computeStats(db, workspaceId));
});
