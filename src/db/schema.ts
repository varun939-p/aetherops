import {
  pgTable,
  serial,
  text,
  varchar,
  integer,
  boolean,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
  jsonb,
  char,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const workspaceKindEnum = pgEnum("workspace_kind", ["server", "browser", "demo"]);

export const fileStatusEnum = pgEnum("file_status", ["pending", "analyzing", "issues", "clean", "error"]);

export const analysisEngineEnum = pgEnum("analysis_engine", ["heuristic", "hybrid"]);

export const issueSeverityEnum = pgEnum("issue_severity", ["critical", "high", "medium", "low", "info"]);

export const issueCategoryEnum = pgEnum("issue_category", [
  "security",
  "reliability",
  "performance",
  "concurrency",
  "maintainability",
]);

export const issueSourceEnum = pgEnum("issue_source", ["heuristic", "ai"]);

export const issueStatusEnum = pgEnum("issue_status", ["open", "fixed"]);

export const scanKindEnum = pgEnum("scan_kind", ["sync", "file", "batch"]);

export const scanStatusEnum = pgEnum("scan_status", ["running", "completed", "partial", "failed"]);

const tz = { withTimezone: true } as const;

export const workspaces = pgTable(
  "workspaces",
  {
    id: serial("id").primaryKey(),
    kind: workspaceKindEnum("kind").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    // server: normalized absolute path; browser: the picked folder's name (display only)
    rootPath: text("root_path").notNull(),
    rootKey: varchar("root_key", { length: 1024 }).notNull(),
    isGitRepo: boolean("is_git_repo").notNull().default(false),
    gitBranch: varchar("git_branch", { length: 255 }),
    lastSyncedAt: timestamp("last_synced_at", tz),
    createdAt: timestamp("created_at", tz).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", tz).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("workspaces_kind_root_key_uq").on(t.kind, t.rootKey)]
);

export const files = pgTable(
  "files",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    path: varchar("path", { length: 1024 }).notNull(),
    content: text("content").notNull(),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    language: varchar("language", { length: 50 }).notNull().default("plaintext"),
    extension: varchar("extension", { length: 32 }).notNull().default(""),
    eol: varchar("eol", { length: 4 }).$type<"lf" | "crlf">().notNull().default("lf"),
    fileSize: integer("file_size").notNull().default(0),
    lineCount: integer("line_count").notNull().default(0),
    status: fileStatusEnum("status").notNull().default("pending"),
    engine: analysisEngineEnum("engine"),
    analyzedHash: char("analyzed_hash", { length: 64 }),
    correctedContent: text("corrected_content"),
    // The content hash the patch was generated against; a patch is only committable while it matches content_hash.
    correctedForHash: char("corrected_for_hash", { length: 64 }),
    qualityScore: integer("quality_score"),
    summary: text("summary"),
    errorMessage: text("error_message"),
    modelUsed: varchar("model_used", { length: 100 }),
    leaseExpiresAt: timestamp("lease_expires_at", tz),
    lastAnalyzedAt: timestamp("last_analyzed_at", tz),
    createdAt: timestamp("created_at", tz).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", tz).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("files_workspace_path_uq").on(t.workspaceId, t.path),
    index("files_workspace_status_idx").on(t.workspaceId, t.status),
  ]
);

export const issues = pgTable(
  "issues",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    fileId: integer("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    ruleId: varchar("rule_id", { length: 64 }).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    message: text("message").notNull(),
    remediation: text("remediation"),
    severity: issueSeverityEnum("severity").notNull(),
    category: issueCategoryEnum("category").notNull(),
    source: issueSourceEnum("source").notNull(),
    status: issueStatusEnum("status").notNull().default("open"),
    line: integer("line").notNull(),
    column: integer("column").notNull().default(1),
    endLine: integer("end_line").notNull(),
    endColumn: integer("end_column").notNull().default(1),
    contentHash: char("content_hash", { length: 64 }).notNull(),
    fixedAt: timestamp("fixed_at", tz),
    createdAt: timestamp("created_at", tz).defaultNow().notNull(),
  },
  (t) => [
    index("issues_file_status_idx").on(t.fileId, t.status),
    index("issues_workspace_status_severity_idx").on(t.workspaceId, t.status, t.severity),
  ]
);

export const scans = pgTable(
  "scans",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    fileId: integer("file_id").references(() => files.id, { onDelete: "cascade" }),
    kind: scanKindEnum("kind").notNull(),
    status: scanStatusEnum("status").notNull().default("running"),
    engine: analysisEngineEnum("engine").notNull(),
    modelUsed: varchar("model_used", { length: 100 }),
    filesTotal: integer("files_total").notNull().default(0),
    filesScanned: integer("files_scanned").notNull().default(0),
    filesSkipped: integer("files_skipped").notNull().default(0),
    issuesFound: integer("issues_found").notNull().default(0),
    durationMs: integer("duration_ms"),
    error: text("error"),
    meta: jsonb("meta"),
    startedAt: timestamp("started_at", tz).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", tz),
  },
  (t) => [
    index("scans_workspace_started_idx").on(t.workspaceId, t.startedAt),
    index("scans_file_idx").on(t.fileId),
  ]
);

export const commits = pgTable(
  "commits",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    fileId: integer("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    path: varchar("path", { length: 1024 }).notNull(),
    previousHash: char("previous_hash", { length: 64 }).notNull(),
    newHash: char("new_hash", { length: 64 }).notNull(),
    issuesFixed: integer("issues_fixed").notNull().default(0),
    gitSha: varchar("git_sha", { length: 64 }),
    gitError: text("git_error"),
    createdAt: timestamp("created_at", tz).defaultNow().notNull(),
  },
  (t) => [index("commits_file_idx").on(t.fileId)]
);

export const workspacesRelations = relations(workspaces, ({ many }) => ({
  files: many(files),
  scans: many(scans),
}));

export const filesRelations = relations(files, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [files.workspaceId], references: [workspaces.id] }),
  issues: many(issues),
  scans: many(scans),
  commits: many(commits),
}));

export const issuesRelations = relations(issues, ({ one }) => ({
  file: one(files, { fields: [issues.fileId], references: [files.id] }),
}));

export const scansRelations = relations(scans, ({ one }) => ({
  workspace: one(workspaces, { fields: [scans.workspaceId], references: [workspaces.id] }),
  file: one(files, { fields: [scans.fileId], references: [files.id] }),
}));

export const commitsRelations = relations(commits, ({ one }) => ({
  file: one(files, { fields: [commits.fileId], references: [files.id] }),
}));

export type WorkspaceRecord = typeof workspaces.$inferSelect;
export type FileRecord = typeof files.$inferSelect;
export type NewFileRecord = typeof files.$inferInsert;
export type IssueRecord = typeof issues.$inferSelect;
export type NewIssueRecord = typeof issues.$inferInsert;
export type ScanRecord = typeof scans.$inferSelect;
export type CommitRecord = typeof commits.$inferSelect;

export type FileStatus = (typeof fileStatusEnum.enumValues)[number];
export type AnalysisEngine = (typeof analysisEngineEnum.enumValues)[number];
export type IssueSeverity = (typeof issueSeverityEnum.enumValues)[number];
export type IssueCategory = (typeof issueCategoryEnum.enumValues)[number];
export type IssueSource = (typeof issueSourceEnum.enumValues)[number];
