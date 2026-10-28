"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { FileDetailDto, IssueDto, Severity } from "@/lib/contracts";
import { buildDiff, type DiffModel } from "@/lib/diff-rows";
import { highlightLines, type Token } from "@/lib/highlight";
import { splitLines } from "@/lib/text";
import { CODE_ZOOM_STEPS, DEFAULT_CODE_SIZE, useCodeFontSize } from "@/lib/use-preferences";
import { useVirtualRows } from "@/lib/use-virtual";
import { cn, formatInt, relativeTime } from "@/lib/utils";
import { Button, EmptyState, Hint, Icon, IconButton, SEVERITY_BG, SEVERITY_LABEL, SEVERITY_ORDER, SEVERITY_TEXT, Segmented, SkeletonRows } from "./ui";

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

const rowHeightFor = (fontSize: number) => Math.round(fontSize * 1.65);

/**
 * Scroll container + spacer for fixed-height virtual rows. Width tracks the longest line so long
 * lines scroll horizontally; Ctrl/⌘ + wheel zooms.
 */
function VirtualCode({
  count,
  maxCols,
  gutterPx,
  fontSize,
  onZoom,
  focusIndex,
  focusNonce,
  render,
}: {
  count: number;
  maxCols: number;
  gutterPx: number;
  fontSize: number;
  onZoom: (direction: 1 | -1) => void;
  focusIndex: number | null;
  focusNonce: number;
  render: (index: number, rowH: number) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const rowH = rowHeightFor(fontSize);
  const v = useVirtualRows(ref, count, rowH, 20);
  const { scrollToIndex } = v;
  const zoomRef = useRef(onZoom);
  useEffect(() => {
    zoomRef.current = onZoom;
  }, [onZoom]);

  useEffect(() => {
    if (focusIndex !== null) scrollToIndex(focusIndex, "center");
  }, [focusIndex, focusNonce, scrollToIndex]);

  // Native listener: React's wheel handlers are passive and cannot stop the browser's page zoom.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomRef.current(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div ref={ref} className="scroll-code relative min-h-0 flex-1 overflow-auto bg-canvas" style={{ fontSize, lineHeight: `${rowH}px` }}>
      <div style={{ height: v.totalHeight + rowH, minWidth: `calc(${maxCols + 4}ch + ${gutterPx}px)` }} className="relative">
        <div style={{ transform: `translateY(${v.offset}px)` }} className="absolute inset-x-0 top-0 min-w-full pt-1">
          {Array.from({ length: v.end - v.start }, (_, k) => render(v.start + k, rowH))}
        </div>
      </div>
    </div>
  );
}

function SourceView({ file, focus, fontSize, onZoom }: { file: FileDetailDto; focus: FocusRequest | null; fontSize: number; onZoom: (d: 1 | -1) => void }) {
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
  const gutterPx = Math.round(String(lines.length).length * fontSize * 0.62 + 34);

  return (
    <VirtualCode
      count={lines.length}
      maxCols={maxCols}
      gutterPx={gutterPx}
      fontSize={fontSize}
      onZoom={onZoom}
      focusIndex={focus ? focus.line - 1 : null}
      focusNonce={focus?.nonce ?? 0}
      render={(i, rowH) => {
        const lineNo = i + 1;
        const issues = byLine.get(lineNo);
        const sev = issues ? worst(issues) : null;
        const focused = focus?.line === lineNo;
        return (
          <div key={i} className={cn("code flex", focused ? "bg-accent-soft" : sev === "critical" ? "bg-sev-critical-soft" : sev ? "bg-sev-medium-soft" : "hover:bg-hover")} style={{ height: rowH }}>
            <span
              className="tnum sticky left-0 z-10 flex shrink-0 items-center justify-end gap-2 border-r border-line bg-surface pr-2.5 text-fg-faint select-none"
              style={{ width: gutterPx }}
              title={issues?.map((x) => `${SEVERITY_LABEL[x.severity]}: ${x.title}`).join("\n")}
            >
              <span className={cn(focused && "font-semibold text-fg")}>{lineNo}</span>
              <span className={cn("h-[60%] w-[3px] rounded-full", sev ? SEVERITY_BG[sev] : "bg-transparent")} />
            </span>
            <span className="pl-4 pr-8 text-syn-plain">
              <Tokens tokens={tokens[i]} fallback={lines[i]} />
            </span>
          </div>
        );
      }}
    />
  );
}

