"use client";

import { useMemo, useState } from "react";
import type { Category, IssueDto, ScanDto, Severity } from "@/lib/contracts";
import { cn, formatMs, relativeTime } from "@/lib/utils";
import { CATEGORY_LABEL, EmptyState, Icon, SEVERITY_ORDER, SEVERITY_TEXT, Segmented, SeverityTag, SkeletonRows } from "./ui";

export type IssueScope = "file" | "workspace";

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function IssueRow({ issue, active, showPath, onJump }: { issue: IssueDto; active: boolean; showPath: boolean; onJump: (issue: IssueDto) => void }) {
  return (
    <li className={cn("border-b border-line", active && "bg-raised")}>
      <button type="button" onClick={() => onJump(issue)} className="flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-hover" aria-expanded={active}>
        <div className="flex w-full items-center gap-2">
          <SeverityTag severity={issue.severity} />
          <span className="font-mono text-[10.5px] text-fg-muted">{issue.ruleId}</span>
          <span className="font-mono text-[10px] text-fg-faint">{CATEGORY_LABEL[issue.category]}</span>
          <span className={cn("ml-auto font-mono text-[10px]", issue.source === "ai" ? "text-accent" : "text-fg-subtle")}>{issue.source === "ai" ? "AI" : "HEUR"}</span>
          <span className="tnum font-mono text-[10.5px] text-fg-muted">
            L{issue.line}:{issue.column}
          </span>
        </div>
        {showPath && issue.path && <div className="truncate font-mono text-[10.5px] text-fg-subtle">{issue.path}</div>}
        <div className={cn("text-[12px] leading-[1.45]", issue.status === "fixed" ? "text-fg-subtle line-through decoration-fg-faint" : "text-fg")}>
          <span className="font-medium">{issue.title}.</span> <span className="text-fg-muted">{issue.message}</span>
        </div>
      </button>
      {active && issue.remediation && (
        <div className="px-3 pb-2.5">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">Remediation</div>
          <pre className="code max-h-48 overflow-auto rounded-[3px] border border-line bg-canvas p-2 text-[11.5px] leading-[18px] whitespace-pre-wrap text-fg-muted">{issue.remediation}</pre>
        </div>
      )}
    </li>
  );
}

