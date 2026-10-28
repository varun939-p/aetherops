"use client";

import { useMemo, useRef, useState } from "react";
import type { FileSummaryDto } from "@/lib/contracts";
import { useVirtualRows } from "@/lib/use-virtual";
import { basename, cn, fuzzyMatch } from "@/lib/utils";
import { FileStatusMark, HighlightedText, Icon, PaneHeader, Segmented, SkeletonRows, EmptyState } from "./ui";

interface DirNode {
  name: string;
  path: string;
  dirs: Map<string, DirNode>;
  files: FileSummaryDto[];
  open: number;
  critical: number;
}

type Row =
  | { kind: "dir"; node: DirNode; depth: number }
  | { kind: "file"; file: FileSummaryDto; depth: number; positions?: number[] };

const ROW_H = 24;

function buildTree(files: FileSummaryDto[]): DirNode {
  const root: DirNode = { name: "", path: "", dirs: new Map(), files: [], open: 0, critical: 0 };
  for (const f of files) {
    const parts = f.path.split("/");
    let cur = root;
    cur.open += f.openIssues;
    cur.critical += f.criticalIssues;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let next = cur.dirs.get(parts[i]);
      if (!next) {
        next = { name: parts[i], path, dirs: new Map(), files: [], open: 0, critical: 0 };
        cur.dirs.set(parts[i], next);
      }
      next.open += f.openIssues;
      next.critical += f.criticalIssues;
      cur = next;
    }
    cur.files.push(f);
  }
  return root;
}

function flatten(node: DirNode, expanded: Set<string>, depth: number, out: Row[]): Row[] {
  const dirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const d of dirs) {
    // Collapse single-child directory chains (src/app/api → one row) like modern IDEs.
    let collapsed = d;
    let label = d.name;
    while (collapsed.files.length === 0 && collapsed.dirs.size === 1) {
      collapsed = [...collapsed.dirs.values()][0];
      label += `/${collapsed.name}`;
    }
    out.push({ kind: "dir", node: { ...collapsed, name: label }, depth });
    if (expanded.has(collapsed.path)) flatten(collapsed, expanded, depth + 1, out);
  }
  for (const f of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) out.push({ kind: "file", file: f, depth });
  return out;
}

type Quick = "all" | "faults" | "modified";

