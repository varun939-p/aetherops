import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { handle, ok, parseId, readJson } from "@/lib/api";
import { uploadFilesSchema } from "@/lib/contracts";
import { assertSchemaReady } from "@/lib/db-init";
import { AppError } from "@/lib/errors";
import { describeFile } from "@/lib/ingest";
import { MAX_FILE_BYTES, isSensitiveFile, normalizeRelativePath } from "@/lib/policy";
import { getWorkspaceOr404, listFileSummaries, recoverExpiredLeases } from "@/server/queries";
import { applySync } from "@/server/sync";

export const runtime = "nodejs";
export const maxDuration = 60;

/** GET /api/files?workspaceId=N — file summaries (no content), with open-issue counts. */
export const GET = handle(async (req: NextRequest) => {
  await assertSchemaReady();
  const workspaceId = parseId(req.nextUrl.searchParams.get("workspaceId"), "workspaceId");
  const db = await getDb();
  await getWorkspaceOr404(db, workspaceId);
  const recovered = await recoverExpiredLeases(db, workspaceId);
  const files = await listFileSummaries(db, workspaceId);
  return ok(files, { total: files.length, recoveredLeases: recovered });
});

/**
 * POST /api/files — browser-mode content upload (phase 2 of a sync). Each file's hash is recomputed
 * server-side; a mismatch rejects the batch so corrupted transfers never reach the database.
 */
export const POST = handle(async (req: NextRequest) => {
  await assertSchemaReady();
  const body = await readJson(req, uploadFilesSchema, 4 * 1024 * 1024);
  const db = await getDb();
  const ws = await getWorkspaceOr404(db, body.workspaceId);
  if (ws.kind !== "browser") throw new AppError(409, "CONFLICT", "Server workspaces are synced from disk via POST /api/workspaces/{id}/sync");

  const described = await Promise.all(
    body.files.map(async (f) => {
      const path = normalizeRelativePath(f.path);
      if (!path) throw new AppError(400, "PATH_OUTSIDE_WORKSPACE", `Unsafe path: ${f.path}`);
      if (isSensitiveFile(path.split("/").pop()!)) throw new AppError(400, "VALIDATION_FAILED", `${path} matches the sensitive-file policy and cannot be stored`);
      const file = await describeFile(path, f.content);
      if (file.size > MAX_FILE_BYTES) throw new AppError(413, "PAYLOAD_TOO_LARGE", `${path} exceeds ${MAX_FILE_BYTES} bytes`);
      if (file.hash !== f.hash) throw new AppError(422, "INTEGRITY_FAILED", `Hash mismatch for ${path}`);
      return file;
    })
  );
  const counts = await applySync(db, ws, described, { prune: false });
  return ok(counts);
});
