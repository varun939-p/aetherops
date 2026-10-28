"use client";

import { useMemo, useState } from "react";
import type { Category, IssueDto, ScanDto, Severity } from "@/lib/contracts";
import { basename, cn, formatMs, relativeTime } from "@/lib/utils";
import { CATEGORY_LABEL, EmptyState, Hint, Icon, SEVERITY_BG, SEVERITY_LABEL, SEVERITY_ORDER, SEVERITY_TEXT, Segmented, SeverityTag, SkeletonRows } from "./ui";

export type IssueScope = "file" | "workspace";

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function IssueRow({ issue, active, showPath, onJump }: { issue: IssueDto; active: boolean; showPath: boolean; onJump: (issue: IssueDto) => void }) {
  const fixed = issue.status === "fixed";
  return (
    <li className={cn("relative border-b border-line", active ? "bg-accent-soft" : "hover:bg-hover")}>
      <span className={cn("absolute inset-y-0 left-0 w-[3px]", fixed ? "bg-fg-faint" : SEVERITY_BG[issue.severity])} aria-hidden />
      <button type="button" onClick={() => onJump(issue)} className="flex w-full flex-col gap-1.5 py-3 pl-4 pr-3 text-left" aria-expanded={active}>
        <div className="flex w-full items-start gap-2">
          <span className={cn("min-w-0 flex-1 text-[13.5px] font-semibold leading-snug", fixed ? "text-fg-subtle line-through decoration-fg-faint" : "text-fg")}>{issue.title}</span>
          {fixed ? (
            <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded bg-ok-soft px-1.5 text-[11.5px] font-semibold text-ok">
              <Icon name="check" size={12} /> Fixed
            </span>
          ) : (
            <SeverityTag severity={issue.severity} />
          )}
        </div>
        <p className="text-[12.5px] leading-relaxed text-fg-muted">{issue.message}</p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px] text-fg-subtle">
          {showPath && issue.path && <span className="font-mono text-fg-muted">{basename(issue.path)}</span>}
          <span className="tnum font-mono">Line {issue.line}</span>
          <span>·</span>
          <span>{CATEGORY_LABEL[issue.category]}</span>
          <span>·</span>
          <span className={issue.source === "ai" ? "font-medium text-accent" : undefined}>{issue.source === "ai" ? "Found by AI" : "Found by rules"}</span>
          <span className="ml-auto font-mono text-fg-faint" title="Rule ID">
            {issue.ruleId}
          </span>
        </div>
      </button>
      {active && issue.remediation && (
        <div className="pb-3 pl-4 pr-3">
          <div className="rounded-md border border-line bg-canvas">
            <div className="border-b border-line px-3 py-1.5 text-[12px] font-semibold text-fg">How to fix</div>
            <pre className="code max-h-56 overflow-auto px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap text-fg-muted">{issue.remediation}</pre>
          </div>
        </div>
      )}
    </li>
  );
}

const SCAN_KIND: Record<ScanDto["kind"], string> = { sync: "Sync", file: "File", batch: "Batch" };

