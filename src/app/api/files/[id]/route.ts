import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { files, issues, analysisHistory } from "@/db/schema";
import { eq, asc } from "drizzle-orm";
import { ensureTables } from "@/lib/db-init";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureTables();
    const { id: idParam } = await params;
    const id = parseInt(idParam, 10);
    if (isNaN(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

    const fileRows = await db.select().from(files).where(eq(files.id, id)).limit(1);
    if (fileRows.length === 0) return NextResponse.json({ error: "File not found" }, { status: 404 });

    const file = fileRows[0];
    const fileIssues = await db.select().from(issues).where(eq(issues.fileId, id)).orderBy(asc(issues.line));
    const history = await db
      .select()
      .from(analysisHistory)
      .where(eq(analysisHistory.fileId, id))
      .orderBy(asc(analysisHistory.createdAt))
      .limit(10);

    return NextResponse.json({
      file: { ...file, issues: fileIssues, history },
    });
  } catch (err: any) {
    return NextResponse.json({ error: "Fetch failed", details: err?.message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await ensureTables();
    const { id: idParam } = await params;
    const id = parseInt(idParam, 10);
    if (isNaN(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

    await db.delete(files).where(eq(files.id, id));
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: "Delete failed", details: err?.message }, { status: 500 });
  }
}
