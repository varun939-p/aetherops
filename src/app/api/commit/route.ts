import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { files, issues } from "@/db/schema";
import { eq } from "drizzle-orm";
import { ensureTables } from "@/lib/db-init";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    await ensureTables();
    const body = await req.json();
    const fileId = body.fileId as number;
    const newContent = body.newContent as string;

    if (!fileId || typeof newContent !== "string") {
      return NextResponse.json({ error: "fileId and newContent required" }, { status: 400 });
    }

    const rows = await db.select().from(files).where(eq(files.id, fileId)).limit(1);
    if (rows.length === 0) return NextResponse.json({ error: "File not found" }, { status: 404 });

    const file = rows[0];

    // Update DB immediately after successful client-side disk write
    // The client calls this AFTER commitFix() succeeded on disk
    // Per spec §5.6: successful commit must update DB record immediately, and re-analysis must read new content

    await db
      .update(files)
      .set({
        content: newContent,
        correctedContent: null, // Clear corrected since now content = corrected
        status: "pending", // Will be re-analyzed immediately after
        updatedAt: new Date(),
        lineCount: newContent.split("\n").length,
        fileSize: Buffer.byteLength(newContent, "utf8"),
        errorMessage: null,
      })
      .where(eq(files.id, fileId));

    // Clear old issues since we'll re-analyze
    await db.delete(issues).where(eq(issues.fileId, fileId));

    const updated = await db.select().from(files).where(eq(files.id, fileId)).limit(1);

    return NextResponse.json({
      success: true,
      message: `DB updated for ${file.path}, ready for re-analysis. Original file on disk already overwritten via FileSystemWritableFileStream.`,
      file: updated[0],
    });
  } catch (err: any) {
    console.error("commit error", err);
    return NextResponse.json({ error: "Commit failed", details: err?.message }, { status: 500 });
  }
}
