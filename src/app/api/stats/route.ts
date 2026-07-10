import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { files, issues } from "@/db/schema";
import { ensureTables } from "@/lib/db-init";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureTables();
    const allFiles = await db.select().from(files);
    const allIssues = await db.select().from(issues);

    const total = allFiles.length;
    const byStatus: Record<string, number> = {};
    const byLang: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};

    let totalLines = 0;
    let totalQuality = 0;
    let qualityCount = 0;

    for (const f of allFiles) {
      byStatus[f.status] = (byStatus[f.status] || 0) + 1;
      byLang[f.language] = (byLang[f.language] || 0) + 1;
      totalLines += f.lineCount || 0;
      if (f.qualityScore) {
        totalQuality += f.qualityScore;
        qualityCount++;
      }
    }

    for (const iss of allIssues) {
      bySeverity[iss.severity] = (bySeverity[iss.severity] || 0) + 1;
    }

    const clean = byStatus["clean"] || 0;
    const issuesCount = byStatus["issues"] || 0;
    const pending = byStatus["pending"] || 0;
    const error = byStatus["error"] || 0;
    const analyzing = byStatus["analyzing"] || 0;

    const health = total === 0 ? 100 : Math.round(((clean / total) * 100 + (qualityCount ? totalQuality / qualityCount : 100)) / 2);
    const avgQuality = qualityCount ? Math.round(totalQuality / qualityCount) : 0;

    return NextResponse.json({
      totalFiles: total,
      totalLines,
      totalIssues: allIssues.length,
      byStatus,
      byLang,
      bySeverity,
      health: Math.min(99.9, health), // cap like screenshot 99.9
      avgQuality,
      clean,
      issuesCount,
      pending,
      error,
      analyzing,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message, totalFiles: 0, health: 0 }, { status: 500 });
  }
}
