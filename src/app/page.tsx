"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { CodeViewport, type FocusRequest } from "@/components/CodeViewport";
import { IssueTracker, type IssueScope } from "@/components/IssueTracker";
import { MetricCards } from "@/components/MetricCards";
import { RepositoryExplorer } from "@/components/RepositoryExplorer";
import { WorkspaceBar } from "@/components/WorkspaceBar";
import { Icon, Spinner } from "@/components/ui";
import { api, ApiClientError, streamBatch, swrFetcher } from "@/lib/api-client";
import type {
  AnalysisResultDto,
  CommitResultDto,
  FileDetailDto,
  FileSummaryDto,
  IssueDto,
  ManifestResultDto,
  StatsDto,
  SyncResultDto,
  SystemDto,
  WorkspaceDto,
} from "@/lib/contracts";
import {
  batchBySize,
  browserFsSupported,
  deleteFileViaHandle,
  forgetHandle,
  loadHandle,
  pickDirectory,
  saveHandle,
  walkDirectoryHandle,
  writeFileViaHandle,
} from "@/lib/fs-browser";
import { cn, formatInt, formatMs } from "@/lib/utils";

interface Activity {
  label: string;
  done: number;
  total: number | null;
  detail?: string;
}

interface Notice {
  tone: "error" | "info";
  text: string;
  code?: string;
}

const WS_KEY = "aetherops.workspace";

