import { z } from "zod";

/** Request schemas and response DTOs shared by route handlers and the client. */

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase hex SHA-256 digest");
const relPath = z.string().min(1).max(1024);
const id = z.coerce.number().int().positive();

export const createWorkspaceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("server"), rootPath: z.string().min(1).max(4096) }),
  z.object({ kind: z.literal("browser"), name: z.string().min(1).max(255) }),
]);

export const manifestSchema = z.object({
  entries: z.array(z.object({ path: relPath, hash: sha256 })).max(20_000),
});

export const uploadFilesSchema = z.object({
  workspaceId: id,
  files: z
    .array(z.object({ path: relPath, content: z.string(), hash: sha256 }))
    .min(1)
    .max(500),
});

export const analyzeSchema = z.union([
  z.object({ fileId: id, engine: z.enum(["hybrid", "heuristic"]).default("hybrid") }).strict(),
  z
    .object({
      workspaceId: id,
      scope: z.enum(["changed", "all"]).default("changed"),
      engine: z.enum(["hybrid", "heuristic"]).default("heuristic"),
    })
    .strict(),
]);

export const commitSchema = z.object({
  fileId: id,
  /** Content hash the patch was reviewed against; the commit is refused if anything moved since. */
  baseHash: sha256,
  /** Browser mode: hash the client verified after writing through its directory handle. */
  writtenHash: sha256.optional(),
  git: z.boolean().default(false),
});

export const issuesQuerySchema = z.object({
  workspaceId: id,
  fileId: id.optional(),
  status: z.enum(["open", "fixed", "all"]).default("open"),
  severity: z.string().optional(),
  category: z.string().optional(),
  source: z.enum(["heuristic", "ai"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
export type AnalyzeInput = z.infer<typeof analyzeSchema>;
export type CommitInput = z.infer<typeof commitSchema>;

// ---------------------------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------------------------

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Category = "security" | "reliability" | "performance" | "concurrency" | "maintainability";
export type FileStatusDto = "pending" | "analyzing" | "issues" | "clean" | "error";
export type EngineDto = "heuristic" | "hybrid";

export interface WorkspaceDto {
  id: number;
  kind: "server" | "browser" | "demo";
  name: string;
  rootPath: string;
  isGitRepo: boolean;
  gitBranch: string | null;
  lastSyncedAt: string | null;
  fileCount: number;
}

export interface FileSummaryDto {
  id: number;
  path: string;
  language: string;
  status: FileStatusDto;
  engine: EngineDto | null;
  contentHash: string;
  /** True when the stored analysis was computed for older content. */
  stale: boolean;
  lineCount: number;
  fileSize: number;
  qualityScore: number | null;
  openIssues: number;
  criticalIssues: number;
  highIssues: number;
  hasPatch: boolean;
  updatedAt: string;
}

export interface IssueDto {
  id: number;
  fileId: number;
  path?: string;
  ruleId: string;
  title: string;
  message: string;
  remediation: string | null;
  severity: Severity;
  category: Category;
  source: "heuristic" | "ai";
  status: "open" | "fixed";
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  fixedAt: string | null;
}

export interface ScanDto {
  id: number;
  fileId: number | null;
  path: string | null;
  kind: "sync" | "file" | "batch";
  status: "running" | "completed" | "partial" | "failed";
  engine: EngineDto;
  modelUsed: string | null;
  filesTotal: number;
  filesScanned: number;
  filesSkipped: number;
  issuesFound: number;
  durationMs: number | null;
  error: string | null;
  startedAt: string;
}

export interface FileDetailDto extends FileSummaryDto {
  workspaceId: number;
  content: string;
  eol: "lf" | "crlf";
  correctedContent: string | null;
  /** A patch is committable only while it was generated against the current content. */
  patchCommittable: boolean;
  summary: string | null;
  errorMessage: string | null;
  modelUsed: string | null;
  lastAnalyzedAt: string | null;
  issues: IssueDto[];
  scans: ScanDto[];
}

export interface SyncResultDto {
  workspace: WorkspaceDto;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  findings: number;
  skipped: number;
  truncated: boolean;
  durationMs: number;
}

export interface ManifestResultDto {
  needed: string[];
  removed: number;
  unchanged: number;
}

export interface AnalysisResultDto {
  file: FileDetailDto;
  engine: EngineDto;
  scanDurationMs: number;
  heuristicMs: number;
  aiMs: number;
  aiError: string | null;
  coverage: { totalLines: number; analyzedLines: number; chunks: number; chunksAnalyzed: number; complete: boolean };
}

export type BatchEvent =
  | { type: "start"; scanId: number; total: number; skipped: number; engine: EngineDto }
  | { type: "file"; index: number; total: number; fileId: number; path: string; status: FileStatusDto; findings: number; durationMs: number; error: string | null }
  | { type: "done"; scan: ScanDto }
  | { type: "error"; error: { code: string; message: string } };

export interface CommitResultDto {
  file: FileDetailDto;
  previousHash: string;
  newHash: string;
  issuesFixed: number;
  gitSha: string | null;
  gitError: string | null;
}

export interface StatsDto {
  workspaceId: number;
  files: { total: number; analyzed: number; stale: number; byStatus: Record<FileStatusDto, number> };
  loc: { total: number; analyzed: number };
  coveragePct: number | null;
  healthIndex: number | null;
  openIssues: { total: number; bySeverity: Record<Severity, number>; byCategory: Record<Category, number>; bySource: Record<"heuristic" | "ai", number> };
  fixedIssues: number;
  scanLatency: { meanMs: number | null; p95Ms: number | null; samples: number };
  recentScans: ScanDto[];
}

export interface SystemDto {
  db: { configured: boolean; connected: boolean; migrated: boolean; driver: "pg" | "pglite" | null; latencyMs: number | null; error: string | null };
  ai: { configured: boolean; model: string | null };
  fs: { serverMode: boolean; reason: string | null; allowedRoots: string[] };
}
