import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { files, issues, scans, workspaces, type IssueRecord, type ScanRecord, type WorkspaceRecord } from "@/db/schema";
import type { FileDetailDto, FileSummaryDto, IssueDto, ScanDto, WorkspaceDto } from "@/lib/contracts";
import { notFound } from "@/lib/errors";

/** Read models: every list query selects summaries only; file content is returned by the detail query alone. */

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export function toWorkspaceDto(ws: WorkspaceRecord, fileCount: number): WorkspaceDto {
  return {
    id: ws.id,
    kind: ws.kind,
    name: ws.name,
    rootPath: ws.rootPath,
    isGitRepo: ws.isGitRepo,
    gitBranch: ws.gitBranch,
    lastSyncedAt: iso(ws.lastSyncedAt),
    fileCount,
  };
}

export function toIssueDto(row: IssueRecord, path?: string): IssueDto {
  return {
    id: row.id,
    fileId: row.fileId,
    path,
    ruleId: row.ruleId,
    title: row.title,
    message: row.message,
    remediation: row.remediation,
    severity: row.severity,
    category: row.category,
    source: row.source,
    status: row.status,
    line: row.line,
    column: row.column,
    endLine: row.endLine,
    endColumn: row.endColumn,
    fixedAt: iso(row.fixedAt),
  };
}

export function toScanDto(row: ScanRecord, path: string | null = null): ScanDto {
  return {
    id: row.id,
    fileId: row.fileId,
    path,
    kind: row.kind,
    status: row.status,
    engine: row.engine,
    modelUsed: row.modelUsed,
    filesTotal: row.filesTotal,
    filesScanned: row.filesScanned,
    filesSkipped: row.filesSkipped,
    issuesFound: row.issuesFound,
    durationMs: row.durationMs,
    error: row.error,
    startedAt: new Date(row.startedAt).toISOString(),
  };
}

export async function getWorkspaceOr404(db: AppDb, id: number): Promise<WorkspaceRecord> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1);
  if (!ws) throw notFound(`Workspace ${id}`);
  return ws;
}

export async function listWorkspaceDtos(db: AppDb): Promise<WorkspaceDto[]> {
  const counts = db
    .select({ workspaceId: files.workspaceId, n: sql<number>`count(*)::int`.as("n") })
    .from(files)
    .groupBy(files.workspaceId)
    .as("counts");
  const rows = await db
    .select({ ws: workspaces, n: counts.n })
    .from(workspaces)
    .leftJoin(counts, eq(counts.workspaceId, workspaces.id))
    .orderBy(desc(workspaces.updatedAt));
  return rows.map((r) => toWorkspaceDto(r.ws, r.n ?? 0));
}

/**
 * Files whose analysis lease expired (process crash, client abort, serverless timeout) are returned
 * to `pending` so they never stay stuck in `analyzing`.
 */
export async function recoverExpiredLeases(db: AppDb, workspaceId: number): Promise<number> {
  const recovered = await db
    .update(files)
    .set({ status: "pending", leaseExpiresAt: null, errorMessage: "Previous analysis was interrupted before completing" })
    .where(and(eq(files.workspaceId, workspaceId), eq(files.status, "analyzing"), lt(files.leaseExpiresAt, sql`now()`)))
    .returning({ id: files.id });
  return recovered.length;
}

function summarySelection() {
  const open = sql`${issues.fileId} = ${files.id} and ${issues.status} = 'open'`;
  return {
    id: files.id,
    path: files.path,
    language: files.language,
    status: files.status,
    engine: files.engine,
    contentHash: files.contentHash,
    analyzedHash: files.analyzedHash,
    lineCount: files.lineCount,
    fileSize: files.fileSize,
    qualityScore: files.qualityScore,
    updatedAt: files.updatedAt,
    hasPatch: sql<boolean>`(${files.correctedContent} is not null and ${files.correctedForHash} = ${files.contentHash})`,
    openIssues: sql<number>`(select count(*)::int from ${issues} where ${open})`,
    criticalIssues: sql<number>`(select count(*)::int from ${issues} where ${open} and ${issues.severity} = 'critical')`,
    highIssues: sql<number>`(select count(*)::int from ${issues} where ${open} and ${issues.severity} = 'high')`,
  };
}

type SummaryRow = {
  id: number;
  path: string;
  language: string;
  status: FileSummaryDto["status"];
  engine: FileSummaryDto["engine"];
  contentHash: string;
  analyzedHash: string | null;
  lineCount: number;
  fileSize: number;
  qualityScore: number | null;
  updatedAt: Date;
  hasPatch: boolean;
  openIssues: number;
  criticalIssues: number;
  highIssues: number;
};

function toSummary(r: SummaryRow): FileSummaryDto {
  return {
    id: r.id,
    path: r.path,
    language: r.language,
    status: r.status,
    engine: r.engine,
    contentHash: r.contentHash,
    stale: r.analyzedHash !== r.contentHash,
    lineCount: r.lineCount,
    fileSize: r.fileSize,
    qualityScore: r.qualityScore,
    openIssues: Number(r.openIssues),
    criticalIssues: Number(r.criticalIssues),
    highIssues: Number(r.highIssues),
    hasPatch: Boolean(r.hasPatch),
    updatedAt: new Date(r.updatedAt).toISOString(),
  };
}

export async function listFileSummaries(db: AppDb, workspaceId: number): Promise<FileSummaryDto[]> {
  const rows = await db.select(summarySelection()).from(files).where(eq(files.workspaceId, workspaceId)).orderBy(asc(files.path));
  return rows.map((r) => toSummary(r as SummaryRow));
}

export async function getFileDetail(db: AppDb, fileId: number): Promise<FileDetailDto> {
  const [row] = await db
    .select({ ...summarySelection(), workspaceId: files.workspaceId, content: files.content, eol: files.eol, correctedContent: files.correctedContent, correctedForHash: files.correctedForHash, summary: files.summary, errorMessage: files.errorMessage, modelUsed: files.modelUsed, lastAnalyzedAt: files.lastAnalyzedAt })
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1);
  if (!row) throw notFound(`File ${fileId}`);

  const [issueRows, scanRows] = await Promise.all([
    db
      .select()
      .from(issues)
      .where(eq(issues.fileId, fileId))
      .orderBy(asc(issues.status), asc(issues.severity), asc(issues.line), asc(issues.column))
      .limit(1000),
    db.select().from(scans).where(eq(scans.fileId, fileId)).orderBy(desc(scans.startedAt)).limit(10),
  ]);

  const patchCommittable = row.correctedContent !== null && row.correctedForHash === row.contentHash;
  return {
    ...toSummary(row as SummaryRow),
    workspaceId: row.workspaceId,
    content: row.content,
    eol: row.eol,
    correctedContent: patchCommittable ? row.correctedContent : null,
    patchCommittable,
    summary: row.summary,
    errorMessage: row.errorMessage,
    modelUsed: row.modelUsed,
    lastAnalyzedAt: iso(row.lastAnalyzedAt),
    issues: issueRows.map((i) => toIssueDto(i, row.path)),
    scans: scanRows.map((s) => toScanDto(s, row.path)),
  };
}
