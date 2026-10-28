import { and, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { files, scans, type FileRecord, type FileStatus } from "@/db/schema";
import { analyzeDeep, getAiConfig, type DeepAnalysis } from "@/lib/ai";
import type { AnalysisResultDto, BatchEvent, EngineDto } from "@/lib/contracts";
import { AppError, notFound } from "@/lib/errors";
import { scanSource, scoreFindings } from "@/lib/heuristic";
import { splitLines } from "@/lib/text";
import { clearOpenIssues, findingRows, insertIssues } from "./persist";
import { getFileDetail, toScanDto } from "./queries";

const LEASE_MS = 120_000;

/**
 * Claims a file for analysis. The conditional UPDATE is the lock: a second caller sees zero rows
 * unless the first lease has expired.
 */
export async function acquireLease(db: AppDb, fileId: number): Promise<FileRecord> {
  const [claimed] = await db
    .update(files)
    .set({ status: "analyzing", leaseExpiresAt: sql`now() + make_interval(secs => ${LEASE_MS / 1000})` })
    .where(and(eq(files.id, fileId), or(ne(files.status, "analyzing"), isNull(files.leaseExpiresAt), lt(files.leaseExpiresAt, sql`now()`))))
    .returning();
  if (claimed) return claimed;
  const [exists] = await db.select({ id: files.id }).from(files).where(eq(files.id, fileId)).limit(1);
  if (!exists) throw notFound(`File ${fileId}`);
  throw new AppError(409, "ANALYSIS_IN_PROGRESS", "This file is already being analyzed");
}

function heuristicOnly(file: FileRecord): DeepAnalysis {
  const result = scanSource(file.content, file.language);
  const lines = splitLines(file.content).length;
  return {
    engine: "heuristic",
    findings: result.findings,
    correctedContent: null,
    qualityScore: scoreFindings(result.findings),
    summary: `Deterministic scan: ${result.findings.length} finding(s).`,
    modelUsed: null,
    heuristicMs: result.durationMs,
    aiMs: 0,
    coverage: { totalLines: lines, analyzedLines: lines, chunks: 0, chunksAnalyzed: 0, complete: true },
    aiError: null,
    attempts: 0,
    droppedEdits: 0,
  };
}

/**
 * A file is only ever reported `clean` when the requested analysis fully covered it. A configured AI
 * provider that failed, or analyzed part of the file, yields `error` unless findings already exist.
 */
export function deriveStatus(result: DeepAnalysis, requested: EngineDto, aiConfigured: boolean): FileStatus {
  const hasFindings = result.findings.length > 0;
  if (requested === "hybrid" && aiConfigured) {
    if (result.engine === "heuristic") return "error";
    if (!result.coverage.complete) return hasFindings ? "issues" : "error";
  }
  return hasFindings ? "issues" : "clean";
}

export async function analyzeFile(db: AppDb, fileId: number, requested: EngineDto): Promise<AnalysisResultDto> {
  const started = performance.now();
  const file = await acquireLease(db, fileId);
  const aiConfigured = getAiConfig() !== null;

  let result: DeepAnalysis;
  try {
    result = requested === "hybrid" ? await analyzeDeep(file.content, file.path, file.language) : heuristicOnly(file);
  } catch (err) {
    await db
      .update(files)
      .set({ status: "error", leaseExpiresAt: null, errorMessage: err instanceof Error ? err.message : "Analysis failed" })
      .where(eq(files.id, fileId));
    throw err;
  }

  const status = deriveStatus(result, requested, aiConfigured);
  const scanDurationMs = Math.round(performance.now() - started);
  const aiFailed = status === "error";

  await db.transaction(async (tx) => {
    // Guarded on content_hash: if a sync replaced the content mid-analysis, these results are stale.
    const [updated] = await tx
      .update(files)
      .set({
        status,
        engine: result.engine,
        analyzedHash: file.contentHash,
        // A failed AI pass keeps any earlier patch for this exact content instead of discarding it.
        ...(aiFailed ? {} : { correctedContent: result.correctedContent, correctedForHash: result.correctedContent ? file.contentHash : null }),
        qualityScore: result.qualityScore,
        summary: result.summary,
        errorMessage: result.aiError,
        modelUsed: result.modelUsed,
        leaseExpiresAt: null,
        lastAnalyzedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(files.id, fileId), eq(files.contentHash, file.contentHash)))
      .returning({ id: files.id });
    if (!updated) throw new AppError(409, "STALE_CONTENT", "File content changed during analysis; results were discarded");

    await clearOpenIssues(tx, [fileId]);
    await insertIssues(tx, findingRows(file.workspaceId, fileId, file.contentHash, result.findings));
    await tx.insert(scans).values({
      workspaceId: file.workspaceId,
      fileId,
      kind: "file",
      status: aiFailed ? "failed" : result.coverage.complete ? "completed" : "partial",
      engine: result.engine,
      modelUsed: result.modelUsed,
      filesTotal: 1,
      filesScanned: 1,
      issuesFound: result.findings.length,
      durationMs: scanDurationMs,
      error: result.aiError,
      meta: { requested, heuristicMs: result.heuristicMs, aiMs: result.aiMs, attempts: result.attempts, droppedEdits: result.droppedEdits, coverage: result.coverage },
      finishedAt: sql`now()`,
    });
  });

  return {
    file: await getFileDetail(db, fileId),
    engine: result.engine,
    scanDurationMs,
    heuristicMs: result.heuristicMs,
    aiMs: result.aiMs,
    aiError: result.aiError,
    coverage: result.coverage,
  };
}

/** Runs a workspace scan, emitting one event per file. Per-file failures never abort the batch. */
export async function runBatch(db: AppDb, workspaceId: number, scope: "changed" | "all", requested: EngineDto, emit: (e: BatchEvent) => void): Promise<void> {
  const started = performance.now();
  const needsWork =
    scope === "all"
      ? undefined
      : or(
          sql`${files.analyzedHash} is distinct from ${files.contentHash}`,
          eq(files.status, "pending"),
          eq(files.status, "error"),
          requested === "hybrid" ? sql`${files.engine} is distinct from 'hybrid'` : sql`false`
        );
  const targets = await db
    .select({ id: files.id, path: files.path })
    .from(files)
    .where(needsWork ? and(eq(files.workspaceId, workspaceId), needsWork) : eq(files.workspaceId, workspaceId))
    .orderBy(files.path);
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(files).where(eq(files.workspaceId, workspaceId));
  const engine: EngineDto = requested === "hybrid" && getAiConfig() ? "hybrid" : "heuristic";

  const [scan] = await db
    .insert(scans)
    .values({ workspaceId, kind: "batch", status: "running", engine, modelUsed: engine === "hybrid" ? getAiConfig()!.model : null, filesTotal: targets.length, filesSkipped: total - targets.length })
    .returning();
  emit({ type: "start", scanId: scan.id, total: targets.length, skipped: total - targets.length, engine });

  let scanned = 0;
  let failures = 0;
  let issuesFound = 0;
  let firstError: string | null = null;
  const queue = targets.map((t, index) => ({ ...t, index }));
  const workers = engine === "hybrid" ? 2 : 4;

  await Promise.all(
    Array.from({ length: Math.min(workers, queue.length) }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        const fileStarted = performance.now();
        try {
          const res = await analyzeFile(db, t.id, engine);
          scanned++;
          const open = res.file.issues.filter((i) => i.status === "open").length;
          issuesFound += open;
          if (res.file.status === "error") failures++;
          emit({ type: "file", index: t.index, total: targets.length, fileId: t.id, path: t.path, status: res.file.status, findings: open, durationMs: Math.round(performance.now() - fileStarted), error: res.aiError });
        } catch (err) {
          failures++;
          const message = err instanceof Error ? err.message : String(err);
          firstError ??= `${t.path}: ${message}`;
          emit({ type: "file", index: t.index, total: targets.length, fileId: t.id, path: t.path, status: "error", findings: 0, durationMs: Math.round(performance.now() - fileStarted), error: message });
        }
      }
    })
  );

  const status = targets.length === 0 || failures === 0 ? "completed" : failures >= targets.length ? "failed" : "partial";
  const [done] = await db
    .update(scans)
    .set({ status, filesScanned: scanned, issuesFound, durationMs: Math.round(performance.now() - started), error: firstError, finishedAt: sql`now()` })
    .where(eq(scans.id, scan.id))
    .returning();
  emit({ type: "done", scan: toScanDto(done) });
}
