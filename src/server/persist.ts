import { and, eq, inArray } from "drizzle-orm";
import type { AppDb } from "@/db";
import { issues, type NewIssueRecord } from "@/db/schema";
import type { AnyFinding } from "@/lib/ai";

/** Shared write helpers. All callers pass a transaction handle. */

export type Tx = Parameters<Parameters<AppDb["transaction"]>[0]>[0];

const ISSUE_BATCH = 500; // 18 columns x 500 rows stays far below Postgres' 65,535 bind-parameter limit

export function findingRows(workspaceId: number, fileId: number, contentHash: string, findings: AnyFinding[]): NewIssueRecord[] {
  return findings.map((f) => ({
    workspaceId,
    fileId,
    contentHash,
    ruleId: f.ruleId.slice(0, 64),
    title: f.title.slice(0, 255),
    message: f.message,
    remediation: f.remediation || null,
    severity: f.severity,
    category: f.category,
    source: f.source,
    status: "open" as const,
    line: f.line,
    column: f.column,
    endLine: f.endLine,
    endColumn: f.endColumn,
  }));
}

export async function insertIssues(tx: Tx, rows: NewIssueRecord[]): Promise<void> {
  for (let i = 0; i < rows.length; i += ISSUE_BATCH) {
    await tx.insert(issues).values(rows.slice(i, i + ISSUE_BATCH));
  }
}

/** Replaces the open issue set of the given files; fixed issues are kept as history. */
export async function clearOpenIssues(tx: Tx, fileIds: number[]): Promise<void> {
  for (let i = 0; i < fileIds.length; i += 1000) {
    await tx.delete(issues).where(and(inArray(issues.fileId, fileIds.slice(i, i + 1000)), eq(issues.status, "open")));
  }
}

/** Splits rows into batches bounded by both row count and approximate payload bytes. */
export function batchRows<T>(rows: T[], sizeOf: (row: T) => number, maxRows = 200, maxBytes = 8 * 1024 * 1024): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = sizeOf(row);
    if (cur.length && (cur.length >= maxRows || bytes + size > maxBytes)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(row);
    bytes += size;
  }
  if (cur.length) out.push(cur);
  return out;
}
