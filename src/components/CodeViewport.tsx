"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { FileDetailDto, IssueDto, Severity } from "@/lib/contracts";
import { buildDiff, type DiffModel } from "@/lib/diff-rows";
import { highlightLines, type Token } from "@/lib/highlight";
import { splitLines } from "@/lib/text";
import { useVirtualRows } from "@/lib/use-virtual";
import { cn, formatBytes, formatInt, relativeTime } from "@/lib/utils";
import { Button, EmptyState, Icon, SEVERITY_BG, SEVERITY_ORDER, Segmented, SkeletonRows } from "./ui";

const ROW_H = 20;

export interface FocusRequest {
  line: number;
  nonce: number;
}

function linesOf(content: string): string[] {
  const lines = splitLines(content);
  if (lines.length > 1 && /\r?\n$/.test(content)) lines.pop();
  return lines;
}

function Tokens({ tokens, fallback }: { tokens: Token[] | undefined; fallback: string }) {
  if (!tokens) return <>{fallback || " "}</>;
  if (tokens.length === 0) return <> </>;
  return (
    <>
      {tokens.map((t, i) =>
        t.cls ? (
          <span key={i} className={`syn-${t.cls}`}>
            {t.text}
          </span>
        ) : (
          <span key={i}>{t.text}</span>
        )
      )}
    </>
  );
}

function worst(issues: IssueDto[]): Severity | null {
  for (const s of SEVERITY_ORDER) if (issues.some((i) => i.severity === s)) return s;
  return null;
}

