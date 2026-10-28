import { getDb } from "@/db";
import { assertLocalRequest, handle, ok, readJson } from "@/lib/api";
import { createWorkspaceSchema } from "@/lib/contracts";
import { assertSchemaReady } from "@/lib/db-init";
import { listWorkspaceDtos, toWorkspaceDto } from "@/server/queries";
import { ensureDemoWorkspace } from "@/server/demo";
import { createWorkspace } from "@/server/workspaces";

export const runtime = "nodejs";

export const GET = handle(async () => {
  await assertSchemaReady();
  const db = await getDb();
  try {
    await ensureDemoWorkspace(db);
  } catch (err) {
    // The sample project is a convenience; never let seeding block access to real workspaces.
    console.error("[demo] seeding failed:", err instanceof Error ? err.message : err);
  }
  return ok(await listWorkspaceDtos(db));
});

export const POST = handle(async (req) => {
  await assertSchemaReady();
  const input = await readJson(req, createWorkspaceSchema, 64 * 1024);
  if (input.kind === "server") assertLocalRequest(req);
  const ws = await createWorkspace(await getDb(), input);
  return ok(toWorkspaceDto(ws, 0), {}, 201);
});
