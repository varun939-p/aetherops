import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { files, issues, analysisHistory } from "@/db/schema";
import { eq } from "drizzle-orm";
import { ensureTables } from "@/lib/db-init";
import { analyzeWithAI, analyzeHeuristicOnly } from "@/lib/ai";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // Vercel max, but we try to stay low via chunking

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  try {
    await ensureTables();
    const body = await req.json();
    const fileId = body.fileId as number | undefined;
    const filePath = body.filePath as string | undefined;
    const fastOnly = body.fastOnly as boolean | undefined;

    if (!fileId && !filePath) {
      return NextResponse.json({ error: "Provide fileId or filePath" }, { status: 400 });
    }

    let fileRecord;
    if (fileId) {
      const rows = await db.select().from(files).where(eq(files.id, fileId)).limit(1);
      fileRecord = rows[0];
    } else if (filePath) {
      const rows = await db.select().from(files).where(eq(files.path, filePath)).limit(1);
      fileRecord = rows[0];
    }

    if (!fileRecord) {
      return NextResponse.json({ error: "File not found in DB" }, { status: 404 });
    }

    // Set analyzing status immediately
    await db
      .update(files)
      .set({ status: "analyzing", updatedAt: new Date(), errorMessage: null })
      .where(eq(files.id, fileRecord.id));

    // Fast-scan pass (<50ms)
    const fastResult = analyzeHeuristicOnly(fileRecord.content, fileRecord.language);

    // Save heuristic issues immediately for fast UI feedback
    await db.delete(issues).where(eq(issues.fileId, fileRecord.id));
    if (fastResult.issues.length > 0) {
      const toInsert = fastResult.issues.map((iss) => ({
        fileId: fileRecord.id,
        severity: iss.severity,
        line: iss.line,
        column: iss.column || 0,
        message: iss.message,
        source: iss.source as "heuristic",
        ruleId: iss.ruleId,
      }));
      await db.insert(issues).values(toInsert as any);
    }

    if (fastOnly) {
      // Only fast-scan requested
      await db
        .update(files)
        .set({
          status: fastResult.issues.length > 0 ? "issues" : "clean",
          qualityScore: fastResult.issues.length > 0 ? 60 : 90,
          lastAnalyzedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(files.id, fileRecord.id));

      const updatedIssues = await db.select().from(issues).where(eq(issues.fileId, fileRecord.id));
      return NextResponse.json({
        stage: "heuristic",
        fileId: fileRecord.id,
        issues: updatedIssues,
        durationMs: fastResult.durationMs,
        status: fastResult.issues.length > 0 ? "issues" : "clean",
      });
    }

    // LLM pass
    try {
      const aiResult = await analyzeWithAI(fileRecord.content, fileRecord.path, fileRecord.language);

      // Replace issues with merged result
      await db.delete(issues).where(eq(issues.fileId, fileRecord.id));
      if (aiResult.issues.length > 0) {
        const toInsert = aiResult.issues.map((iss) => ({
          fileId: fileRecord.id,
          severity: iss.severity,
          line: iss.line,
          column: iss.column || 0,
          message: iss.message,
          source: iss.source,
          ruleId: iss.ruleId || "ai",
        }));
        await db.insert(issues).values(toInsert as any);
      }

      const finalStatus = aiResult.issues.length > 0 ? "issues" : "clean";

      await db
        .update(files)
        .set({
          status: finalStatus,
          correctedContent: aiResult.correctedCode,
          qualityScore: aiResult.qualityScore,
          lastAnalyzedAt: new Date(),
          updatedAt: new Date(),
          modelUsed: aiResult.modelUsed,
          errorMessage: null,
        })
        .where(eq(files.id, fileRecord.id));

      await db.insert(analysisHistory).values({
        fileId: fileRecord.id,
        issuesCount: aiResult.issues.length,
        durationMs: aiResult.heuristicDurationMs + aiResult.aiDurationMs,
        modelUsed: aiResult.modelUsed,
        status: finalStatus as any,
        summary: aiResult.summary,
        rawResponse: { issues: aiResult.issues } as any,
      });

      const finalIssues = await db.select().from(issues).where(eq(issues.fileId, fileRecord.id));

      return NextResponse.json({
        stage: "complete",
        fileId: fileRecord.id,
        issues: finalIssues,
        correctedCode: aiResult.correctedCode,
        qualityScore: aiResult.qualityScore,
        summary: aiResult.summary,
        status: finalStatus,
        heuristicDurationMs: aiResult.heuristicDurationMs,
        aiDurationMs: aiResult.aiDurationMs,
        totalDurationMs: Date.now() - startTime,
      });
    } catch (aiErr: any) {
      console.error("AI analysis failed for", fileRecord.path, aiErr);

      // Per spec: Never mark clean on failure -> set error status
      await db
        .update(files)
        .set({
          status: "error",
          errorMessage: aiErr?.message || "AI analysis failed",
          updatedAt: new Date(),
          lastAnalyzedAt: new Date(),
        })
        .where(eq(files.id, fileRecord.id));

      await db.insert(analysisHistory).values({
        fileId: fileRecord.id,
        issuesCount: fastResult.issues.length,
        durationMs: Date.now() - startTime,
        modelUsed: process.env.GEMINI_MODEL || "unknown",
        status: "error" as any,
        summary: `Analysis failed: ${aiErr?.message}`,
        rawResponse: { error: aiErr?.message } as any,
      });

      // Return heuristic issues we have, but with error status
      const existingIssues = await db.select().from(issues).where(eq(issues.fileId, fileRecord.id));

      return NextResponse.json(
        {
          stage: "error",
          fileId: fileRecord.id,
          issues: existingIssues,
          error: aiErr?.message || "AI analysis failed",
          status: "error",
          durationMs: Date.now() - startTime,
          hint: "Check GEMINI_API_KEY and GEMINI_MODEL in .env, and DB connection. Retry after fixing.",
        },
        { status: 200 }
      ); // 200 with error status inside, so UI can show retry, not 500 that would default to clean
    }
  } catch (err: any) {
    console.error("POST /api/analyze fatal", err);
    return NextResponse.json(
      { error: "Analysis endpoint failed", details: err?.message || String(err), status: "error" },
      { status: 500 }
    );
  }
}

// GET for polling status
export async function GET(req: NextRequest) {
  try {
    await ensureTables();
    const { searchParams } = new URL(req.url);
    const fileId = searchParams.get("fileId");
    if (!fileId) return NextResponse.json({ error: "fileId required" }, { status: 400 });
    const id = parseInt(fileId, 10);
    const rows = await db.select().from(files).where(eq(files.id, id)).limit(1);
    if (rows.length === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const fileIssues = await db.select().from(issues).where(eq(issues.fileId, id));
    return NextResponse.json({ file: rows[0], issues: fileIssues });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message }, { status: 500 });
  }
}
