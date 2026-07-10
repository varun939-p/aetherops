"use client";

import { useState, useEffect, useTransition, useMemo } from "react";
import useSWR from "swr";
import { MetricCards } from "@/components/MetricCards";
import { RepositoryExplorer, FileStreamTable, FileItem as ExplorerFileItem } from "@/components/RepositoryExplorer";
import { CodeViewport } from "@/components/CodeViewport";
import { IssueTracker } from "@/components/IssueTracker";
import { Button } from "@/components/ui";
import { linkFolderAndRead, commitFix, deleteFileFromDisk, chunkFiles } from "@/lib/fs-desktop";

const fetcher = (url: string) => fetch(url).then((r) => {
  if (!r.ok) throw new Error(`Fetch failed ${r.status}`);
  return r.json();
});

interface FileListItem extends ExplorerFileItem {
  content: string;
  correctedContent?: string | null;
  extension: string;
  qualityScore?: number | null;
  errorMessage?: string | null;
  criticalCount?: number;
  issuesCount?: number;
}

interface DetailedFile {
  id: number;
  path: string;
  content: string;
  correctedContent?: string | null;
  language: string;
  status: string;
  fileSize: number;
  lineCount: number;
  qualityScore?: number | null;
  errorMessage?: string | null;
  issues: Array<{ id: number; line: number; severity: string; message: string; source: string; ruleId?: string }>;
  history?: any[];
}