export function RepositoryExplorer({
  files,
  loading,
  selectedId,
  onSelect,
  onAnalyze,
  onDelete,
}: {
  files: FileSummaryDto[] | undefined;
  loading: boolean;
  selectedId: number | null;
  onSelect: (id: number) => void;
  onAnalyze: (id: number) => void;
  onDelete: (file: FileSummaryDto) => void;
}) {
  const [query, setQuery] = useState("");
  const [quick, setQuick] = useState<Quick>("all");
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  const visibleFiles = useMemo(() => {
    const list = files ?? [];
    if (quick === "faults") return list.filter((f) => f.openIssues > 0 || f.status === "error");
    if (quick === "modified") return list.filter((f) => f.stale || f.status === "pending" || f.status === "analyzing");
    return list;
  }, [files, quick]);

  const tree = useMemo(() => buildTree(visibleFiles), [visibleFiles]);

  const rows = useMemo<Row[]>(() => {
    if (query.trim()) {
      return visibleFiles
        .map((file) => ({ file, m: fuzzyMatch(query.trim(), file.path) }))
        .filter((x): x is { file: FileSummaryDto; m: NonNullable<ReturnType<typeof fuzzyMatch>> } => x.m !== null)
        .sort((a, b) => b.m.score - a.m.score)
        .slice(0, 500)
        .map(({ file, m }) => ({ kind: "file" as const, file, depth: 0, positions: m.positions }));
    }
    // Every directory is expanded unless the user collapsed it.
    const expanded = new Set<string>();
    const walk = (n: DirNode) => n.dirs.forEach((d) => {
      if (!collapsedDirs.has(d.path)) expanded.add(d.path);
      walk(d);
    });
    walk(tree);
    return flatten(tree, expanded, 0, []);
  }, [query, visibleFiles, tree, collapsedDirs]);

  const v = useVirtualRows(scrollRef, rows.length, ROW_H);
  const toggle = (path: string) =>
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const faults = (files ?? []).filter((f) => f.criticalIssues > 0).length;

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-surface" aria-label="Repository explorer">
      <PaneHeader title="Explorer">
        <span className="tnum font-mono text-[10.5px] font-normal normal-case tracking-normal text-fg-subtle">
          {files ? `${files.length} files${faults ? ` · ${faults} critical` : ""}` : ""}
        </span>
      </PaneHeader>
      <div className="flex shrink-0 flex-col gap-2 border-b border-line p-2">
        <label className="flex h-7 items-center gap-2 rounded-[3px] border border-line-strong bg-canvas px-2 focus-within:border-accent">
          <Icon name="search" size={12} className="text-fg-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && rows[0]?.kind === "file") onSelect(rows[0].file.id);
              if (e.key === "Escape") setQuery("");
            }}
            placeholder="Filter files (fuzzy)"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-fg outline-none placeholder:text-fg-faint"
          />
        </label>
        <Segmented<Quick>
          size="xs"
          value={quick}
          onChange={setQuick}
          options={[
            { value: "all", label: "All" },
            { value: "faults", label: "Faults" },
            { value: "modified", label: "Modified" },
          ]}
        />
      </div>

      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto">
        {loading && !files ? (
          <SkeletonRows rows={14} />
        ) : rows.length === 0 ? (
          <EmptyState title={files?.length ? "No matching files" : "No files"}>
            {files?.length ? "Adjust the filter." : "Link a workspace to ingest a repository."}
          </EmptyState>
        ) : (
          <div style={{ height: v.totalHeight }} className="relative">
            <div style={{ transform: `translateY(${v.offset}px)` }} className="absolute inset-x-0 top-0">
              {rows.slice(v.start, v.end).map((row) =>
                row.kind === "dir" ? (
                  <button
                    key={`d:${row.node.path}`}
                    type="button"
                    onClick={() => toggle(row.node.path)}
                    className="flex h-6 w-full items-center gap-1 pr-2 text-left text-[12px] text-fg-muted hover:bg-hover"
                    style={{ paddingLeft: 8 + row.depth * 12 }}
                  >
                    <Icon name={collapsedDirs.has(row.node.path) ? "chevronRight" : "chevronDown"} size={12} className="text-fg-subtle" />
                    <span className="truncate font-mono text-[11.5px]">{row.node.name}</span>
                    {row.node.critical > 0 && <span className="tnum ml-auto font-mono text-[10.5px] text-sev-critical">{row.node.critical}</span>}
                  </button>
                ) : (
                  <div
                    key={`f:${row.file.id}`}
                    role="button"
                    tabIndex={0}
                    aria-current={row.file.id === selectedId ? "true" : undefined}
                    onClick={() => onSelect(row.file.id)}
                    onKeyDown={(e) => e.key === "Enter" && onSelect(row.file.id)}
                    title={row.file.path}
                    className={cn(
                      "group flex h-6 cursor-pointer items-center gap-2 pr-1.5 text-[12px]",
                      row.file.id === selectedId ? "bg-accent/12 text-fg shadow-[inset_2px_0_0_var(--color-accent)]" : "text-fg-muted hover:bg-hover hover:text-fg"
                    )}
                    style={{ paddingLeft: 8 + row.depth * 12 + 13 }}
                  >
                    <span className="flex w-2.5 justify-center">
                      <FileStatusMark status={row.file.status} critical={row.file.criticalIssues} stale={row.file.stale} />
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                      {row.positions ? <HighlightedText text={row.file.path} positions={row.positions} /> : basename(row.file.path)}
                    </span>
                    {row.file.openIssues > 0 && (
                      <span className={cn("tnum font-mono text-[10.5px] group-hover:hidden", row.file.criticalIssues ? "text-sev-critical" : "text-fg-subtle")}>{row.file.openIssues}</span>
                    )}
                    <span className="hidden items-center group-hover:flex">
                      <button type="button" title="Analyze" onClick={(e) => (e.stopPropagation(), onAnalyze(row.file.id))} className="rounded-[2px] p-0.5 text-fg-subtle hover:bg-raised hover:text-fg">
                        <Icon name="play" size={12} />
                      </button>
                      <button type="button" title="Delete from disk and index" onClick={(e) => (e.stopPropagation(), onDelete(row.file))} className="rounded-[2px] p-0.5 text-fg-subtle hover:bg-raised hover:text-sev-critical">
                        <Icon name="trash" size={12} />
                      </button>
                    </span>
                  </div>
                )
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