function DiffView({ diff, before, after, language, layout, fontSize, onZoom }: { diff: DiffModel; before: string; after: string; language: string; layout: "unified" | "split"; fontSize: number; onZoom: (d: 1 | -1) => void }) {
  const beforeLines = useMemo(() => linesOf(before), [before]);
  const afterLines = useMemo(() => linesOf(after), [after]);
  const beforeTokens = useMemo(() => highlightLines(beforeLines, language), [beforeLines, language]);
  const afterTokens = useMemo(() => highlightLines(afterLines, language), [afterLines, language]);
  const maxCols = useMemo(() => Math.max(...beforeLines.map((l) => l.length), ...afterLines.map((l) => l.length), 0), [beforeLines, afterLines]);
  const num = Math.round(String(Math.max(beforeLines.length, afterLines.length)).length * fontSize * 0.62 + 16);

  const gap = (hidden: number | undefined, key: number, rowH: number) => (
    <div key={key} className="flex items-center border-y border-line bg-surface pl-4 text-[0.85em] text-fg-subtle" style={{ height: rowH }}>
      ⋯ {formatInt(hidden ?? 0)} unchanged line{hidden === 1 ? "" : "s"}
    </div>
  );

  if (diff.added === 0 && diff.removed === 0) return <EmptyState title="The proposed fix is identical to the current file" />;

  if (layout === "unified") {
    return (
      <VirtualCode
        count={diff.unified.length}
        maxCols={maxCols}
        gutterPx={num * 2 + 24}
        fontSize={fontSize}
        onZoom={onZoom}
        focusIndex={null}
        focusNonce={0}
        render={(i, rowH) => {
          const r = diff.unified[i];
          if (r.kind === "gap") return gap(r.hidden, i, rowH);
          const tokens = r.kind === "add" ? afterTokens[r.newNo! - 1] : beforeTokens[r.oldNo! - 1];
          return (
            <div key={i} className={cn("code flex", r.kind === "add" && "bg-diff-add", r.kind === "del" && "bg-diff-del")} style={{ height: rowH }}>
              <span className="tnum sticky left-0 z-10 flex shrink-0 border-r border-line bg-surface text-fg-faint select-none">
                <span className="pr-2 text-right" style={{ width: num }}>{r.oldNo ?? ""}</span>
                <span className="pr-2 text-right" style={{ width: num }}>{r.newNo ?? ""}</span>
                <span className={cn("w-6 text-center font-semibold", r.kind === "add" ? "bg-diff-add-strong text-ok" : r.kind === "del" ? "bg-diff-del-strong text-sev-critical" : "")}>{r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</span>
              </span>
              <span className="pl-3 pr-8 text-syn-plain">
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
      fontSize={fontSize}
      onZoom={onZoom}
      focusIndex={null}
      focusNonce={0}
      render={(i, rowH) => {
        const r = diff.split[i];
        if (r.kind === "gap") return gap(r.hidden, i, rowH);
        const side = (cell: typeof r.left, tokens: Token[][], tone: "add" | "del") => (
          <div className={cn("flex min-w-0 flex-1 overflow-hidden", cell?.changed && (tone === "add" ? "bg-diff-add" : "bg-diff-del"), !cell && "bg-surface")}>
            <span className="tnum shrink-0 border-r border-line pr-2 text-right text-fg-faint select-none" style={{ width: num }}>
              {cell?.no ?? ""}
            </span>
            <span className="truncate pl-3 pr-3 text-syn-plain">{cell ? <Tokens tokens={tokens[cell.no - 1]} fallback={cell.text} /> : " "}</span>
          </div>
        );
        return (
          <div key={i} className="code flex divide-x divide-line" style={{ height: rowH }}>
            {side(r.left, beforeTokens, "del")}
            {side(r.right, afterTokens, "add")}
          </div>
        );
      }}
    />
  );
}

function StatusSummary({ file, openIssues }: { file: FileDetailDto; openIssues: IssueDto[] }) {
  if (file.status === "analyzing") {
    return (
      <span className="flex items-center gap-2 text-[13px] font-medium text-accent">
        <Icon name="refresh" size={14} className="animate-spin" /> Analyzing…
      </span>
    );
  }
  if (file.status === "error") {
    return (
      <span className="flex items-center gap-2 text-[13px] font-semibold text-sev-critical">
        <Icon name="alert" size={14} /> Analysis incomplete
      </span>
    );
  }
  if (openIssues.length === 0) {
    return (
      <span className="flex items-center gap-2 text-[13px] font-semibold text-ok">
        <Icon name="check" size={14} /> No issues found
      </span>
    );
  }
  const top = worst(openIssues)!;
  const counts = SEVERITY_ORDER.map((s) => [s, openIssues.filter((i) => i.severity === s).length] as const).filter(([, n]) => n > 0);
  return (
    <span className="flex min-w-0 items-center gap-3">
      <span className={cn("shrink-0 text-[13px] font-semibold", SEVERITY_TEXT[top])}>
        {openIssues.length} issue{openIssues.length === 1 ? "" : "s"} to fix
      </span>
      <span className="hidden min-w-0 items-center gap-2.5 truncate text-[12.5px] text-fg-muted md:flex">
        {counts.map(([s, n]) => (
          <span key={s} className="flex items-center gap-1">
            <span className={cn("size-1.5 rounded-full", SEVERITY_BG[s])} />
            {n} {SEVERITY_LABEL[s].toLowerCase()}
          </span>
        ))}
      </span>
    </span>
  );
}

export function CodeViewport({
  file,
  loading,
  focus,
  aiConfigured,
  canGitCommit,
  isDemo,
  analyzing,
  committing,
  onAnalyze,
  onCommit,
  onOpenFirst,
}: {
  file: FileDetailDto | undefined;
  loading: boolean;
  focus: FocusRequest | null;
  aiConfigured: boolean;
  canGitCommit: boolean;
  isDemo: boolean;
  analyzing: boolean;
  committing: boolean;
  onAnalyze: () => void;
  onCommit: (opts: { git: boolean }) => void;
  onOpenFirst: (() => void) | null;
}) {
  const [view, setView] = useState<"source" | "diff">("source");
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const [git, setGit] = useState(true);
  const [fontSize, setFontSize] = useCodeFontSize();
  const [prevFocus, setPrevFocus] = useState(focus);
  const [prevHash, setPrevHash] = useState(file?.contentHash);

  // A jump request from the issue list always lands in the code view.
  if (focus !== prevFocus) {
    setPrevFocus(focus);
    if (focus && view !== "source") setView("source");
  }
  // New content (another file, or an applied fix) returns to the code view.
  if (file?.contentHash !== prevHash) {
    setPrevHash(file?.contentHash);
    if (view !== "source") setView("source");
  }

  const patch = file?.patchCommittable && file.correctedContent ? file.correctedContent : null;
  const diff = useMemo(() => (file && patch ? buildDiff(file.content, patch) : null), [file, patch]);

  const steps = CODE_ZOOM_STEPS as readonly number[];
  const zoom = (direction: 1 | -1) => {
    const idx = steps.indexOf(fontSize);
    setFontSize(steps[Math.min(steps.length - 1, Math.max(0, idx + direction))]);
  };

  if (!file) {
    return (
      <section className="flex min-h-0 flex-col bg-canvas" aria-label="Code">
        {loading ? (
          <SkeletonRows rows={22} />
        ) : (
          <div className="flex h-full items-center justify-center p-8">
            <div className="w-full max-w-[460px] rounded-xl border border-line bg-surface p-6">
              <div className="text-[16px] font-semibold text-fg">{isDemo ? "Try AetherOps on the sample project" : "Select a file to begin"}</div>
              <p className="mt-1.5 text-[13px] leading-relaxed text-fg-subtle">
                {isDemo
                  ? "Three small services with real-world bugs are loaded. Nothing here touches your computer, and Reset sample restores them at any time."
                  : "Pick a file in the Files panel, or click an issue to jump straight to the line that needs attention."}
              </p>
              <ol className="mt-5 space-y-3.5">
                {[
                  ["Open a file", "Issues are highlighted next to the line numbers and listed on the right."],
                  ["Review an issue", "Click it to jump to the exact line and read how to fix it."],
                  [aiConfigured ? "Apply the proposed fix" : "Fix with AI (optional)", aiConfigured ? "Open Proposed fix to compare before and after, then apply it in one click." : "Add a Gemini API key to get line-by-line fixes you can apply in one click."],
                ].map(([title, body], i) => (
                  <li key={title} className="flex gap-3">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-[12.5px] font-semibold text-accent">{i + 1}</span>
                    <span>
                      <span className="block text-[13.5px] font-medium text-fg">{title}</span>
                      <span className="block text-[12.5px] leading-relaxed text-fg-subtle">{body}</span>
                    </span>
                  </li>
                ))}
              </ol>
              {onOpenFirst && (
                <Button variant="primary" className="mt-6" icon="file" onClick={onOpenFirst}>
                  Open the first sample file
                </Button>
              )}
            </div>
          </div>
        )}
      </section>
    );
  }

  const openIssues = file.issues.filter((i) => i.status === "open");
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : "";
  const name = file.path.slice(dir.length);
  const checkedBy = file.engine === "hybrid" ? "Rules + AI review" : file.engine === "heuristic" ? "Rules only" : "Not analyzed";

  const commitClick = () => {
    if (view !== "diff") {
      setView("diff");
      return;
    }
    onCommit({ git: canGitCommit && git });
  };

  return (
    <section
      className="flex min-h-0 flex-col bg-canvas"
      aria-label="Code"
      onKeyDown={(e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        const action = e.key === "=" || e.key === "+" ? () => zoom(1) : e.key === "-" ? () => zoom(-1) : e.key === "0" ? () => setFontSize(DEFAULT_CODE_SIZE) : null;
        if (!action) return;
        e.preventDefault();
        action();
      }}
    >
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-canvas px-4">
        <span className="min-w-[120px] shrink truncate font-mono text-[13px]" title={`${file.path}\nSHA-256 ${file.contentHash}\n${file.eol.toUpperCase()} line endings`}>
          <span className="text-fg-subtle">{dir}</span>
          <span className="font-semibold text-fg">{name}</span>
        </span>
        <span className="hidden shrink-0 text-[12px] text-fg-subtle 2xl:inline">
          {file.language} · {formatInt(file.lineCount)} lines
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Segmented
            label="View"
            value={view}
            onChange={setView}
            options={[
              { value: "source", label: "Code" },
              {
                value: "diff",
                label: (
                  <span className="flex items-center gap-1.5">
                    Proposed fix
                    {diff && (
                      <span className="tnum text-[11.5px]">
                        <span className="text-ok">+{diff.added}</span> <span className="text-sev-critical">−{diff.removed}</span>
                      </span>
                    )}
                  </span>
                ),
                title: patch ? "Compare the current code with the AI-proposed fix" : "No fix proposed yet",
              },
            ]}
          />
          {view === "diff" && patch && (
            <Segmented
              label="Diff layout"
              value={layout}
              onChange={setLayout}
              options={[
                { value: "unified", label: "Inline" },
                { value: "split", label: "Side by side" },
              ]}
            />
          )}
          <div className="flex items-center rounded-md border border-line" aria-label="Code zoom">
            <IconButton icon="minus" label="Zoom out (Ctrl −)" className="size-7" disabled={fontSize === steps[0]} onClick={() => zoom(-1)} />
            <button type="button" title="Reset zoom (Ctrl 0)" onClick={() => setFontSize(DEFAULT_CODE_SIZE)} className="tnum w-11 text-center text-[12px] text-fg-muted hover:text-fg">
              {Math.round((fontSize / DEFAULT_CODE_SIZE) * 100)}%
            </button>
            <IconButton icon="plus" label="Zoom in (Ctrl +)" className="size-7" disabled={fontSize === steps[steps.length - 1]} onClick={() => zoom(1)} />
          </div>
        </div>
      </div>

      <div className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line bg-surface px-4 py-2">
        <StatusSummary file={file} openIssues={openIssues} />
        {file.qualityScore !== null && file.status !== "analyzing" && (
          <span className="flex items-center gap-1 text-[12.5px] text-fg-muted">
            Quality <span className="tnum font-semibold text-fg">{file.qualityScore}</span>/100
            <Hint>Score for this file: 100 minus a penalty per open issue (critical 20, high 10, medium 4, low 1). With AI review, the AI&apos;s own assessment can lower it further.</Hint>
          </span>
        )}
        <span className="hidden items-center gap-1 text-[12.5px] text-fg-subtle xl:flex">
          {checkedBy}
          {file.lastAnalyzedAt && <span className="hidden 2xl:inline">· {relativeTime(file.lastAnalyzedAt)}</span>}
          <Hint>Rules: instant built-in checks for security, reliability, and performance. AI review adds deeper analysis and proposes a fix you can apply.</Hint>
        </span>
        {file.stale && <span className="text-[12.5px] font-medium text-sev-medium">Changed since last analysis</span>}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button size="xs" icon="refresh" loading={analyzing || file.status === "analyzing"} onClick={onAnalyze} title={aiConfigured ? "Run the rules and an AI review again" : "Run the built-in rules again"}>
            Re-analyze
          </Button>
          {patch && canGitCommit && view === "diff" && (
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-[12.5px] text-fg-muted">
              <input type="checkbox" checked={git} onChange={(e) => setGit(e.target.checked)} className="size-3.5 accent-[var(--color-accent)]" />
              Also git commit
            </label>
          )}
          <Button size="xs" variant="primary" icon={view === "diff" ? "check" : "diff"} disabled={!patch} loading={committing} onClick={commitClick} title={patch ? undefined : aiConfigured ? "No fix proposed for the current code yet" : "Fixes are proposed by AI review"}>
            {view === "diff" ? (isDemo ? "Apply fix" : "Apply fix to file") : "Review fix"}
          </Button>
        </div>
      </div>

      {(file.errorMessage || file.summary) && (
        <div className={cn("flex shrink-0 items-start gap-2 border-b border-line px-4 py-2 text-[12.5px] leading-relaxed", file.errorMessage ? "bg-danger-bg text-danger-fg" : "text-fg-muted")}>
          <Icon name={file.errorMessage ? "alert" : "sparkle"} size={14} className="mt-0.5" />
          <span className="line-clamp-2">{file.errorMessage ?? file.summary}</span>
        </div>
      )}

      {view === "source" ? (
        <SourceView file={file} focus={focus} fontSize={fontSize} onZoom={zoom} />
      ) : patch && diff ? (
        <DiffView diff={diff} before={file.content} after={patch} language={file.language} layout={layout} fontSize={fontSize} onZoom={zoom} />
      ) : (
        <EmptyState title="No fix proposed yet">
          {aiConfigured ? "Click Re-analyze to run an AI review; it proposes a fix for the issues it can resolve." : "Fixes are proposed by AI review. Add GEMINI_API_KEY and GEMINI_MODEL to enable it."}
        </EmptyState>
      )}
    </section>
  );
}