function ScanLog({ scans }: { scans: ScanDto[] }) {
  if (!scans.length) return <EmptyState title="No scans yet">Each sync, file analysis, and batch scan is recorded here with its duration and result.</EmptyState>;
  return (
    <table className="w-full table-fixed border-collapse text-left">
      <thead className="sticky top-0 bg-surface">
        <tr className="border-b border-line text-[12px] text-fg-subtle">
          <th className="w-[68px] px-3 py-2 font-medium">Type</th>
          <th className="px-2 py-2 font-medium">Target</th>
          <th className="w-[54px] px-2 py-2 text-right font-medium">Issues</th>
          <th className="w-[64px] px-2 py-2 text-right font-medium">Took</th>
          <th className="w-[70px] px-3 py-2 text-right font-medium">When</th>
        </tr>
      </thead>
      <tbody className="text-[12.5px]">
        {scans.map((s) => (
          <tr key={s.id} className="border-b border-line" title={s.error ?? undefined}>
            <td className="px-3 py-2">
              <span className="flex items-center gap-1.5">
                <span className={cn("size-1.5 rounded-full", s.status === "failed" ? "bg-sev-critical" : s.status === "partial" ? "bg-sev-medium" : "bg-ok")} />
                {SCAN_KIND[s.kind]}
              </span>
            </td>
            <td className="truncate px-2 py-2 font-mono text-[12px] text-fg-muted">{s.path ? basename(s.path) : `${s.filesScanned} of ${s.filesTotal} files`}</td>
            <td className="tnum px-2 py-2 text-right text-fg-muted">{s.issuesFound}</td>
            <td className="tnum px-2 py-2 text-right text-fg-muted">{formatMs(s.durationMs)}</td>
            <td className="px-3 py-2 text-right text-fg-subtle">{relativeTime(s.startedAt)}</td>
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

  const filtersActive = severities.size > 0 || category !== "all" || source !== "all";

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-surface" aria-label="Issues">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
        {(["issues", "scans"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={cn("h-10 px-2.5 text-[13px] font-semibold", tab === t ? "text-fg shadow-[inset_0_-2px_0_var(--color-accent)]" : "text-fg-subtle hover:text-fg-muted")}
          >
            {t === "issues" ? "Issues" : "Scan history"}
          </button>
        ))}
        {tab === "issues" && (
          <div className="ml-auto">
            <Segmented
              size="xs"
              label="Scope"
              value={scope}
              onChange={onScopeChange}
              options={[
                { value: "file", label: "This file" },
                { value: "workspace", label: "All files" },
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
          <div className="flex shrink-0 flex-col gap-2.5 border-b border-line p-3">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-fg-subtle">
              Severity
              <Hint align="right">Critical: security breach, data loss or crash. High: likely production failure. Medium: degrades reliability or performance. Low: worth cleaning up. Click to filter; click again to clear.</Hint>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SEVERITY_ORDER.filter((s) => s !== "info" || counts.info > 0).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={severities.has(s)}
                  onClick={() => toggleSeverity(s)}
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12.5px] transition-colors",
                    severities.has(s) ? "border-fg-muted bg-raised font-semibold" : "border-line bg-raised hover:border-line-strong",
                    severities.size && !severities.has(s) ? "opacity-55" : ""
                  )}
                >
                  <span className={cn("size-2 rounded-full", SEVERITY_BG[s])} />
                  <span className={severities.has(s) ? SEVERITY_TEXT[s] : "text-fg-muted"}>{SEVERITY_LABEL[s]}</span>
                  <span className="tnum font-semibold text-fg">{counts[s]}</span>
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="relative min-w-[140px] flex-1">
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as Category | "all")}
                  className="h-7 w-full appearance-none rounded-md border border-line-strong bg-raised pl-2.5 pr-7 text-[12.5px] text-fg outline-none focus:border-accent"
                  aria-label="Category"
                >
                  <option value="all">All categories</option>
                  {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABEL[c]}
                    </option>
                  ))}
                </select>
                <Icon name="chevronDown" size={13} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-fg-subtle" />
              </span>
              <Segmented
                size="xs"
                label="Found by"
                value={source}
                onChange={setSource}
                options={[
                  { value: "all", label: "All" },
                  { value: "heuristic", label: "Rules", title: "Found by the built-in rules" },
                  { value: "ai", label: "AI", title: "Found by AI review" },
                ]}
              />
              <Segmented
                size="xs"
                label="Status"
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
              <EmptyState title="No file selected">Open a file to see its issues, or switch to All files to review the whole project.</EmptyState>
            ) : visible.length === 0 ? (
              <EmptyState title={scoped.length ? "No issues match these filters" : status === "open" ? "No open issues" : "No fixed issues yet"}>
                {scoped.length ? "Clear a filter to see more." : status === "open" ? "Nothing needs attention here." : "Issues resolved by an applied fix appear here."}
              </EmptyState>
            ) : (
              <ul>
                {visible.map((issue) => (
                  <IssueRow key={issue.id} issue={issue} active={issue.id === activeIssueId} showPath={scope === "workspace"} onJump={onJump} />
                ))}
              </ul>
            )}
          </div>
          <div className="flex h-9 shrink-0 items-center gap-2 border-t border-line px-3 text-[12px] text-fg-subtle">
            <span className="tnum">
              Showing {visible.length} of {scoped.length} {status} issue{scoped.length === 1 ? "" : "s"}
            </span>
            {filtersActive && (
              <button
                type="button"
                className="ml-auto font-medium text-accent hover:underline"
                onClick={() => {
                  setSeverities(new Set());
                  setCategory("all");
                  setSource("all");
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
