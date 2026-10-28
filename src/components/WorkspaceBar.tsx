"use client";

import { useEffect, useRef, useState } from "react";
import type { SystemDto, WorkspaceDto } from "@/lib/contracts";
import { cn, relativeTime } from "@/lib/utils";
import { Button, Icon } from "./ui";

export function WorkspaceBar({
  system,
  workspaces,
  active,
  busy,
  browserSupported,
  onSelect,
  onLinkServer,
  onLinkBrowser,
  onSync,
  onScan,
  onUnlink,
  onTogglePane,
}: {
  system: SystemDto | undefined;
  workspaces: WorkspaceDto[] | undefined;
  active: WorkspaceDto | undefined;
  busy: boolean;
  browserSupported: boolean;
  onSelect: (id: number) => void;
  onLinkServer: (path: string) => Promise<boolean>;
  onLinkBrowser: () => void;
  onSync: () => void;
  onScan: (engine: "heuristic" | "hybrid") => void;
  onUnlink: () => void;
  onTogglePane: (pane: "explorer" | "issues") => void;
}) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const popRef = useRef<HTMLDivElement>(null);
  const ready = system?.db.migrated ?? false;
  const serverMode = system?.fs.serverMode ?? false;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <header className="flex h-10 min-w-0 shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
      <button type="button" className="text-fg-subtle hover:text-fg md:hidden" onClick={() => onTogglePane("explorer")} aria-label="Toggle explorer">
        <Icon name="sidebar" />
      </button>
      <span className="text-[13px] font-semibold tracking-tight text-fg">AetherOps</span>
      <span className="h-4 w-px bg-line-strong" />

      <select
        value={active?.id ?? ""}
        onChange={(e) => onSelect(Number(e.target.value))}
        disabled={!workspaces?.length}
        className="h-7 max-w-[220px] min-w-0 rounded-[3px] border border-line-strong bg-canvas px-2 font-mono text-[11.5px] text-fg outline-none focus:border-accent disabled:text-fg-subtle"
        aria-label="Workspace"
      >
        {!workspaces?.length && <option value="">no workspace</option>}
        {workspaces?.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name} · {w.kind}
          </option>
        ))}
      </select>

      {active && (
        <div className="hidden min-w-0 items-center gap-3 font-mono text-[10.5px] text-fg-subtle lg:flex">
          <span className="truncate" title={active.rootPath}>
            {active.kind === "server" ? active.rootPath : `browser:${active.name}`}
          </span>
          {active.isGitRepo && <span className="shrink-0 text-fg-muted">git:{active.gitBranch ?? "detached"}</span>}
          <span className="shrink-0">synced {relativeTime(active.lastSyncedAt)}</span>
        </div>
      )}

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <div className="relative" ref={popRef}>
          <Button size="xs" variant={workspaces?.length ? "secondary" : "primary"} icon="link" disabled={!ready} onClick={() => setOpen((o) => !o)}>
            <span className="hidden sm:inline">Link workspace</span>
          </Button>
          {open && (
            <div className="absolute right-0 top-8 z-50 w-[min(420px,calc(100vw-24px))] rounded-[4px] border border-line-strong bg-raised p-3 shadow-[0_12px_32px_rgb(0_0_0/0.5)]">
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-muted">Local path (server mode)</div>
              {serverMode ? (
                <form
                  className="flex gap-1.5"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (path.trim() && (await onLinkServer(path.trim()))) setOpen(false);
                  }}
                >
                  <input
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    placeholder={system?.fs.allowedRoots[0] ?? "/absolute/path/to/repo"}
                    spellCheck={false}
                    className="h-7 min-w-0 flex-1 rounded-[3px] border border-line-strong bg-canvas px-2 font-mono text-[11.5px] text-fg outline-none placeholder:text-fg-faint focus:border-accent"
                  />
                  <Button size="sm" variant="primary" type="submit" disabled={!path.trim() || busy}>
                    Link
                  </Button>
                </form>
              ) : (
                <p className="text-[11.5px] leading-relaxed text-fg-subtle">{system?.fs.reason}</p>
              )}
              {serverMode && (
                <p className="mt-1.5 font-mono text-[10.5px] leading-relaxed text-fg-subtle">
                  allowed: {system?.fs.allowedRoots.join(", ")}
                  <br />
                  git commits, .gitignore and atomic disk writes are handled by the server.
                </p>
              )}
              <div className="my-3 h-px bg-line" />
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-muted">Browser folder (fallback)</div>
              <div className="flex items-center gap-2">
                <Button size="sm" icon="folder" disabled={!browserSupported || busy} onClick={() => (setOpen(false), onLinkBrowser())}>
                  Choose folder…
                </Button>
                <span className="text-[11px] text-fg-subtle">{browserSupported ? "Reads/writes via the File System Access API; no git." : "Requires Chrome or Edge."}</span>
              </div>
            </div>
          )}
        </div>
        <Button size="xs" icon="refresh" disabled={!active || busy} onClick={onSync} title="Delta-sync the workspace from disk (SHA-256)">
          <span className="hidden lg:inline">Sync</span>
        </Button>
        <Button size="xs" icon="play" disabled={!active || busy} onClick={() => onScan("heuristic")} title="Deterministic scan of changed files">
          <span className="hidden lg:inline">Scan</span>
        </Button>
        {system?.ai.configured && (
          <Button size="xs" icon="code" disabled={!active || busy} onClick={() => onScan("hybrid")} title="AI + heuristic analysis of every file not yet AI-verified">
            <span className="hidden lg:inline">Deep scan</span>
          </Button>
        )}
        <button type="button" disabled={!active || busy} onClick={onUnlink} title="Unlink workspace (keeps files on disk)" className={cn("rounded-[3px] p-1.5 text-fg-subtle hover:bg-hover hover:text-sev-critical disabled:opacity-40")}>
          <Icon name="close" size={13} />
        </button>
        <button type="button" className="rounded-[3px] p-1.5 text-fg-subtle hover:bg-hover hover:text-fg xl:hidden" onClick={() => onTogglePane("issues")} aria-label="Toggle issues">
          <Icon name="alert" size={13} />
        </button>
      </div>
    </header>
  );
}
