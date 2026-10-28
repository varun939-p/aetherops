import { eq, inArray, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { files, scans, workspaces, type NewFileRecord, type WorkspaceRecord } from "@/db/schema";
import type { ManifestResultDto } from "@/lib/contracts";
import { scanSource, scoreFindings, type Finding } from "@/lib/heuristic";
import type { IngestedFile } from "@/lib/ingest";
import { batchRows, clearOpenIssues, findingRows, insertIssues } from "./persist";

/**
 * Incremental (delta) sync: files are compared by SHA-256, so unchanged files are never rewritten
 * or re-analyzed. New and changed files are upserted and get an immediate deterministic scan, all
 * inside one transaction.
 */

export interface SyncCounts {
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  findings: number;
}

async function existingHashes(db: AppDb, workspaceId: number): Promise<Map<string, { id: number; hash: string }>> {
  const rows = await db.select({ id: files.id, path: files.path, hash: files.contentHash }).from(files).where(eq(files.workspaceId, workspaceId));
  return new Map(rows.map((r) => [r.path, { id: r.id, hash: r.hash }]));
}

/**
 * Upserts `incoming` files. When `prune` is set, every stored file absent from `incoming` is removed
 * (the walk is authoritative); otherwise only the given files are touched.
 */
export async function applySync(db: AppDb, ws: WorkspaceRecord, incoming: IngestedFile[], opts: { prune: boolean; skipped?: number; truncated?: boolean }): Promise<SyncCounts> {
  const started = performance.now();
  const existing = await existingHashes(db, ws.id);
  const changed = incoming.filter((f) => existing.get(f.path)?.hash !== f.hash);
  const unchanged = incoming.length - changed.length;
  const added = changed.filter((f) => !existing.has(f.path)).length;
  const present = new Set(incoming.map((f) => f.path));
  // A truncated walk is not authoritative about absent files, so pruning is suppressed.
  const removedIds = opts.prune && !opts.truncated ? [...existing].filter(([path]) => !present.has(path)).map(([, v]) => v.id) : [];

  // CPU-bound scanning happens before the transaction opens, keeping lock time short.
  const scanned = changed.map((f) => ({ file: f, findings: scanSource(f.content, f.language).findings as Finding[] }));
  const totalFindings = scanned.reduce((n, s) => n + s.findings.length, 0);

  await db.transaction(async (tx) => {
    const rows: Array<{ row: NewFileRecord; findings: Finding[] }> = scanned.map(({ file, findings }) => ({
      findings,
      row: {
        workspaceId: ws.id,
        path: file.path,
        content: file.content,
        contentHash: file.hash,
        language: file.language,
        extension: file.extension,
        eol: file.eol,
        fileSize: file.size,
        lineCount: file.lineCount,
        status: findings.length ? "issues" : "clean",
        engine: "heuristic",
        analyzedHash: file.hash,
        qualityScore: scoreFindings(findings),
        summary: `Deterministic scan: ${findings.length} finding(s).`,
      },
    }));

    for (const batch of batchRows(rows, (r) => r.row.content.length)) {
      const written = await tx
        .insert(files)
        .values(batch.map((b) => b.row))
        .onConflictDoUpdate({
          target: [files.workspaceId, files.path],
          set: {
            content: sql`excluded.content`,
            contentHash: sql`excluded.content_hash`,
            language: sql`excluded.language`,
            extension: sql`excluded.extension`,
            eol: sql`excluded.eol`,
            fileSize: sql`excluded.file_size`,
            lineCount: sql`excluded.line_count`,
            status: sql`excluded.status`,
            engine: sql`excluded.engine`,
            analyzedHash: sql`excluded.analyzed_hash`,
            qualityScore: sql`excluded.quality_score`,
            summary: sql`excluded.summary`,
            correctedContent: null,
            correctedForHash: null,
            errorMessage: null,
            modelUsed: null,
            leaseExpiresAt: null,
            lastAnalyzedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        })
        .returning({ id: files.id, path: files.path });

      const idByPath = new Map(written.map((w) => [w.path, w.id]));
      await clearOpenIssues(tx, written.map((w) => w.id));
      const issueRows = batch.flatMap((b) => findingRows(ws.id, idByPath.get(b.row.path)!, b.row.contentHash, b.findings));
      await insertIssues(tx, issueRows);
    }

    for (let i = 0; i < removedIds.length; i += 1000) {
      await tx.delete(files).where(inArray(files.id, removedIds.slice(i, i + 1000)));
    }

    await tx.update(workspaces).set({ lastSyncedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(workspaces.id, ws.id));
    await tx.insert(scans).values({
      workspaceId: ws.id,
      kind: "sync",
      status: opts.truncated ? "partial" : "completed",
      engine: "heuristic",
      filesTotal: incoming.length,
      filesScanned: changed.length,
      filesSkipped: unchanged + (opts.skipped ?? 0),
      issuesFound: totalFindings,
      durationMs: Math.round(performance.now() - started),
      meta: { added, updated: changed.length - added, removed: removedIds.length, truncated: Boolean(opts.truncated) },
      finishedAt: sql`now()`,
    });
  });

  return { added, updated: changed.length - added, unchanged, removed: removedIds.length, findings: totalFindings };
}

/**
 * Browser-mode phase 1: the client sends path+hash for every file it can see. Files that vanished
 * are pruned; the response lists paths whose content the server needs (new or changed).
 */
export async function applyManifest(db: AppDb, ws: WorkspaceRecord, entries: Array<{ path: string; hash: string }>): Promise<ManifestResultDto> {
  const existing = await existingHashes(db, ws.id);
  const present = new Set(entries.map((e) => e.path));
  const removedIds = [...existing].filter(([path]) => !present.has(path)).map(([, v]) => v.id);
  const needed = entries.filter((e) => existing.get(e.path)?.hash !== e.hash).map((e) => e.path);
  if (removedIds.length) {
    await db.transaction(async (tx) => {
      for (let i = 0; i < removedIds.length; i += 1000) await tx.delete(files).where(inArray(files.id, removedIds.slice(i, i + 1000)));
    });
  }
  if (needed.length === 0) {
    await db.update(workspaces).set({ lastSyncedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(workspaces.id, ws.id));
  }
  return { needed, removed: removedIds.length, unchanged: entries.length - needed.length };
}
