import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { getDatabaseUrl, getDbDriver, pingDb, type AppDb } from "@/db";
import { workspaces, type WorkspaceRecord } from "@/db/schema";
import { getAiConfig } from "@/lib/ai";
import type { CreateWorkspaceInput, SystemDto } from "@/lib/contracts";
import { assertSchemaReady } from "@/lib/db-init";
import { toAppError } from "@/lib/api";
import { resolveWorkspaceRoot, serverFsStatus } from "@/lib/fs-desktop";
import { gitInfo } from "@/lib/git";

export async function createWorkspace(db: AppDb, input: CreateWorkspaceInput): Promise<WorkspaceRecord> {
  if (input.kind === "server") {
    const root = await resolveWorkspaceRoot(input.rootPath);
    const git = await gitInfo(root);
    const rootKey = process.platform === "win32" ? root.toLowerCase() : root;
    const [ws] = await db
      .insert(workspaces)
      .values({ kind: "server", name: path.basename(root) || root, rootPath: root, rootKey, isGitRepo: git.isRepo, gitBranch: git.branch })
      .onConflictDoUpdate({
        target: [workspaces.kind, workspaces.rootKey],
        set: { isGitRepo: git.isRepo, gitBranch: git.branch, updatedAt: sql`now()` },
      })
      .returning();
    return ws;
  }
  const [ws] = await db
    .insert(workspaces)
    .values({ kind: "browser", name: input.name, rootPath: input.name, rootKey: input.name.toLowerCase() })
    .onConflictDoUpdate({ target: [workspaces.kind, workspaces.rootKey], set: { updatedAt: sql`now()` } })
    .returning();
  return ws;
}

/** Refreshes git metadata for server workspaces on each sync (branch switches, `git init`). */
export async function refreshGit(db: AppDb, ws: WorkspaceRecord): Promise<WorkspaceRecord> {
  if (ws.kind !== "server") return ws;
  const git = await gitInfo(ws.rootPath);
  if (git.isRepo === ws.isGitRepo && git.branch === ws.gitBranch) return ws;
  const [updated] = await db.update(workspaces).set({ isGitRepo: git.isRepo, gitBranch: git.branch }).where(eq(workspaces.id, ws.id)).returning();
  return updated;
}

export async function systemStatus(): Promise<SystemDto> {
  const fs = serverFsStatus();
  const ai = getAiConfig();
  const db: SystemDto["db"] = { configured: false, connected: false, migrated: false, driver: null, latencyMs: null, error: null };
  try {
    getDatabaseUrl();
    db.configured = true;
    const ping = await pingDb();
    db.connected = true;
    db.latencyMs = ping.latencyMs;
    db.driver = await getDbDriver();
    await assertSchemaReady();
    db.migrated = true;
  } catch (err) {
    db.error = toAppError(err).message;
  }
  return {
    db,
    ai: { configured: ai !== null, model: ai?.model ?? null },
    fs: { serverMode: fs.enabled, reason: fs.reason, allowedRoots: fs.allowedRoots },
  };
}