export default function Dashboard() {
  const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle | null>(null);
  const [selectedFileId, setSelectedFileId] = useState<number | null>(null);
  const [isPending, startTransition] = useTransition();
  const [linking, setLinking] = useState(false);
  const [linkProgress, setLinkProgress] = useState<{ scanned: number; currentPath: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [committing, setCommitting] = useState(false);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "active">("idle");
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const { data: filesData, error: filesError, isLoading: filesLoading, mutate: mutateFiles } = useSWR(
    "/api/files",
    fetcher,
    {
      refreshInterval: 5000,
      revalidateOnFocus: false,
      dedupingInterval: 2000,
    }
  );

  const { data: statsData, isLoading: statsLoading, mutate: mutateStats } = useSWR("/api/stats", fetcher, {
    refreshInterval: 5000,
    revalidateOnFocus: false,
  });

  const { data: detailedData, isLoading: detailedLoading, mutate: mutateDetailed } = useSWR(
    selectedFileId ? `/api/files?id=${selectedFileId}` : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  const files: FileListItem[] = filesData?.files || [];
  const detailedFile: DetailedFile | null = detailedData?.file || null;
  const selectedFile = useMemo(() => files.find((f) => f.id === selectedFileId) || null, [files, selectedFileId]);

  useEffect(() => {
    if (!detailedFile) return;
    if (detailedFile.status === "pending") {
      handleAnalyze(detailedFile.id, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailedFile?.id, detailedFile?.status]);

  const handleLinkFolder = async () => {
    setLinking(true);
    setSyncStatus("syncing");
    setErrorBanner(null);
    setLinkProgress({ scanned: 0, currentPath: "" });
    try {
      const { dirHandle: handle, files: localFiles } = await linkFolderAndRead((p) => {
        setLinkProgress({ scanned: p.scanned, currentPath: p.currentPath });
      });

      setDirHandle(handle);

      if (localFiles.length === 0) {
        setErrorBanner("Folder is empty or all files ignored (node_modules, .git etc are skipped).");
        setSyncStatus("idle");
        setLinking(false);
        return;
      }

      const chunks = chunkFiles(localFiles, 20);
      let totalSynced = 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        setLinkProgress({ scanned: totalSynced, currentPath: `Syncing batch ${i + 1}/${chunks.length} (${chunk.length} files)` });
        const res = await fetch("/api/files", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            files: chunk.map((f) => ({
              path: f.path,
              content: f.content,
              language: f.language,
              extension: f.extension,
              fileSize: f.size,
            })),
          }),
        });
        if (!res.ok) {
          const err = await res.text();
          throw new Error(`Sync batch ${i + 1} failed: ${err}`);
        }
        const json = await res.json();
        totalSynced += json.synced || chunk.length;
      }

      await mutateFiles();
      await mutateStats();
      setSyncStatus("active");
    } catch (e: any) {
      console.error(e);
      if (e?.message?.includes("File System Access API")) {
        setErrorBanner("Your browser doesn't support File System Access API. Use Chrome/Edge 86+.");
      } else if (e?.name === "AbortError") {
        setErrorBanner("Folder linking cancelled.");
        setSyncStatus("idle");
      } else {
        setErrorBanner(e?.message || "Failed to link folder");
        setSyncStatus("idle");
      }
    } finally {
      setLinking(false);
      setLinkProgress(null);
    }
  };

  const handleSelectFile = (f: { id: number; path: string }) => {
    startTransition(() => {
      setSelectedFileId(f.id);
    });
  };

  const handleAnalyze = async (fileId: number, _fastOnly = false) => {
    setReanalyzing(true);
    setErrorBanner(null);
    try {
      const r = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId, fastOnly: _fastOnly }),
      });
      const json = await r.json().catch(() => ({}));
      await mutateFiles();
      await mutateDetailed();
      await mutateStats();
      if (json?.error && json?.status === "error") {
        console.warn("Analyze returned error status", json.error);
      }
    } catch (e: any) {
      setErrorBanner(`Analyze failed: ${e?.message}`);
    } finally {
      setReanalyzing(false);
    }
  };

  const handleCommitFix = async () => {
    if (!detailedFile?.correctedContent) {
      setErrorBanner("No corrected code available to commit");
      return;
    }
    if (!dirHandle) {
      setErrorBanner("RECONNECT_FOLDER: No directory handle active. Please click 'Link Folder' again to reconnect your AetherOps_Watch folder. The FileSystemWritableFileStream direct-write requires an active handle (per §4.5).");
      return;
    }

    setCommitting(true);
    setErrorBanner(null);
    try {
      await commitFix(dirHandle, detailedFile.path, detailedFile.correctedContent);

      const res = await fetch("/api/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: detailedFile.id, newContent: detailedFile.correctedContent }),
      });
      if (!res.ok) throw new Error("DB commit update failed");

      await mutateFiles();
      await mutateDetailed();
      await mutateStats();

      await handleAnalyze(detailedFile.id, false);
    } catch (e: any) {
      if (e?.message?.includes("RECONNECT_FOLDER")) {
        setErrorBanner(e.message.replace("RECONNECT_FOLDER: ", ""));
      } else {
        setErrorBanner(`Commit failed: ${e?.message}`);
      }
    } finally {
      setCommitting(false);
    }
  };

  const handleDelete = async (f: ExplorerFileItem) => {
    const confirmed = confirm(`Delete ${f.path} from both disk and database? This cannot be undone.`);
    if (!confirmed) return;
    setErrorBanner(null);
    try {
      if (dirHandle) {
        try {
          await deleteFileFromDisk(dirHandle, f.path);
        } catch (e: any) {
          if (e?.message?.includes("RECONNECT_FOLDER")) {
            setErrorBanner("Cannot delete from disk: folder not linked. Will delete from DB only, please reconnect to delete from disk.");
          } else {
            console.warn("Disk delete failed, continuing with DB delete", e);
          }
        }
      }
      await fetch(`/api/files/${f.id}`, { method: "DELETE" });
      if (selectedFileId === f.id) setSelectedFileId(null);
      await mutateFiles();
      await mutateStats();
    } catch (e: any) {
      setErrorBanner(`Delete failed: ${e?.message}`);
    }
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-[#050a09] text-[#d6ffe8] overflow-hidden">
      <header className="h-14 flex items-center justify-between px-4 border-b border-[#1a2e25] bg-[#0a1210] shrink-0">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[#00ff88] animate-pulse-green inline-block" />
            <span className="text-sm font-bold tracking-widest font-mono">AETHEROPS</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#00ff88]/10 text-[#00ff88] border border-[#00ff88]/20 tracking-widest">SRE WATCHDOG ACTIVE</span>
          </div>
          <div className="hidden md:flex items-center gap-2 text-xs font-mono text-[#4a6a5a]">
            <span>Live File Sync</span>
            <span className="w-1 h-1 rounded-full bg-[#4a6a5a]" />
            <span>{files.length} files tracked</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative mr-2 hidden sm:block">
            <input
              placeholder="Search scripts..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-[#0f1613] border border-[#1a2e25] rounded px-3 py-1.5 text-xs font-mono w-48 focus:outline-none focus:border-[#00ff88]/30 placeholder-[#4a6a5a]"
            />
          </div>
          <Button variant={dirHandle ? "outline" : "primary"} size="md" onClick={handleLinkFolder} loading={linking}>
            {dirHandle ? "↻ Re-Link Folder" : "⧉ Link Folder"}
          </Button>
          <div className="w-px h-6 bg-[#1a2e25] mx-1" />
          <div className="w-7 h-7 rounded-full bg-[#1a2e25] flex items-center justify-center text-xs">V</div>
        </div>
      </header>

      {errorBanner && (
        <div className="bg-[#2e1a1a] border-b border-[#ff3b5c]/30 px-4 py-2 flex items-center justify-between shrink-0">
          <span className="text-xs font-mono text-[#ff8a8a]">{errorBanner}</span>
          <button onClick={() => setErrorBanner(null)} className="text-[#ff3b5c] text-xs">✕</button>
        </div>
      )}

      {linkProgress && (
        <div className="bg-[#0a1a12] border-b border-[#00ff88]/20 px-4 py-1.5 flex items-center gap-3 shrink-0">
          <span className="w-3 h-3 border border-[#00ff88] border-t-transparent rounded-full animate-spin inline-block" />
          <span className="text-[11px] font-mono text-[#00ff88]">Scanning: {linkProgress.scanned} files • {linkProgress.currentPath}</span>
        </div>
      )}

      <div className="p-3 shrink-0">
        <MetricCards stats={statsData} loading={statsLoading} isSyncActive={!!dirHandle && syncStatus === "active"} />
      </div>

      <div className="px-3 pb-3 shrink-0">
        <FileStreamTable
          files={files}
          selectedPath={selectedFile?.path || null}
          onSelect={(f) => handleSelectFile(f)}
          onDelete={handleDelete}
          onReanalyze={(f) => handleAnalyze(f.id)}
          filter={filter}
          setFilter={setFilter}
          search={searchQuery}
        />
      </div>

      <div className="flex-1 grid grid-cols-12 gap-3 px-3 pb-3 overflow-hidden min-h-0">
        <div className="col-span-12 md:col-span-3 lg:col-span-3 bg-[#0f1613] border border-[#1a2e25] rounded flex flex-col overflow-hidden min-h-0">
          <RepositoryExplorer
            files={files.filter((f) => f.path.toLowerCase().includes(searchQuery.toLowerCase()))}
            selectedPath={selectedFile?.path || null}
            onSelectFile={(f) => handleSelectFile(f)}
            loading={filesLoading}
          />
          {filesError && (
            <div className="p-3 m-2 bg-[#2e1a1a] border border-[#ff3b5c]/20 rounded">
              <div className="text-[11px] font-mono text-[#ff3b5c]">Failed to load files</div>
              <div className="text-[10px] font-mono text-[#ff8a8a] mt-1">{String(filesError)}</div>
              <Button variant="ghost" size="sm" onClick={() => mutateFiles()} className="mt-2">Retry</Button>
            </div>
          )}
          <div className="p-2 border-t border-[#1a2e25] shrink-0">
            <div className="text-[9px] font-mono text-[#4a6a5a] tracking-widest">
              AETHEROPS_WATCH • {dirHandle ? "Linked via File System Access API" : "Not linked - Link folder to enable direct writes"}
            </div>
          </div>
        </div>

        <div className="col-span-12 md:col-span-6 lg:col-span-6 bg-[#0a1210] border border-[#1a2e25] rounded flex flex-col overflow-hidden min-h-[400px] md:min-h-0">
          <CodeViewport
            file={detailedFile ? { ...detailedFile, issues: detailedFile.issues || [] } : null}
            loading={detailedLoading || isPending}
            onCommit={handleCommitFix}
            onReanalyze={() => selectedFileId && handleAnalyze(selectedFileId)}
            committing={committing}
            reanalyzing={reanalyzing}
          />
        </div>

        <div className="col-span-12 md:col-span-3 lg:col-span-3 bg-[#0f1613] border border-[#1a2e25] rounded flex flex-col overflow-hidden min-h-0">
          <IssueTracker
            issues={detailedFile?.issues || []}
            stats={statsData}
            loading={statsLoading || detailedLoading}
            selectedFilePath={selectedFile?.path || null}
            onIssueClick={(line) => {
              console.log("Scroll to line", line);
            }}
          />
        </div>
      </div>

      <div className="h-6 bg-[#0a1210] border-t border-[#1a2e25] flex items-center px-4 text-[10px] font-mono text-[#3a4a44] shrink-0 gap-4">
        <span>⚡ Turbopack • PostgreSQL via Drizzle ORM (pg driver) • Gemini</span>
        <span className="hidden md:inline">• No mock data • Real DB + Real FS Access API</span>
        <span className="ml-auto">Built for demo to recruiters • Vercel serverless-safe</span>
      </div>
    </div>
  );
}
