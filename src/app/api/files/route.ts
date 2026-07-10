import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { files, issues } from "@/db/schema";
import { eq, asc, desc, like, or } from "drizzle-orm";
import { ensureTables } from "@/lib/db-init";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  try {
    await ensureTables();

    const { searchParams } = new URL(req.url);
    const q = searchParams.get("q");
    const status = searchParams.get("status");
    const idParam = searchParams.get("id");

    if (idParam) {
      const id = parseInt(idParam, 10);
      if (isNaN(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
      const fileRows = await db.select().from(files).where(eq(files.id, id)).limit(1);
      if (fileRows.length === 0) return NextResponse.json({ error: "File not found" }, { status: 404 });
      const file = fileRows[0];
      const fileIssues = await db.select().from(issues).where(eq(issues.fileId, file.id)).orderBy(asc(issues.line));
      return NextResponse.json({ file: { ...file, issues: fileIssues } });
    }

    let query = db.select().from(files).orderBy(asc(files.path));

    // We need to handle filtering manually after fetch for simplicity, or build conditions
    let allFiles = await query;

    if (q) {
      const lower = q.toLowerCase();
      allFiles = allFiles.filter((f) => f.path.toLowerCase().includes(lower));
    }
    if (status && status !== "all") {
      allFiles = allFiles.filter((f) => f.status === status);
    }

    // Get issues count per file quickly
    const allIssues = await db.select().from(issues);
    const issueMap = new Map<number, number>();
    const criticalMap = new Map<number, number>();
    for (const iss of allIssues) {
      issueMap.set(iss.fileId, (issueMap.get(iss.fileId) || 0) + 1);
      if (iss.severity === "critical") {
        criticalMap.set(iss.fileId, (criticalMap.get(iss.fileId) || 0) + 1);
      }
    }

    const enriched = allFiles.map((f) => ({
      ...f,
      issuesCount: issueMap.get(f.id) || 0,
      criticalCount: criticalMap.get(f.id) || 0,
    }));

    return NextResponse.json({ files: enriched, total: enriched.length });
  } catch (err: any) {
    console.error("GET /api/files error", err);
    return NextResponse.json(
      { error: "Failed to fetch files", details: err?.message || String(err), files: [] },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureTables();
    const body = await req.json();

    // Expect { files: [{path, content, language, extension, fileSize}] }
    // Support chunked sync
    const incoming = body.files as Array<{
      path: string;
      content: string;
      language: string;
      extension: string;
      fileSize?: number;
    }>;

    if (!Array.isArray(incoming)) {
      return NextResponse.json({ error: "files must be an array" }, { status: 400 });
    }

    if (incoming.length > 100) {
      return NextResponse.json({ error: "Chunk size too large, max 100 per request" }, { status: 400 });
    }

    const results = [];

    for (const f of incoming) {
      if (!f.path) continue;
      const lineCount = f.content.split("\n").length;
      const size = f.fileSize ?? Buffer.byteLength(f.content || "", "utf8");

      // Upsert via onConflictDoUpdate
      try {
        // Check if exists
        const existing = await db.select().from(files).where(eq(files.path, f.path)).limit(1);
        if (existing.length > 0) {
          const updated = await db
            .update(files)
            .set({
              content: f.content,
              language: f.language || "plaintext",
              extension: f.extension || "",
              fileSize: size,
              lineCount,
              status: "pending", // reset to pending on new sync, unless already analyzing? but spec says pending
              updatedAt: new Date(),
              correctedContent: null,
              errorMessage: null,
            })
            .where(eq(files.path, f.path))
            .returning();
          results.push(updated[0]);
        } else {
          const inserted = await db
            .insert(files)
            .values({
              path: f.path,
              content: f.content,
              language: f.language || "plaintext",
              extension: f.extension || "",
              fileSize: size,
              lineCount,
              status: "pending",
            })
            .returning();
          results.push(inserted[0]);
        }
      } catch (e: any) {
        console.error(`Failed to upsert ${f.path}`, e);
        // Continue
      }
    }

    // Clean up issues for re-synced files (since status reset)
    for (const r of results) {
      try {
        await db.delete(issues).where(eq(issues.fileId, r.id));
      } catch {}
    }

    return NextResponse.json({ success: true, synced: results.length, files: results });
  } catch (err: any) {
    console.error("POST /api/files error", err);
    return NextResponse.json({ error: "Failed to sync files", details: err?.message }, { status: 500 });
  }
}

// DELETE via query param path? But we have [id] route for id deletion
export async function DELETE(req: NextRequest) {
  try {
    await ensureTables();
    const { searchParams } = new URL(req.url);
    const path = searchParams.get("path");
    const idParam = searchParams.get("id");

    if (idParam) {
      const id = parseInt(idParam, 10);
      await db.delete(files).where(eq(files.id, id));
      return NextResponse.json({ success: true });
    }

    if (path) {
      await db.delete(files).where(eq(files.path, path));
      return NextResponse.json({ success: true });
    }

    // Clear all? For safety require confirm
    const body = await req.json().catch(() => ({}));
    if (body.confirmClearAll) {
      await db.delete(files);
      return NextResponse.json({ success: true, cleared: true });
    }

    return NextResponse.json({ error: "Provide id or path" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: "Delete failed", details: err?.message }, { status: 500 });
  }
}