function readStoredWorkspace(): number | null {
  try {
    const v = Number(window.localStorage.getItem(WS_KEY));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function describeError(err: unknown): Notice {
  if (err instanceof ApiClientError) return { tone: "error", text: err.message, code: err.code };
  if (err instanceof DOMException && err.name === "AbortError") return { tone: "info", text: "Cancelled." };
  return { tone: "error", text: err instanceof Error ? err.message : String(err) };
}

export default function CommandCenter() {
  const [chosenWs, setChosenWs] = useState<number | null>(() => (typeof window === "undefined" ? null : readStoredWorkspace()));
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [activeIssueId, setActiveIssueId] = useState<number | null>(null);
  const [issueScope, setIssueScope] = useState<IssueScope>("file");
  const [activity, setActivity] = useState<Activity | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [analyzingId, setAnalyzingId] = useState<number | null>(null);
  const [committing, setCommitting] = useState(false);
  const [overlay, setOverlay] = useState<"explorer" | "issues" | null>(null);
  const [browserSupported] = useState(() => typeof window !== "undefined" && browserFsSupported());
  const handles = useRef(new Map<number, FileSystemDirectoryHandle>());
  const autoAnalyzed = useRef(new Set<string>());

  // ------------------------------------------------------------------ data
  const { data: system, mutate: mutateSystem } = useSWR<SystemDto>("/api/system", swrFetcher, { refreshInterval: 15_000 });
  const ready = system?.db.migrated === true;
  const { data: workspaces, mutate: mutateWorkspaces } = useSWR<WorkspaceDto[]>(ready ? "/api/workspaces" : null, swrFetcher);
  const active = useMemo(() => workspaces?.find((w) => w.id === chosenWs) ?? workspaces?.[0], [workspaces, chosenWs]);
  const wsId = active?.id ?? null;
  const busy = activity !== null;

  const { data: files, isLoading: filesLoading, mutate: mutateFiles } = useSWR<FileSummaryDto[]>(wsId ? `/api/files?workspaceId=${wsId}` : null, swrFetcher, {
    refreshInterval: (data) => (busy || data?.some((f) => f.status === "analyzing") ? 1500 : 10_000),
    keepPreviousData: true,
  });
  const { data: stats, isLoading: statsLoading, mutate: mutateStats } = useSWR<StatsDto>(wsId ? `/api/stats?workspaceId=${wsId}` : null, swrFetcher, {
    refreshInterval: busy ? 2000 : 10_000,
    keepPreviousData: true,
  });
  const { data: detail, isLoading: detailLoading, mutate: mutateDetail } = useSWR<FileDetailDto>(selectedId ? `/api/files/${selectedId}` : null, swrFetcher, {
    refreshInterval: (d) => (d?.status === "analyzing" ? 1500 : 0),
  });
  const { data: wsIssues, isLoading: wsIssuesLoading, mutate: mutateWsIssues } = useSWR<IssueDto[]>(
    wsId && issueScope === "workspace" ? `/api/issues?workspaceId=${wsId}&status=all&limit=1000` : null,
    swrFetcher
  );

  const refreshAll = useCallback(async () => {
    await Promise.all([mutateFiles(), mutateStats(), mutateWorkspaces(), issueScope === "workspace" ? mutateWsIssues() : undefined]);
  }, [mutateFiles, mutateStats, mutateWorkspaces, mutateWsIssues, issueScope]);

  const selectWorkspace = (id: number) => {
    setChosenWs(id);
    setSelectedId(null);
    setFocus(null);
    try {
      window.localStorage.setItem(WS_KEY, String(id));
    } catch {
      // storage unavailable (private mode): selection simply is not remembered
    }
  };

  // ------------------------------------------------------------------ handles (browser mode)
  const getHandle = useCallback(async (ws: WorkspaceDto): Promise<FileSystemDirectoryHandle> => {
    const cached = handles.current.get(ws.id) ?? (await loadHandle(ws.id));
    if (!cached) throw new Error(`The browser no longer holds a handle for "${ws.name}". Use Link workspace → Choose folder to reconnect it.`);
    handles.current.set(ws.id, cached);
    return cached;
  }, []);

  // ------------------------------------------------------------------ sync
  const syncWorkspace = useCallback(
    async (ws: WorkspaceDto) => {
      setNotice(null);
      try {
        if (ws.kind === "server") {
          setActivity({ label: "Syncing", done: 0, total: null, detail: ws.rootPath });
          const r = await api<SyncResultDto>(`/api/workspaces/${ws.id}/sync`, { method: "POST", json: {}, timeoutMs: 300_000 });
          setNotice({
            tone: "info",
            text: `Synced ${formatInt(r.added + r.updated + r.unchanged)} files in ${formatMs(r.durationMs)}: +${r.added} new, ${r.updated} changed, ${r.removed} removed, ${r.unchanged} unchanged · ${r.findings} deterministic findings${r.truncated ? " · file limit reached" : ""}`,
          });
        } else {
          const handle = await getHandle(ws);
          setActivity({ label: "Reading", done: 0, total: null, detail: handle.name });
          const walk = await walkDirectoryHandle(handle, (p) => setActivity({ label: "Reading", done: p.discovered, total: null, detail: p.currentPath }));
          const manifest = await api<ManifestResultDto>(`/api/workspaces/${ws.id}/sync`, {
            method: "POST",
            json: { entries: walk.files.map((f) => ({ path: f.path, hash: f.hash })) },
            timeoutMs: 120_000,
          });
          const needed = new Set(manifest.needed);
          const batches = batchBySize(walk.files.filter((f) => needed.has(f.path)));
          let uploaded = 0;
          for (const batch of batches) {
            setActivity({ label: "Uploading", done: uploaded, total: needed.size, detail: batch[0]?.path });
            await api(`/api/files`, { method: "POST", json: { workspaceId: ws.id, files: batch.map((f) => ({ path: f.path, content: f.content, hash: f.hash })) }, timeoutMs: 120_000 });
            uploaded += batch.length;
          }
          setNotice({ tone: "info", text: `Synced ${formatInt(walk.files.length)} files: ${needed.size} uploaded, ${manifest.unchanged} unchanged, ${manifest.removed} removed, ${walk.skipped} skipped by policy` });
        }
      } catch (err) {
        setNotice(describeError(err));
      } finally {
        setActivity(null);
        await refreshAll();
      }
    },
    [getHandle, refreshAll]
  );

  const linkServer = async (rootPath: string): Promise<boolean> => {
    try {
      const ws = await api<WorkspaceDto>("/api/workspaces", { method: "POST", json: { kind: "server", rootPath } });
      await mutateWorkspaces();
      selectWorkspace(ws.id);
      await syncWorkspace(ws);
      return true;
    } catch (err) {
      setNotice(describeError(err));
      return false;
    }
  };

  const linkBrowser = async () => {
    try {
      const handle = await pickDirectory();
      const ws = await api<WorkspaceDto>("/api/workspaces", { method: "POST", json: { kind: "browser", name: handle.name } });
      handles.current.set(ws.id, handle);
      await saveHandle(ws.id, handle);
      await mutateWorkspaces();
      selectWorkspace(ws.id);
      await syncWorkspace(ws);
    } catch (err) {
      setNotice(describeError(err));
    }
  };

  const unlink = async () => {
    if (!active || !window.confirm(`Unlink "${active.name}"? Stored analysis is removed; files on disk are not touched.`)) return;
    try {
      await api(`/api/workspaces/${active.id}`, { method: "DELETE" });
      await forgetHandle(active.id);
      handles.current.delete(active.id);
      setSelectedId(null);
      setChosenWs(null);
      await mutateWorkspaces();
    } catch (err) {
      setNotice(describeError(err));
    }
  };

  // ------------------------------------------------------------------ analysis
  const analyze = useCallback(
    async (fileId: number) => {
      setAnalyzingId(fileId);
      try {
        const res = await api<AnalysisResultDto>("/api/analyze", { method: "POST", json: { fileId, engine: "hybrid" }, timeoutMs: 300_000 });
        if (fileId === selectedId) await mutateDetail(res.file, { revalidate: false });
        if (res.aiError) setNotice({ tone: "error", text: res.aiError, code: "AI_DEGRADED" });
      } catch (err) {
        if (!(err instanceof ApiClientError && err.code === "ANALYSIS_IN_PROGRESS")) setNotice(describeError(err));
      } finally {
        setAnalyzingId(null);
        await Promise.all([mutateFiles(), mutateStats(), fileId === selectedId ? mutateDetail() : undefined]);
      }
    },
    [selectedId, mutateDetail, mutateFiles, mutateStats]
  );

  // Selecting a file whose current content has not been AI-verified triggers one deep analysis.
  const aiConfigured = system?.ai.configured ?? false;
  useEffect(() => {
    if (!detail || !aiConfigured || detail.engine === "hybrid" || detail.status === "analyzing") return;
    const key = `${detail.id}:${detail.contentHash}`;
    if (autoAnalyzed.current.has(key)) return;
    autoAnalyzed.current.add(key);
    queueMicrotask(() => void analyze(detail.id));
  }, [detail, aiConfigured, analyze]);

  const runScan = async (engine: "heuristic" | "hybrid") => {
    if (!active) return;
    if (engine === "hybrid" && !window.confirm("Deep scan sends every file that is not yet AI-verified to the configured AI provider. Continue?")) return;
    setNotice(null);
    setActivity({ label: engine === "hybrid" ? "Deep scan" : "Scan", done: 0, total: null });
    try {
      await streamBatch({ workspaceId: active.id, scope: "changed", engine }, (e) => {
        if (e.type === "start") setActivity({ label: engine === "hybrid" ? "Deep scan" : "Scan", done: 0, total: e.total, detail: `${e.skipped} up to date` });
        else if (e.type === "file") setActivity((a) => ({ label: a?.label ?? "Scan", done: (a?.done ?? 0) + 1, total: e.total, detail: e.path }));
        else if (e.type === "done")
          setNotice({
            tone: e.scan.status === "completed" ? "info" : "error",
            text: `${e.scan.kind} scan ${e.scan.status}: ${e.scan.filesScanned}/${e.scan.filesTotal} files, ${e.scan.issuesFound} open issues, ${formatMs(e.scan.durationMs)}${e.scan.error ? ` · first error: ${e.scan.error}` : ""}`,
          });
        else if (e.type === "error") setNotice({ tone: "error", text: e.error.message, code: e.error.code });
      });
    } catch (err) {
      setNotice(describeError(err));
    } finally {
      setActivity(null);
      await refreshAll();
      if (selectedId) await mutateDetail();
    }
  };

  // ------------------------------------------------------------------ commit & delete
  const commit = async ({ git }: { git: boolean }) => {
    if (!detail?.correctedContent || !active) return;
    setCommitting(true);
    setNotice(null);
    try {
      let writtenHash: string | undefined;
      if (active.kind === "browser") {
        writtenHash = await writeFileViaHandle(await getHandle(active), detail.path, detail.correctedContent, detail.contentHash);
      }
      const res = await api<CommitResultDto>("/api/commit", { method: "POST", json: { fileId: detail.id, baseHash: detail.contentHash, writtenHash, git }, timeoutMs: 90_000 });
      await mutateDetail(res.file, { revalidate: false });
      setNotice({
        tone: res.gitError ? "error" : "info",
        text: `Patch written to ${detail.path} (sha256 ${res.newHash.slice(0, 10)}) · ${res.issuesFixed} issue(s) marked fixed${res.gitSha ? ` · git ${res.gitSha.slice(0, 8)}` : ""}${res.gitError ? ` · git commit failed: ${res.gitError}` : ""}`,
      });
    } catch (err) {
      setNotice(describeError(err));
    } finally {
      setCommitting(false);
      await refreshAll();
    }
  };

  const deleteFile = async (file: FileSummaryDto) => {
    if (!active || !window.confirm(`Delete ${file.path} from disk and from the index? This cannot be undone.`)) return;
    try {
      if (active.kind === "browser") await deleteFileViaHandle(await getHandle(active), file.path);
      await api(`/api/files/${file.id}?disk=1`, { method: "DELETE" });
      if (selectedId === file.id) setSelectedId(null);
    } catch (err) {
      setNotice(describeError(err));
    } finally {
      await refreshAll();
    }
  };

  // ------------------------------------------------------------------ navigation
  const selectFile = (id: number) => {
    setSelectedId(id);
    setFocus(null);
    setActiveIssueId(null);
    setOverlay(null);
  };

  const jumpToIssue = (issue: IssueDto) => {
    if (issue.fileId !== selectedId) setSelectedId(issue.fileId);
    setActiveIssueId((cur) => (cur === issue.id ? null : issue.id));
    setFocus({ line: issue.line, nonce: Date.now() });
    setOverlay(null);
  };

  // ------------------------------------------------------------------ render
  const setupMessage = !system
    ? null
    : !system.db.configured
      ? "DATABASE_URL is not set. Add a postgres:// URL (or pglite:./.data/pglite for the embedded local database) to .env and restart."
      : !system.db.connected
        ? `Database unreachable: ${system.db.error ?? "unknown error"}`
        : !system.db.migrated
          ? "Database schema is not migrated. Run `npm run db:migrate`, then reload."
          : null;

  const progressPct = activity?.total ? Math.min(100, (activity.done / Math.max(1, activity.total)) * 100) : null;

  return (
    <div className="grid h-dvh grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_auto_minmax(0,1fr)_24px] overflow-hidden bg-canvas">
      <WorkspaceBar
        system={system}
        workspaces={workspaces}
        active={active}
        busy={busy}
        browserSupported={browserSupported}
        onSelect={selectWorkspace}
        onLinkServer={linkServer}
        onLinkBrowser={linkBrowser}
        onSync={() => active && syncWorkspace(active)}
        onScan={runScan}
        onUnlink={unlink}
        onTogglePane={(p) => setOverlay((o) => (o === p ? null : p))}
      />

      <MetricCards stats={stats} system={system} loading={statsLoading} />

      <div>
        {activity && (
          <div className="relative h-[2px] overflow-hidden bg-line">
            {progressPct === null ? <div className="progress-indeterminate absolute inset-0" /> : <div className="h-full bg-accent transition-[width]" style={{ width: `${progressPct}%` }} />}
          </div>
        )}
        {(setupMessage || notice) && (
          <div
            role={setupMessage || notice?.tone === "error" ? "alert" : "status"}
            className={cn(
              "flex items-start gap-2 border-b border-line px-3 py-1.5 text-[12px]",
              setupMessage || notice?.tone === "error" ? "bg-sev-critical/[0.07] text-[#f4a3a6]" : "bg-accent/[0.06] text-fg-muted"
            )}
          >
            <Icon name={setupMessage || notice?.tone === "error" ? "alert" : "database"} size={13} className="mt-0.5" />
            <span className="min-w-0 flex-1">
              {(notice?.code || setupMessage) && <span className="mr-2 font-mono text-[10.5px] opacity-80">{setupMessage ? "SETUP" : notice?.code}</span>}
              {setupMessage ?? notice?.text}
            </span>
            {!setupMessage && (
              <button type="button" onClick={() => setNotice(null)} className="text-current opacity-70 hover:opacity-100" aria-label="Dismiss">
                <Icon name="close" size={12} />
              </button>
            )}
            {setupMessage && (
              <button type="button" onClick={() => mutateSystem()} className="font-mono text-[11px] underline-offset-2 hover:underline">
                recheck
              </button>
            )}
          </div>
        )}
      </div>

      <main className="relative grid min-h-0 grid-cols-1 divide-x divide-line md:grid-cols-[248px_minmax(0,1fr)] xl:grid-cols-[272px_minmax(0,1fr)_384px]">
        <div
          className={cn(
            "min-h-0 md:static md:flex md:flex-col",
            overlay === "explorer" ? "absolute inset-y-0 left-0 z-30 flex w-[min(320px,85vw)] flex-col border-r border-line shadow-2xl" : "hidden"
          )}
        >
          <RepositoryExplorer files={files} loading={filesLoading} selectedId={selectedId} onSelect={selectFile} onAnalyze={analyze} onDelete={deleteFile} />
        </div>

        <CodeViewport
          file={detail}
          loading={detailLoading}
          focus={focus}
          aiConfigured={aiConfigured}
          canGitCommit={active?.kind === "server" && active.isGitRepo}
          analyzing={analyzingId !== null && analyzingId === selectedId}
          committing={committing}
          onAnalyze={() => selectedId && analyze(selectedId)}
          onCommit={commit}
        />

        <div
          className={cn(
            "min-h-0 xl:static xl:flex xl:flex-col",
            overlay === "issues" ? "absolute inset-y-0 right-0 z-30 flex w-[min(400px,92vw)] flex-col border-l border-line shadow-2xl" : "hidden"
          )}
        >
          <IssueTracker
            scope={issueScope}
            onScopeChange={setIssueScope}
            fileIssues={detail?.issues ?? []}
            workspaceIssues={wsIssues}
            loading={issueScope === "file" ? detailLoading : wsIssuesLoading}
            activeIssueId={activeIssueId}
            onJump={jumpToIssue}
            scans={stats?.recentScans ?? []}
            hasFile={selectedId !== null}
          />
        </div>
      </main>

      <footer className="flex items-center gap-4 border-t border-line bg-surface px-3 font-mono text-[10.5px] text-fg-subtle">
        {activity ? (
          <span className="flex min-w-0 items-center gap-2 text-fg-muted">
            <Spinner className="size-2.5" />
            <span className="shrink-0">
              {activity.label} {activity.total !== null ? `${formatInt(activity.done)}/${formatInt(activity.total)}` : formatInt(activity.done) || ""}
            </span>
            {activity.detail && <span className="truncate text-fg-subtle">{activity.detail}</span>}
          </span>
        ) : (
          <span>{active ? `${active.kind} workspace · ${formatInt(files?.length ?? 0)} files indexed` : "no workspace linked"}</span>
        )}
        <span className="ml-auto hidden shrink-0 sm:inline">
          {stats ? `${formatInt(stats.openIssues.total)} open · ${formatInt(stats.fixedIssues)} fixed` : ""}
        </span>
        {detail && (
          <span className="hidden shrink-0 md:inline">
            {detail.language} · {detail.eol.toUpperCase()} · UTF-8
          </span>
        )}
      </footer>
    </div>
  );
}
