"use client";
import { SeverityBadge, Skeleton } from "./ui";

interface Issue {
  id: number;
  line: number;
  severity: string;
  message: string;
  source: string;
  fileId?: number;
  filePath?: string;
}

interface Stats {
  totalFiles: number;
  totalIssues: number;
  bySeverity: Record<string, number>;
  byLang: Record<string, number>;
  avgQuality: number;
  health: number;
}

export function IssueTracker({
  issues,
  stats,
  loading,
  selectedFilePath,
  onIssueClick,
}: {
  issues: Issue[];
  stats: Stats | null;
  loading: boolean;
  selectedFilePath: string | null;
  onIssueClick: (line: number) => void;
}) {
  if (loading) {
    return (
      <div className="p-3 space-y-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  const criticalCount = stats?.bySeverity?.critical || 0;
  const highCount = stats?.bySeverity?.high || 0;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="p-3 space-y-4 overflow-y-auto flex-1">
        {/* Quality Score */}
        <div className="bg-[#0f1613] border border-[#1a2e25] rounded p-3">
          <div className="text-[10px] tracking-widest font-mono text-[#6b8a7a] mb-2">QUALITY SCORE</div>
          <div className="flex items-end gap-2">
            <span className="text-3xl font-bold font-mono text-white">{stats?.avgQuality ?? 0}</span>
            <span className="text-xs text-[#6b8a7a] mb-1">/100</span>
          </div>
          <div className="mt-2 h-1.5 bg-[#1a2e25] rounded-full overflow-hidden">
            <div className="h-full bg-gradient-to-r from-[#00ff88] to-[#00d4ff] rounded-full transition-all" style={{ width: `${stats?.avgQuality ?? 0}%` }} />
          </div>
        </div>

        {/* Severity breakdown */}
        <div className="bg-[#0f1613] border border-[#1a2e25] rounded p-3">
          <div className="text-[10px] tracking-widest font-mono text-[#6b8a7a] mb-3">CRITICAL BUGS</div>
          <div className="grid grid-cols-2 gap-2 text-xs font-mono">
            <div className="flex justify-between bg-[#1a1212] border border-[#ff3b5c]/20 rounded px-2 py-1.5">
              <span className="text-[#ff3b5c]">Critical</span>
              <span className="text-white">{criticalCount}</span>
            </div>
            <div className="flex justify-between bg-[#1a1510] border border-[#ff8c42]/20 rounded px-2 py-1.5">
              <span className="text-[#ff8c42]">High</span>
              <span className="text-white">{highCount}</span>
            </div>
            <div className="flex justify-between bg-[#1a1a10] border border-[#ffcc33]/20 rounded px-2 py-1.5">
              <span className="text-[#ffcc33]">Medium</span>
              <span className="text-white">{stats?.bySeverity?.medium || 0}</span>
            </div>
            <div className="flex justify-between bg-[#101a1e] border border-[#00d4ff]/20 rounded px-2 py-1.5">
              <span className="text-[#00d4ff]">Low/Info</span>
              <span className="text-white">{(stats?.bySeverity?.low || 0) + (stats?.bySeverity?.info || 0)}</span>
            </div>
          </div>
        </div>

        {/* Language composition */}
        <div className="bg-[#0f1613] border border-[#1a2e25] rounded p-3">
          <div className="text-[10px] tracking-widest font-mono text-[#6b8a7a] mb-3">LANGUAGE COMPOSITION</div>
          <div className="space-y-1.5">
            {stats?.byLang && Object.entries(stats.byLang).length > 0 ? (
              Object.entries(stats.byLang)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 6)
                .map(([lang, count]) => (
                  <div key={lang} className="flex items-center justify-between text-[11px] font-mono">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-[#00ff88]" />
                      <span className="text-[#d6ffe8]">{lang}</span>
                    </div>
                    <span className="text-[#6b8a7a]">{count} files</span>
                  </div>
                ))
            ) : (
              <div className="text-[11px] text-[#4a6a5a] font-mono">No data</div>
            )}
          </div>
        </div>

        {/* Selected file issues */}
        <div className="bg-[#0f1613] border border-[#1a2e25] rounded">
          <div className="px-3 py-2 border-b border-[#1a2e25] text-[10px] tracking-widest font-mono text-[#6b8a7a]">
            ISSUE TRACKER {selectedFilePath ? `— ${selectedFilePath.split("/").pop()}` : ""}
          </div>
          <div className="max-h-[300px] overflow-y-auto divide-y divide-[#1a2e25]/50">
            {issues.length === 0 ? (
              <div className="p-4 text-center">
                <div className="text-[#00ff88] text-xs font-mono">✓ No issues in this file</div>
                <div className="text-[10px] text-[#4a6a5a] font-mono mt-1">File is clean or not yet analyzed</div>
              </div>
            ) : (
              issues
                .sort((a, b) => {
                  const w: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
                  return (w[a.severity] || 2) - (w[b.severity] || 2);
                })
                .map((iss, idx) => (
                  <div key={idx} onClick={() => onIssueClick(iss.line)} className="p-2.5 hover:bg-[#1a2e25]/40 cursor-pointer group">
                    <div className="flex items-center gap-2 mb-1">
                      <SeverityBadge severity={iss.severity} />
                      <span className="text-[10px] font-mono text-[#4a6a5a]">L{iss.line}</span>
                      <span className="text-[9px] font-mono text-[#3a4a44]">{iss.source}</span>
                    </div>
                    <div className="text-[11px] font-mono text-[#d6ffe8] leading-4 group-hover:text-white">{iss.message}</div>
                  </div>
                ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
