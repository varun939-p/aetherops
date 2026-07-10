import { pgTable, serial, text, varchar, integer, timestamp, pgEnum, index, jsonb } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const fileStatusEnum = pgEnum("file_status", [
  "pending",
  "analyzing",
  "issues",
  "clean",
  "error",
  "committing",
]);

export const severityEnum = pgEnum("severity", [
  "critical",
  "high",
  "medium",
  "low",
  "info",
]);

export const sourceEnum = pgEnum("source", ["heuristic", "ai"]);

export const files = pgTable(
  "files",
  {
    id: serial("id").primaryKey(),
    path: varchar("path", { length: 1024 }).notNull().unique(),
    content: text("content").notNull().default(""),
    correctedContent: text("corrected_content"),
    language: varchar("language", { length: 50 }).notNull().default("plaintext"),
    extension: varchar("extension", { length: 20 }).notNull().default(""),
    status: fileStatusEnum("status").notNull().default("pending"),
    fileSize: integer("file_size").notNull().default(0),
    errorMessage: text("error_message"),
    qualityScore: integer("quality_score").default(0),
    lineCount: integer("line_count").default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    lastAnalyzedAt: timestamp("last_analyzed_at"),
    modelUsed: varchar("model_used", { length: 100 }),
  },
  (table) => ({
    pathIdx: index("path_idx").on(table.path),
    statusIdx: index("status_idx").on(table.status),
  })
);

export const issues = pgTable(
  "issues",
  {
    id: serial("id").primaryKey(),
    fileId: integer("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    severity: severityEnum("severity").notNull().default("medium"),
    line: integer("line").notNull().default(1),
    column: integer("column").default(0),
    message: text("message").notNull(),
    source: sourceEnum("source").notNull().default("heuristic"),
    ruleId: varchar("rule_id", { length: 100 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    fileIdIdx: index("file_id_idx").on(table.fileId),
    severityIdx: index("severity_idx").on(table.severity),
  })
);

export const analysisHistory = pgTable(
  "analysis_history",
  {
    id: serial("id").primaryKey(),
    fileId: integer("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    issuesCount: integer("issues_count").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    modelUsed: varchar("model_used", { length: 100 }),
    status: fileStatusEnum("status").notNull().default("pending"),
    summary: text("summary"),
    rawResponse: jsonb("raw_response"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    fileIdIdx: index("analysis_file_id_idx").on(table.fileId),
  })
);

export const filesRelations = relations(files, ({ many }) => ({
  issues: many(issues),
  history: many(analysisHistory),
}));

export const issuesRelations = relations(issues, ({ one }) => ({
  file: one(files, {
    fields: [issues.fileId],
    references: [files.id],
  }),
}));

export const analysisHistoryRelations = relations(analysisHistory, ({ one }) => ({
  file: one(files, {
    fields: [analysisHistory.fileId],
    references: [files.id],
  }),
}));

export type FileRecord = typeof files.$inferSelect;
export type NewFileRecord = typeof files.$inferInsert;
export type IssueRecord = typeof issues.$inferSelect;
export type NewIssueRecord = typeof issues.$inferInsert;
export type AnalysisHistoryRecord = typeof analysisHistory.$inferSelect;

export type FileWithIssues = FileRecord & {
  issues: IssueRecord[];
};