function ScanLog({ scans }: { scans: ScanDto[] }) {
  if (!scans.length) return <EmptyState title="No scans recorded" />;
  return (
    <table className="w-full table-fixed border-collapse text-left">
      <thead className="sticky top-0 bg-surface">
        <tr className="border-b border-line text-[10px] uppercase tracking-[0.08em] text-fg-subtle">
          <th className="w-[54px] px-3 py-1.5 font-semibold">Kind</th>
          <th className="px-2 py-1.5 font-semibold">Target</th>
          <th className="w-[58px] px-2 py-1.5 text-right font-semibold">Found</th>
          <th className="w-[64px] px-2 py-1.5 text-right font-semibold">Time</th>
          <th className="w-[62px] px-3 py-1.5 text-right font-semibold">When</th>
        </tr>
      </thead>
      <tbody className="font-mono text-[11px]">
        {scans.map((s) => (
          <tr key={s.id} className="border-b border-line" title={s.error ?? undefined}>
            <td className={cn("px-3 py-1.5 uppercase", s.status === "failed" ? "text-sev-critical" : s.status === "partial" ? "text-sev-medium" : "text-fg-muted")}>{s.kind}</td>
            <td className="truncate px-2 py-1.5 text-fg-muted">{s.path ?? `${s.filesScanned}/${s.filesTotal} files`}</td>
            <td className="tnum px-2 py-1.5 text-right text-fg-muted">{s.issuesFound}</td>
            <td className="tnum px-2 py-1.5 text-right text-fg-muted">{formatMs(s.durationMs)}</td>
            <td className="px-3 py-1.5 text-right text-fg-subtle">{relativeTime(s.startedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function IssueTracker({
  scope,
  onScopeChange,
  fileIssues,
  workspaceIssues,
  loading,
  activeIssueId,
  onJump,
  scans,
  hasFile,
}: {
  scope: IssueScope;
  onScopeChange: (s: IssueScope) => void;
  fileIssues: IssueDto[];
  workspaceIssues: IssueDto[] | undefined;
  loading: boolean;
  activeIssueId: number | null;
  onJump: (issue: IssueDto) => void;
  scans: ScanDto[];
  hasFile: boolean;
}) {
  const [tab, setTab] = useState<"issues" | "scans">("issues");
  const [severities, setSeverities] = useState<Set<Severity>>(new Set());
  const [category, setCategory] = useState<Category | "all">("all");
  const [source, setSource] = useState<"all" | "heuristic" | "ai">("all");
  const [status, setStatus] = useState<"open" | "fixed">("open");

  const base = useMemo(() => (scope === "file" ? fileIssues : (workspaceIssues ?? [])), [scope, fileIssues, workspaceIssues]);
  const scoped = useMemo(() => base.filter((i) => i.status === status), [base, status]);

  const counts = useMemo(() => {
    const c: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const i of scoped) if ((category === "all" || i.category === category) && (source === "all" || i.source === source)) c[i.severity]++;
    return c;
  }, [scoped, category, source]);

  const visible = useMemo(
    () =>
      scoped
        .filter((i) => (severities.size === 0 || severities.has(i.severity)) && (category === "all" || i.category === category) && (source === "all" || i.source === source))
        .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.path ?? "").localeCompare(b.path ?? "") || a.line - b.line),
    [scoped, severities, category, source]
  );

  const toggleSeverity = (s: Severity) =>
    setSeverities((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-surface" aria-label="Issue tracker">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-line px-2">
        {(["issues", "scans"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn("h-8 px-2 text-[11px] font-semibold uppercase tracking-[0.08em]", tab === t ? "text-fg shadow-[inset_0_-1px_0_var(--color-accent)]" : "text-fg-subtle hover:text-fg-muted")}
          >
            {t === "issues" ? "Issues" : "Scan log"}
          </button>
        ))}
        {tab === "issues" && (
          <div className="ml-auto">
            <Segmented
              size="xs"
              value={scope}
              onChange={onScopeChange}
              options={[
                { value: "file", label: "File" },
                { value: "workspace", label: "Workspace" },
              ]}
            />
          </div>
        )}
      </div>

      {tab === "scans" ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <ScanLog scans={scans} />
        </div>
      ) : (
        <>
          <div className="flex shrink-0 flex-col gap-2 border-b border-line p-2">
            <div className="flex flex-wrap gap-1">
              {SEVERITY_ORDER.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={severities.has(s)}
                  onClick={() => toggleSeverity(s)}
                  className={cn(
                    "flex h-6 items-center gap-1.5 rounded-[3px] border px-1.5 font-mono text-[10.5px]",
                    severities.has(s) ? "border-line-strong bg-hover" : "border-line hover:border-line-strong",
                    severities.size && !severities.has(s) ? "opacity-50" : ""
                  )}
                >
                  <span className={cn("font-semibold uppercase", SEVERITY_TEXT[s])}>{s === "critical" ? "crit" : s === "medium" ? "med" : s}</span>
                  <span className="tnum text-fg-muted">{counts[s]}</span>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as Category | "all")}
                className="h-6 min-w-0 flex-1 rounded-[3px] border border-line-strong bg-canvas px-1.5 font-mono text-[10.5px] text-fg-muted outline-none focus:border-accent"
                aria-label="Category"
              >
                <option value="all">ALL CATEGORIES</option>
                {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </select>
              <Segmented
                size="xs"
                value={source}
                onChange={setSource}
                options={[
                  { value: "all", label: "All" },
                  { value: "heuristic", label: "Heur" },
                  { value: "ai", label: "AI" },
                ]}
              />
              <Segmented
                size="xs"
                value={status}
                onChange={setStatus}
                options={[
                  { value: "open", label: "Open" },
                  { value: "fixed", label: "Fixed" },
                ]}
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            {loading && base.length === 0 ? (
              <SkeletonRows rows={10} />
            ) : scope === "file" && !hasFile ? (
              <EmptyState title="No file selected">Switch to Workspace scope to triage every open issue.</EmptyState>
            ) : visible.length === 0 ? (
              <EmptyState title={scoped.length ? "No issues match the filters" : status === "open" ? "No open issues" : "No fixed issues"} />
            ) : (
              <ul>
                {visible.map((issue) => (
                  <IssueRow key={issue.id} issue={issue} active={issue.id === activeIssueId} showPath={scope === "workspace"} onJump={onJump} />
                ))}
              </ul>
            )}
          </div>
          <div className="flex h-6 shrink-0 items-center gap-1.5 border-t border-line px-3 font-mono text-[10.5px] text-fg-subtle">
            <Icon name="alert" size={11} />
            <span className="tnum">
              {visible.length} shown · {scoped.length} {status}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
