import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { handle, ok, readJson, toAppError } from "@/lib/api";
import { analyzeSchema, type BatchEvent } from "@/lib/contracts";
import { assertSchemaReady } from "@/lib/db-init";
import { analyzeFile, runBatch } from "@/server/analysis";
import { getWorkspaceOr404 } from "@/server/queries";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * { fileId, engine? }                 → single-file analysis, JSON envelope with scanDurationMs.
 * { workspaceId, scope?, engine? }    → batch scan streamed as NDJSON events (start, file…, done).
 */
export const POST = handle(async (req: NextRequest) => {
  await assertSchemaReady();
  const input = await readJson(req, analyzeSchema, 16 * 1024);
  const db = await getDb();

  if ("fileId" in input) {
    const result = await analyzeFile(db, input.fileId, input.engine);
    return ok(result, { scanDurationMs: result.scanDurationMs, engine: result.engine });
  }

  await getWorkspaceOr404(db, input.workspaceId);
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: BatchEvent) => controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      try {
        await runBatch(db, input.workspaceId, input.scope, input.engine, send);
      } catch (err) {
        const appErr = toAppError(err);
        send({ type: "error", error: { code: appErr.code, message: appErr.message } });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
});
