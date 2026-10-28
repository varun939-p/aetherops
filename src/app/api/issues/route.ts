import { and, asc, eq, inArray, type SQL } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { getDb } from "@/db";
import { files, issues, issueCategoryEnum, issueSeverityEnum, type IssueCategory, type IssueSeverity } from "@/db/schema";
import { handle, ok } from "@/lib/api";
import { issuesQuerySchema } from "@/lib/contracts";
import { assertSchemaReady } from "@/lib/db-init";
import { getWorkspaceOr404, toIssueDto } from "@/server/queries";

export const runtime = "nodejs";

const csv = <T extends string>(raw: string | undefined, allowed: readonly T[]): T[] | undefined => {
  if (!raw) return undefined;
  const picked = raw.split(",").filter((v): v is T => (allowed as readonly string[]).includes(v));
  return picked.length ? picked : undefined;
};

/** GET /api/issues?workspaceId=N[&fileId][&status=open|fixed|all][&severity=a,b][&category=a,b][&source] */
export const GET = handle(async (req: NextRequest) => {
  await assertSchemaReady();
  const q = issuesQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  const db = await getDb();
  await getWorkspaceOr404(db, q.workspaceId);

  const where: SQL[] = [eq(issues.workspaceId, q.workspaceId)];
  if (q.fileId) where.push(eq(issues.fileId, q.fileId));
  if (q.status !== "all") where.push(eq(issues.status, q.status));
  if (q.source) where.push(eq(issues.source, q.source));
  const severities = csv<IssueSeverity>(q.severity, issueSeverityEnum.enumValues);
  if (severities) where.push(inArray(issues.severity, severities));
  const categories = csv<IssueCategory>(q.category, issueCategoryEnum.enumValues);
  if (categories) where.push(inArray(issues.category, categories));

  const rows = await db
    .select({ issue: issues, path: files.path })
    .from(issues)
    .innerJoin(files, eq(files.id, issues.fileId))
    .where(and(...where))
    .orderBy(asc(issues.severity), asc(files.path), asc(issues.line))
    .limit(q.limit + 1);

  return ok(
    rows.slice(0, q.limit).map((r) => toIssueDto(r.issue, r.path)),
    { truncated: rows.length > q.limit, limit: q.limit }
  );
});