/** Scroll container + spacer for fixed-height virtual rows; width tracks the longest line. */
function VirtualCode({ count, maxCols, gutterPx, focusIndex, focusNonce, render }: { count: number; maxCols: number; gutterPx: number; focusIndex: number | null; focusNonce: number; render: (index: number) => ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const v = useVirtualRows(ref, count, ROW_H, 20);
  const { scrollToIndex } = v;
  useEffect(() => {
    if (focusIndex !== null) scrollToIndex(focusIndex, "center");
  }, [focusIndex, focusNonce, scrollToIndex]);

  return (
    <div ref={ref} className="relative min-h-0 flex-1 overflow-auto bg-canvas">
      <div style={{ height: v.totalHeight, minWidth: `calc(${maxCols}ch + ${gutterPx + 32}px)` }} className="relative">
        <div style={{ transform: `translateY(${v.offset}px)` }} className="absolute inset-x-0 top-0 min-w-full">
          {Array.from({ length: v.end - v.start }, (_, k) => render(v.start + k))}
        </div>
      </div>
    </div>
  );
}

function SourceView({ file, focus }: { file: FileDetailDto; focus: FocusRequest | null }) {
  const lines = useMemo(() => linesOf(file.content), [file.content]);
  const tokens = useMemo(() => highlightLines(lines, file.language), [lines, file.language]);
  const byLine = useMemo(() => {
    const m = new Map<number, IssueDto[]>();
    for (const issue of file.issues) {
      if (issue.status !== "open") continue;
      for (let l = issue.line; l <= Math.min(issue.endLine, issue.line + 50); l++) m.set(l, [...(m.get(l) ?? []), issue]);
    }
    return m;
  }, [file.issues]);
  const maxCols = useMemo(() => lines.reduce((m, l) => Math.max(m, l.length), 0), [lines]);
  const digits = String(lines.length).length;
  const gutterPx = digits * 7.3 + 28;

  return (
    <VirtualCode
      count={lines.length}
      maxCols={maxCols}
      gutterPx={gutterPx}
      focusIndex={focus ? focus.line - 1 : null}
      focusNonce={focus?.nonce ?? 0}
      render={(i) => {
        const lineNo = i + 1;
        const issues = byLine.get(lineNo);
        const sev = issues ? worst(issues) : null;
        const focused = focus?.line === lineNo;
        return (
          <div key={i} className={cn("code flex h-5", focused ? "bg-accent/14" : sev === "critical" ? "bg-sev-critical/[0.07]" : sev ? "bg-hover/60" : "hover:bg-hover/50")}>
            <span
              className="tnum sticky left-0 z-10 flex shrink-0 items-center justify-end gap-1.5 border-r border-line bg-canvas pr-2 text-fg-faint select-none"
              style={{ width: gutterPx }}
              title={issues?.map((x) => `${x.severity.toUpperCase()} ${x.ruleId}: ${x.title}`).join("\n")}
            >
              <span className={cn(focused && "text-fg-muted")}>{lineNo}</span>
              <span className={cn("h-3.5 w-[3px] rounded-[1px]", sev ? SEVERITY_BG[sev] : "bg-transparent")} />
            </span>
            <span className="pl-3 pr-6 text-syn-plain">
              <Tokens tokens={tokens[i]} fallback={lines[i]} />
            </span>
          </div>
        );
      }}
    />
  );
}

function DiffView({ before, after, language, layout }: { before: string; after: string; language: string; layout: "unified" | "split" }) {
  const diff: DiffModel = useMemo(() => buildDiff(before, after), [before, after]);
  const beforeLines = useMemo(() => linesOf(before), [before]);
  const afterLines = useMemo(() => linesOf(after), [after]);
  const beforeTokens = useMemo(() => highlightLines(beforeLines, language), [beforeLines, language]);
  const afterTokens = useMemo(() => highlightLines(afterLines, language), [afterLines, language]);
  const maxCols = useMemo(() => Math.max(...beforeLines.map((l) => l.length), ...afterLines.map((l) => l.length), 0), [beforeLines, afterLines]);
  const digits = String(Math.max(beforeLines.length, afterLines.length)).length;
  const num = digits * 7.3 + 12;

  const gap = (hidden: number | undefined, key: number) => (
    <div key={key} className="code flex h-5 items-center border-y border-line bg-surface pl-3 text-[11px] text-fg-subtle">
      ⋯ {formatInt(hidden ?? 0)} unchanged line{hidden === 1 ? "" : "s"}
    </div>
  );

  if (diff.added === 0 && diff.removed === 0) return <EmptyState title="Patch is identical to the current file" />;

  if (layout === "unified") {
    return (
      <VirtualCode
        count={diff.unified.length}
        maxCols={maxCols}
        gutterPx={num * 2 + 16}
        focusIndex={null}
        focusNonce={0}
        render={(i) => {
          const r = diff.unified[i];
          if (r.kind === "gap") return gap(r.hidden, i);
          const tokens = r.kind === "add" ? afterTokens[r.newNo! - 1] : beforeTokens[r.oldNo! - 1];
          return (
            <div key={i} className={cn("code flex h-5", r.kind === "add" && "bg-diff-add", r.kind === "del" && "bg-diff-del")}>
              <span className="tnum sticky left-0 z-10 flex shrink-0 border-r border-line bg-canvas text-fg-faint select-none">
                <span className="pr-2 text-right" style={{ width: num }}>{r.oldNo ?? ""}</span>
                <span className="pr-2 text-right" style={{ width: num }}>{r.newNo ?? ""}</span>
                <span className={cn("w-4 text-center", r.kind === "add" ? "text-ok" : r.kind === "del" ? "text-sev-critical" : "")}>{r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</span>
              </span>
              <span className="pl-2 pr-6 text-syn-plain">
                <Tokens tokens={tokens} fallback={r.text} />
              </span>
            </div>
          );
        }}
      />
    );
  }

  return (
    <VirtualCode
      count={diff.split.length}
      maxCols={maxCols * 2}
      gutterPx={num * 2}
      focusIndex={null}
      focusNonce={0}
      render={(i) => {
        const r = diff.split[i];
        if (r.kind === "gap") return gap(r.hidden, i);
        const side = (cell: typeof r.left, tokens: Token[][], tone: "add" | "del") => (
          <div className={cn("flex min-w-0 flex-1 overflow-hidden", cell?.changed && (tone === "add" ? "bg-diff-add" : "bg-diff-del"), !cell && "bg-surface/60")}>
            <span className="tnum shrink-0 border-r border-line pr-2 text-right text-fg-faint select-none" style={{ width: num }}>
              {cell?.no ?? ""}
            </span>
            <span className="truncate pl-2 pr-3 text-syn-plain">{cell ? <Tokens tokens={tokens[cell.no - 1]} fallback={cell.text} /> : " "}</span>
          </div>
        );
        return (
          <div key={i} className="code flex h-5 divide-x divide-line">
            {side(r.left, beforeTokens, "del")}
            {side(r.right, afterTokens, "add")}
          </div>
        );
      }}
    />
  );
}

export function CodeViewport({
  file,
  loading,
  focus,
  aiConfigured,
  canGitCommit,
  analyzing,
  committing,
  onAnalyze,
  onCommit,
}: {
  file: FileDetailDto | undefined;
  loading: boolean;
  focus: FocusRequest | null;
  aiConfigured: boolean;
  canGitCommit: boolean;
  analyzing: boolean;
  committing: boolean;
  onAnalyze: () => void;
  onCommit: (opts: { git: boolean }) => void;
}) {
  const [view, setView] = useState<"source" | "diff">("source");
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const [git, setGit] = useState(true);
  const [prevFocus, setPrevFocus] = useState(focus);
  const [prevHash, setPrevHash] = useState(file?.contentHash);

  // A jump request from the issue tracker always lands in the source view.
  if (focus !== prevFocus) {
    setPrevFocus(focus);
    if (focus && view !== "source") setView("source");
  }
  // New content (another file, or a committed patch) returns to the source view.
  if (file?.contentHash !== prevHash) {
    setPrevHash(file?.contentHash);
    if (view !== "source") setView("source");
  }

  if (!file) {
    return (
      <section className="flex min-h-0 flex-col bg-canvas" aria-label="Code viewport">
        {loading ? <SkeletonRows rows={22} /> : <EmptyState title="No file selected">Select a file in the explorer, or an issue in the tracker to jump to its line.</EmptyState>}
      </section>
    );
  }

  const openIssues = file.issues.filter((i) => i.status === "open").length;
  const patchReady = file.patchCommittable && !!file.correctedContent;
  const engineLabel = file.engine === "hybrid" ? "AI + HEURISTIC" : file.engine === "heuristic" ? "HEURISTIC" : "NOT ANALYZED";

  const commitClick = () => {
    if (view !== "diff") {
      setView("diff");
      return;
    }
    onCommit({ git: canGitCommit && git });
  };

  return (
    <section className="flex min-h-0 flex-col bg-canvas" aria-label="Code viewport">
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
        <Icon name="file" size={13} className="text-fg-subtle" />
        <span className="min-w-0 truncate font-mono text-[12px] text-fg" title={file.path}>
          {file.path}
        </span>
        <span className="tnum hidden shrink-0 items-center gap-2.5 font-mono text-[10.5px] text-fg-subtle md:flex">
          <span>{file.language}</span>
          <span>{formatInt(file.lineCount)} LOC</span>
          <span>{formatBytes(file.fileSize)}</span>
          <span title={`sha256 ${file.contentHash}`}>{file.contentHash.slice(0, 10)}</span>
          <span>{file.eol.toUpperCase()}</span>
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: "source", label: "Source" },
              { value: "diff", label: patchReady ? "Diff" : "Diff (none)" },
            ]}
          />
          {view === "diff" && patchReady && (
            <Segmented
              value={layout}
              onChange={setLayout}
              options={[
                { value: "unified", label: "Unified" },
                { value: "split", label: "Split" },
              ]}
            />
          )}
        </div>
      </div>

      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
        <span
          className={cn(
            "rounded-[2px] border px-1.5 py-px font-mono text-[10px] font-semibold tracking-wide",
            file.status === "error" ? "border-sev-critical/40 text-sev-critical" : file.status === "clean" ? "border-ok/40 text-ok" : file.status === "issues" ? "border-sev-medium/40 text-sev-medium" : "border-line-strong text-fg-muted"
          )}
        >
          {file.status.toUpperCase()}
        </span>
        <span className="shrink-0 whitespace-nowrap font-mono text-[10.5px] text-fg-subtle">{engineLabel}</span>
        <span className="tnum min-w-0 truncate whitespace-nowrap font-mono text-[10.5px] text-fg-muted">
          {openIssues} open{file.qualityScore !== null && ` · Q ${file.qualityScore}`}
          {file.stale && " · modified since analysis"}
        </span>
        <span className="hidden min-w-0 truncate whitespace-nowrap font-mono text-[10.5px] text-fg-subtle 2xl:inline">{file.modelUsed ? `${file.modelUsed} · ` : ""}{relativeTime(file.lastAnalyzedAt)}</span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button size="xs" variant="ghost" icon="refresh" loading={analyzing || file.status === "analyzing"} onClick={onAnalyze} title={aiConfigured ? "Run hybrid AI + heuristic analysis" : "AI not configured: runs the deterministic engine"}>
            {aiConfigured ? "Deep analyze" : "Re-scan"}
          </Button>
          {patchReady && canGitCommit && view === "diff" && (
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-[11px] text-fg-muted">
              <input type="checkbox" checked={git} onChange={(e) => setGit(e.target.checked)} className="size-3 accent-[var(--color-accent)]" />
              git commit
            </label>
          )}
          <Button size="xs" variant="primary" icon="commit" disabled={!patchReady} loading={committing} onClick={commitClick} title={patchReady ? undefined : "No patch for the current content"}>
            {view === "diff" ? "Apply & commit patch" : "Review patch"}
          </Button>
        </div>
      </div>

      {(file.errorMessage || file.summary) && (
        <div className={cn("flex shrink-0 items-start gap-2 border-b border-line px-3 py-1.5 text-[11.5px]", file.errorMessage ? "bg-sev-critical/[0.06] text-sev-critical" : "text-fg-muted")}>
          {file.errorMessage && <Icon name="alert" size={13} className="mt-px" />}
          <span className="line-clamp-2">{file.errorMessage ?? file.summary}</span>
        </div>
      )}

      {view === "source" ? (
        <SourceView file={file} focus={focus} />
      ) : patchReady ? (
        <DiffView before={file.content} after={file.correctedContent!} language={file.language} layout={layout} />
      ) : (
        <EmptyState title="No patch for this revision">
          {aiConfigured ? "Run Deep analyze to generate a line-range patch for the current content." : "Patches are generated by the AI engine. Configure GEMINI_API_KEY and GEMINI_MODEL to enable remediation."}
        </EmptyState>
      )}
    </section>
  );
}
