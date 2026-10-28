import { and, desc, eq, sql } from "drizzle-orm";
import { rowsOf, type AppDb } from "@/db";
import { files, scans } from "@/db/schema";
import type { Category, FileStatusDto, Severity, StatsDto } from "@/lib/contracts";
import { toScanDto } from "./queries";

/**
 * All telemetry is aggregated in SQL from persisted state. Health Index is a criticality-weighted
 * mean of per-file health (100 minus severity penalties of open issues), where each analyzed file
 * weighs 1 + ln(1 + LOC) so large modules dominate small ones without drowning them out.
 */
export async function computeStats(db: AppDb, workspaceId: number): Promise<StatsDto> {
  const fileAgg = rowsOf<{
    total: number;
    analyzed: number;
    loc: number;
    analyzed_loc: number;
    pending: number;
    analyzing: number;
    issues: number;
    clean: number;
    error: number;
  }>(
    await db.execute(sql`
      select
        count(*)::int as total,
        count(*) filter (where analyzed_hash = content_hash)::int as analyzed,
        coalesce(sum(line_count), 0)::int as loc,
        coalesce(sum(line_count) filter (where analyzed_hash = content_hash), 0)::int as analyzed_loc,
        count(*) filter (where status = 'pending')::int as pending,
        count(*) filter (where status = 'analyzing')::int as analyzing,
        count(*) filter (where status = 'issues')::int as issues,
        count(*) filter (where status = 'clean')::int as clean,
        count(*) filter (where status = 'error')::int as error
      from files where workspace_id = ${workspaceId}
    `)
  )[0];

  const issueAgg = rowsOf<{ status: "open" | "fixed"; severity: Severity; category: Category; source: "heuristic" | "ai"; n: number }>(
    await db.execute(sql`
      select status, severity, category, source, count(*)::int as n
      from issues where workspace_id = ${workspaceId}
      group by status, severity, category, source
    `)
  );

  const health = rowsOf<{ health: number | null }>(
    await db.execute(sql`
      with penalties as (
        select file_id,
          sum(case severity when 'critical' then 20 when 'high' then 10 when 'medium' then 4 when 'low' then 1 else 0 end) as penalty
        from issues where workspace_id = ${workspaceId} and status = 'open'
        group by file_id
      )
      select (sum((1 + ln(1 + f.line_count)) * greatest(0, 100 - coalesce(p.penalty, 0)))
              / nullif(sum(1 + ln(1 + f.line_count)), 0))::float8 as health
      from files f left join penalties p on p.file_id = f.id
      where f.workspace_id = ${workspaceId} and f.analyzed_hash = f.content_hash
    `)
  )[0];

  const latency = rowsOf<{ mean: number | null; p95: number | null; samples: number }>(
    await db.execute(sql`
      select avg(duration_ms)::float8 as mean,
             percentile_cont(0.95) within group (order by duration_ms)::float8 as p95,
             count(*)::int as samples
      from (
        select duration_ms from scans
        where workspace_id = ${workspaceId} and kind = 'file' and status <> 'running' and duration_ms is not null
        order by started_at desc limit 50
      ) recent
    `)
  )[0];

  const recent = await db
    .select({ scan: scans, path: files.path })
    .from(scans)
    .leftJoin(files, eq(files.id, scans.fileId))
    .where(and(eq(scans.workspaceId, workspaceId)))
    .orderBy(desc(scans.startedAt))
    .limit(12);

  const bySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const byCategory: Record<Category, number> = { security: 0, reliability: 0, performance: 0, concurrency: 0, maintainability: 0 };
  const bySource: Record<"heuristic" | "ai", number> = { heuristic: 0, ai: 0 };
  let openTotal = 0;
  let fixedTotal = 0;
  for (const r of issueAgg) {
    if (r.status === "fixed") {
      fixedTotal += r.n;
      continue;
    }
    openTotal += r.n;
    bySeverity[r.severity] += r.n;
    byCategory[r.category] += r.n;
    bySource[r.source] += r.n;
  }

  const total = fileAgg?.total ?? 0;
  const analyzed = fileAgg?.analyzed ?? 0;
  const byStatus: Record<FileStatusDto, number> = {
    pending: fileAgg?.pending ?? 0,
    analyzing: fileAgg?.analyzing ?? 0,
    issues: fileAgg?.issues ?? 0,
    clean: fileAgg?.clean ?? 0,
    error: fileAgg?.error ?? 0,
  };
  const round1 = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(Number(n) * 10) / 10);

  return {
    workspaceId,
    files: { total, analyzed, stale: total - analyzed, byStatus },
    loc: { total: fileAgg?.loc ?? 0, analyzed: fileAgg?.analyzed_loc ?? 0 },
    coveragePct: total ? round1((analyzed / total) * 100) : null,
    healthIndex: round1(health?.health),
    openIssues: { total: openTotal, bySeverity, byCategory, bySource },
    fixedIssues: fixedTotal,
    scanLatency: { meanMs: round1(latency?.mean), p95Ms: round1(latency?.p95), samples: latency?.samples ?? 0 },
    recentScans: recent.map((r) => toScanDto(r.scan, r.path)),
  };
}
