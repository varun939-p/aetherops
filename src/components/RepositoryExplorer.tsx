"use client";
import { useState, useMemo } from "react";
import { StatusBadge, Skeleton } from "./ui";
import { getFileNameFromPath } from "@/lib/utils";

export interface FileItem {
  id: number;
  path: string;
  language: string;
  status: string;
  issuesCount?: number;
  criticalCount?: number;
  fileSize: number;
  lineCount: number;
  content?: string;
  extension?: string;
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: Map<string, TreeNode>;
  file?: FileItem;
}

function buildTree(files: FileItem[]): TreeNode {
  const root: TreeNode = { name: "root", path: "", isDir: true, children: new Map() };
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let cur = root;
    let curPath = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      curPath = curPath ? `${curPath}/${part}` : part;
      const isLast = i === parts.length - 1;
      if (!cur.children.has(part)) {
        cur.children.set(part, {
          name: part,
          path: curPath,
          isDir: !isLast,
          children: new Map(),
          file: isLast ? f : undefined,
        });
      }
      const next = cur.children.get(part)!;
      if (isLast) next.file = f;
      cur = next;
    }
  }
  return root;
}

function TreeView({
  node,
  depth,
  selectedPath,
  onSelect,
  expandedPaths,
  toggleExpand,
}: {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (file: FileItem) => void;
  expandedPaths: Set<string>;
  toggleExpand: (p: string) => void;
}) {
  const isExpanded = expandedPaths.has(node.path);
  const isSelected = node.file && selectedPath === node.file.path;

  if (!node.isDir) {
    const f = node.file!;
    return (
      <div
        onClick={() => onSelect(f)}
        className={`group flex items-center gap-2 px-2 py-1.5 mx-1 rounded cursor-pointer text-xs font-mono transition-colors ${
          isSelected ? "bg-[#00ff88]/10 text-[#00ff88] border border-[#00ff88]/20" : "text-[#6b8a7a] hover:text-[#d6ffe8] hover:bg-[#1a2e25]"
        }`}
        style={{ marginLeft: depth * 12 + 4 }}
      >
        <span className="text-[10px]">{f.status === "issues" ? "◉" : f.status === "clean" ? "◎" : "◍"}</span>
        <span className="truncate flex-1">{node.name}</span>
        {f.issuesCount ? (
          <span className={`text-[9px] px-1 rounded ${f.criticalCount ? "bg-[#ff3b5c]/20 text-[#ff3b5c]" : "bg-[#ffcc33]/20 text-[#ffcc33]"}`}>
            {f.issuesCount}
          </span>
        ) : null}
      </div>
    );
  }

  // dir
  const children = Array.from(node.children.values()).sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  // root don't render itself
  if (depth === -1) {
    return (
      <>
        {children.map((ch) => (
          <TreeView
            key={ch.path}
            node={ch}
            depth={0}
            selectedPath={selectedPath}
            onSelect={onSelect}
            expandedPaths={expandedPaths}
            toggleExpand={toggleExpand}
          />
        ))}
      </>
    );
  }

  return (
    <div>
      <div
        onClick={() => toggleExpand(node.path)}
        className="flex items-center gap-1.5 px-2 py-1 text-[11px] font-mono text-[#4a6a5a] hover:text-[#6b8a7a] cursor-pointer"
        style={{ marginLeft: depth * 12 + 4 }}
      >
        <span className="text-[10px] w-3">{isExpanded ? "▼" : "▶"}</span>
        <span>📁</span>
        <span className="truncate">{node.name}</span>
      </div>
      {isExpanded && (
        <div>
          {children.map((ch) => (
            <TreeView
              key={ch.path}
              node={ch}
              depth={depth + 1}
              selectedPath={selectedPath}
              onSelect={onSelect}
              expandedPaths={expandedPaths}
              toggleExpand={toggleExpand}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function RepositoryExplorer({
  files,
  selectedPath,
  onSelectFile,
  loading,
}: {
  files: FileItem[];
  selectedPath: string | null;
  onSelectFile: (f: FileItem) => void;
  loading: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const tree = useMemo(() => buildTree(files), [files]);

  const toggleExpand = (p: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  };

  // Auto expand all on first load if small
  useMemo(() => {
    if (files.length > 0 && files.length < 50) {
      const allDirs = new Set<string>();
      files.forEach((f) => {
        const parts = f.path.split("/").slice(0, -1);
        let cur = "";
        parts.forEach((part) => {
          cur = cur ? `${cur}/${part}` : part;
          allDirs.add(cur);
        });
      });
      setExpanded(allDirs);
    }
  }, [files]);

  if (loading) {
    return (
      <div className="p-3 space-y-2">
        {[...Array(8)].map((_, i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="p-6 text-center">
        <div className="text-[#4a6a5a] text-xs font-mono">No files synced yet</div>
        <div className="text-[10px] text-[#2a3e35] mt-1 font-mono">Link a folder to start SRE Watchdog</div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto py-2">
      <div className="px-3 pb-2 flex items-center justify-between">
        <span className="text-[10px] tracking-[0.2em] text-[#6b8a7a] font-mono">REPOSITORY EXPLORER</span>
        <span className="text-[10px] text-[#4a6a5a] font-mono">{files.length} files</span>
      </div>
      <TreeView
        node={tree}
        depth={-1}
        selectedPath={selectedPath}
        onSelect={onSelectFile}
        expandedPaths={expanded}
        toggleExpand={toggleExpand}
      />
    </div>
  );
}

export function FileStreamTable({
  files,
  selectedPath,
  onSelect,
  onDelete,
  onReanalyze,
  filter,
  setFilter,
  search,
}: {
  files: FileItem[];
  selectedPath: string | null;
  onSelect: (f: FileItem) => void;
  onDelete: (f: FileItem) => void;
  onReanalyze: (f: FileItem) => void;
  filter: string;
  setFilter: (s: string) => void;
  search: string;
}) {
  const filtered = files.filter((f) => {
    if (filter === "vuln") return f.status === "issues" || f.status === "error";
    if (filter !== "all") return f.status === filter;
    return true;
  }).filter((f) => f.path.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="bg-[#0f1613] border border-[#1a2e25] rounded overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#1a2e25]">
        <div className="flex items-center gap-2">
          <span className="text-[#00ff88]">🗂</span>
          <span className="text-[11px] tracking-[0.15em] text-white font-mono">DESKTOP FILE STREAM</span>
        </div>
        <div className="flex items-center gap-1 bg-[#050a09] rounded p-0.5 border border-[#1a2e25]">
          <button
            onClick={() => setFilter("all")}
            className={`text-[10px] px-2.5 py-1 rounded font-mono tracking-wide ${filter === "all" ? "bg-[#1a2e25] text-white" : "text-[#6b8a7a]"}`}
          >
            ALL ({files.length})
          </button>
          <button
            onClick={() => setFilter("vuln")}
            className={`text-[10px] px-2 py-1 rounded font-mono tracking-wide ${filter === "vuln" ? "bg-[#2e1a1e] text-[#ff3b5c]" : "text-[#6b8a7a]"}`}
          >
            Vuln
          </button>
        </div>
      </div>

      <div className="grid grid-cols-[1fr_100px_100px_80px] text-[10px] tracking-widest text-[#4a6a5a] font-mono px-4 py-2 bg-[#0a1210] border-b border-[#1a2e25]">
        <span>SCRIPT FILENAME</span>
        <span>STATUS</span>
        <span>AUDIT RESULT</span>
        <span className="text-right">ACTIONS</span>
      </div>

      <div className="max-h-[180px] overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="px-4 py-8 text-center text-[11px] text-[#4a6a5a] font-mono">No files match filter</div>
        ) : (
          filtered.map((f) => (
            <div
              key={f.id}
              className={`grid grid-cols-[1fr_100px_100px_80px] items-center px-4 py-2.5 text-xs font-mono border-b border-[#1a2e25]/50 hover:bg-[#1a2e25]/30 cursor-pointer transition-colors ${
                selectedPath === f.path ? "bg-[#00ff88]/5 border-l-2 border-l-[#00ff88]" : ""
              }`}
              onClick={() => onSelect(f)}
            >
              <div className="flex items-center gap-2 truncate">
                <span className="text-[#00ff88]/70">📄</span>
                <span className="truncate text-[#d6ffe8]">{f.path}</span>
              </div>
              <div>
                {f.status === "pending" ? (
                  <span className="text-[#ffcc33] text-[10px]">● Pending</span>
                ) : f.status === "analyzing" ? (
                  <span className="text-[#00d4ff] text-[10px] animate-pulse">● Analyzing</span>
                ) : f.status === "issues" ? (
                  <span className="text-[#ff3b5c] text-[10px]">● Issues</span>
                ) : f.status === "clean" ? (
                  <span className="text-[#00ff88] text-[10px]">● Clean</span>
                ) : f.status === "error" ? (
                  <span className="text-[#ff3b5c] text-[10px]">● Error</span>
                ) : (
                  <StatusBadge status="synced" />
                )}
              </div>
              <div className="text-[#6b8a7a] text-[10px]">{f.issuesCount ? `${f.issuesCount} issues` : f.status === "clean" ? "Clean" : "-"}</div>
              <div className="flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => onReanalyze(f)} className="text-[#6b8a7a] hover:text-[#00ff88] text-[11px]">↻</button>
                <button onClick={() => onDelete(f)} className="text-[#6b8a7a] hover:text-[#ff3b5c] text-[11px]">🗑</button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
