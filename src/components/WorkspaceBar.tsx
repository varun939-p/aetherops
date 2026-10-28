"use client";

import { useEffect, useRef, useState } from "react";
import type { SystemDto, WorkspaceDto } from "@/lib/contracts";
import { useTheme } from "@/lib/use-preferences";
import { relativeTime } from "@/lib/utils";
import { Button, Icon, IconButton } from "./ui";

const KIND_LABEL: Record<Exclude<WorkspaceDto["kind"], "demo">, string> = {
  server: "local folder",
  browser: "browser folder",
};

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
  onResetDemo,
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
  onResetDemo: () => void;
  onScan: (engine: "heuristic" | "hybrid") => void;
  onUnlink: () => void;
  onTogglePane: (pane: "explorer" | "issues") => void;
}) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState("");
  const popRef = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useTheme();
  const ready = system?.db.migrated ?? false;
  const serverMode = system?.fs.serverMode ?? false;
  const isDemo = active?.kind === "demo";

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

  const workspaceTitle = active
    ? `${active.kind === "server" ? active.rootPath : active.kind === "browser" ? `Browser folder: ${active.name}` : "Built-in sample files"}${active.isGitRepo ? ` · git ${active.gitBranch ?? ""}` : ""}${active.kind !== "demo" ? ` · last synced ${relativeTime(active.lastSyncedAt)}` : ""}`
    : undefined;

  return (
    <header className="flex h-14 min-w-0 shrink-0 items-center gap-3 border-b border-line bg-canvas px-4">
      <IconButton icon="sidebar" label="Show files" className="md:hidden" onClick={() => onTogglePane("explorer")} />
      <div className="flex shrink-0 items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-md bg-fg text-[13px] font-bold text-canvas">A</span>
        <span className="hidden text-[15px] font-semibold tracking-tight text-fg sm:inline">AetherOps</span>
      </div>
      <span className="h-6 w-px shrink-0 bg-line" />

      <label className="flex min-w-0 items-center gap-2" title={workspaceTitle}>
        <span className="hidden shrink-0 text-[12.5px] text-fg-subtle lg:inline">Project</span>
        <span className="relative min-w-0">
          <select
            value={active?.id ?? ""}
            onChange={(e) => onSelect(Number(e.target.value))}
            disabled={!workspaces?.length}
            className="h-8 w-full min-w-[150px] max-w-[260px] appearance-none truncate rounded-md border border-line-strong bg-raised pl-3 pr-8 text-[13px] font-medium text-fg outline-none focus:border-accent disabled:text-fg-subtle"
            aria-label="Project"
          >
            {!workspaces?.length && <option value="">No project</option>}
            {workspaces?.map((w) => (
              <option key={w.id} value={w.id}>
                {w.kind === "demo" ? w.name : `${w.name} (${KIND_LABEL[w.kind]})`}
              </option>
            ))}
          </select>
          <Icon name="chevronDown" size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-subtle" />
        </span>
      </label>
      {isDemo && <span className="hidden shrink-0 rounded-full bg-accent-soft px-2.5 py-0.5 text-[12px] font-medium text-accent 2xl:inline">Sample project · try it freely</span>}

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <div className="relative" ref={popRef}>
          <Button size="sm" icon="folder" disabled={!ready} onClick={() => setOpen((o) => !o)} title="Analyze your own code">
            <span className="hidden lg:inline">Open folder</span>
          </Button>
          {open && (
            <div className="absolute right-0 top-10 z-50 w-[min(440px,calc(100vw-24px))] rounded-lg border border-line bg-raised p-4 shadow-[var(--shadow-pop)]">
              <div className="text-[14px] font-semibold text-fg">Analyze your own code</div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-fg-subtle">Point AetherOps at a project folder. Files are scanned instantly; nothing is changed until you apply a fix.</p>

              <div className="mt-4 text-[12.5px] font-medium text-fg">Folder on this computer</div>
              {serverMode ? (
                <form
                  className="mt-1.5 flex gap-2"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (path.trim() && (await onLinkServer(path.trim()))) setOpen(false);
                  }}
                >
                  <input
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    placeholder={system?.fs.allowedRoots[0] ?? "C:\\path\\to\\project"}
                    spellCheck={false}
                    className="h-8 min-w-0 flex-1 rounded-md border border-line-strong bg-canvas px-2.5 font-mono text-[12.5px] text-fg outline-none placeholder:text-fg-faint focus:border-accent"
                  />
                  <Button size="sm" variant="primary" type="submit" disabled={!path.trim() || busy}>
                    Open
                  </Button>
                </form>
              ) : (
                <p className="mt-1 text-[12.5px] leading-relaxed text-fg-subtle">Not available on this deployment. Use a browser folder below, or run AetherOps locally.</p>
              )}
              {serverMode && <p className="mt-1.5 text-[12px] leading-relaxed text-fg-subtle">Must be inside: {system?.fs.allowedRoots.join(", ")}. Supports git commits.</p>}

              <div className="mt-4 text-[12.5px] font-medium text-fg">Folder via your browser</div>
              <div className="mt-1.5 flex items-center gap-2">
                <Button size="sm" icon="folder" disabled={!browserSupported || busy} onClick={() => (setOpen(false), onLinkBrowser())}>
                  Choose folder…
                </Button>
                <span className="text-[12px] text-fg-subtle">{browserSupported ? "Chrome or Edge will ask for permission." : "Requires Chrome or Edge."}</span>
              </div>
            </div>
          )}
        </div>

        {isDemo ? (
          <Button size="sm" icon="rotate" disabled={!active || busy} onClick={onResetDemo} title="Restore the sample files to their original, unfixed state">
            <span className="hidden xl:inline">Reset sample</span>
          </Button>
        ) : (
          <Button size="sm" icon="refresh" disabled={!active || busy} onClick={onSync} title="Re-read the folder; only changed files are processed">
            <span className="hidden xl:inline">Sync</span>
          </Button>
        )}
        <Button size="sm" icon="play" disabled={!active || busy} onClick={() => onScan("heuristic")} title="Run the built-in rules on files that changed (instant, offline)">
          <span className="hidden xl:inline">Quick scan</span>
        </Button>
        {system?.ai.configured && (
          <Button size="sm" variant="primary" icon="sparkle" disabled={!active || busy} onClick={() => onScan("hybrid")} title="AI review of every file not yet checked by AI; generates fixes">
            <span className="hidden xl:inline">AI review</span>
          </Button>
        )}
        <span className="mx-0.5 h-6 w-px bg-line" />
        <IconButton icon={theme === "dark" ? "sun" : "moon"} label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")} />
        {active && !isDemo && <IconButton icon="close" label="Remove project from AetherOps (files on disk are kept)" disabled={busy} onClick={onUnlink} />}
        <IconButton icon="alert" label="Show issues" className="xl:hidden" onClick={() => onTogglePane("issues")} />
      </div>
    </header>
  );
}
