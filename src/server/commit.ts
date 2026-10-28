import { and, eq, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { commits, files, issues, workspaces } from "@/db/schema";
import type { CommitInput, CommitResultDto } from "@/lib/contracts";
import { AppError, notFound } from "@/lib/errors";
import { writeWorkspaceFileAtomic } from "@/lib/fs-desktop";
import { buildCommitMessage, commitFile } from "@/lib/git";
import { scanSource, scoreFindings } from "@/lib/heuristic";
import { countLines, detectEol, sha256Hex, utf8ByteLength } from "@/lib/text";
import { findingRows, insertIssues } from "./persist";
import { getFileDetail } from "./queries";

/**
 * Closed-loop remediation. The stored patch (never client-supplied content) is written:
 * - server mode: by this process, atomically, after verifying the disk still holds `baseHash`;
 * - browser mode: by the client's directory handle, which must report the patch's exact hash;
 * - sample project: in the database only.
 * Then content/hash are updated, resolved issues are marked fixed, the new content is re-scanned,
 * and (optionally) the single file is committed to git.
 */
export async function commitPatch(db: AppDb, input: CommitInput): Promise<CommitResultDto> {
  const [row] = await db
    .select({ file: files, ws: workspaces })
    .from(files)
    .innerJoin(workspaces, eq(workspaces.id, files.workspaceId))
    .where(eq(files.id, input.fileId))
    .limit(1);
  if (!row) throw notFound(`File ${input.fileId}`);
  const { file, ws } = row;

  if (!file.correctedContent || file.correctedForHash !== file.contentHash) {
    throw new AppError(409, "PATCH_UNAVAILABLE", "No patch is available for the current content; re-run deep analysis");
  }
  if (input.baseHash !== file.contentHash) {
    throw new AppError(409, "STALE_CONTENT", "The patch you reviewed is for an older version of this file; reload and review again");
  }

  const newContent = file.correctedContent;
  const newHash = await sha256Hex(newContent);

  if (ws.kind === "server") {
    await writeWorkspaceFileAtomic(ws.rootPath, file.path, newContent, file.contentHash);
  } else if (ws.kind === "demo") {
    // Sample project: the stored content is the source of truth, so there is no disk write to verify.
  } else if (input.writtenHash !== newHash) {
    throw new AppError(409, "INTEGRITY_FAILED", "The client-reported hash does not match the stored patch; the file on disk was not verified");
  }

  const findings = scanSource(newContent, file.language).findings;
  const commitId = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(files)
      .set({
        content: newContent,
        contentHash: newHash,
        eol: detectEol(newContent),
        lineCount: countLines(newContent),
        fileSize: utf8ByteLength(newContent),
        status: findings.length ? "issues" : "clean",
        engine: "heuristic",
        analyzedHash: newHash,
        correctedContent: null,
        correctedForHash: null,
        qualityScore: scoreFindings(findings),
        summary: `Patch applied; deterministic re-scan: ${findings.length} finding(s).`,
        errorMessage: null,
        leaseExpiresAt: null,
        lastAnalyzedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(files.id, file.id), eq(files.contentHash, file.contentHash)))
      .returning({ id: files.id });
    if (!updated) throw new AppError(409, "STALE_CONTENT", "File changed while committing; re-sync the workspace");

    const fixed = await tx
      .update(issues)
      .set({ status: "fixed", fixedAt: sql`now()` })
      .where(and(eq(issues.fileId, file.id), eq(issues.status, "open")))
      .returning({ ruleId: issues.ruleId });
    await insertIssues(tx, findingRows(ws.id, file.id, newHash, findings));
    const [c] = await tx
      .insert(commits)
      .values({ workspaceId: ws.id, fileId: file.id, path: file.path, previousHash: file.contentHash, newHash, issuesFixed: fixed.length })
      .returning({ id: commits.id });
    return { id: c.id, ruleIds: fixed.map((f) => f.ruleId), issuesFixed: fixed.length };
  });

  let gitSha: string | null = null;
  let gitError: string | null = null;
  if (input.git) {
    if (ws.kind !== "server") gitError = "Git commits require a server-mode workspace";
    else if (!ws.isGitRepo) gitError = "Workspace is not a git repository";
    else {
      try {
        gitSha = await commitFile(
          ws.rootPath,
          file.path,
          buildCommitMessage({ path: file.path, ruleIds: commitId.ruleIds, issuesFixed: commitId.issuesFixed, engine: file.engine ?? "hybrid", model: file.modelUsed, previousHash: file.contentHash, newHash })
        );
      } catch (err) {
        gitError = err instanceof Error ? err.message : String(err);
      }
    }
    await db.update(commits).set({ gitSha, gitError }).where(eq(commits.id, commitId.id));
  }

  return {
    file: await getFileDetail(db, file.id),
    previousHash: file.contentHash,
    newHash,
    issuesFixed: commitId.issuesFixed,
    gitSha,
    gitError,
  };
}
