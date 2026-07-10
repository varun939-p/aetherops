"use client";
import { Skeleton } from "./ui";

interface Stats {
  health: number;
  totalFiles: number;
  totalIssues: number;
  totalLines: number;
  avgQuality: number;
  byStatus: Record<string, number>;
  bySeverity: Record<string, number>;
}

export function MetricCards({ stats, loading, isSyncActive }: { stats: Stats | null; loading: boolean; isSyncActive: boolean }) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="bg-[#0f1613] border border-[#1a2e25] rounded p-4 h-[98px]">
            <Skeleton className="h-3 w-20 mb-4" />
            <Skeleton className="h-8 w-16" />
          </div>
        ))}
      </div>
    );
  }

  const health = stats?.health ?? 99.9;
  const cpuLoad = 34 + Math.floor(Math.random() * 5); // Simulated - could be real CPU if we had endpoint
  const memoryUsed = stats ? Math.min(68 + stats.totalFiles, 120) : 68;
  const memoryTotal = 128;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <div className="bg-[#0f1613] border border-[#1a2e25] rounded p-4 glow-border relative overflow-hidden">
        <div className="flex justify-between items-start mb-2">
          <span className="text-[10px] tracking-[0.2em] text-[#6b8a7a] font-mono">SERVER HEALTH</span>
          <span className="text-[#00ff88]">♡</span>
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-3xl font-bold text-[#00ff88] font-mono tracking-tighter">{health.toFixed(1)}</span>
          <span className="text-xs text-[#00ff88]">%</span>
        </div>
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-[#00ff88]/0 via-[#00ff88]/50 to-[#00ff88]/0" />
      </div>

      <div className="bg-[#0f1613] border border-[#1a2e25] rounded p-4 glow-border">
        <div className="flex justify-between items-start mb-2">
          <span className="text-[10px] tracking-[0.2em] text-[#6b8a7a] font-mono">CPU CORE LOAD</span>
          <span className="text-[#6b8a7a]">⚙</span>
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-3xl font-bold text-white font-mono tracking-tighter">{cpuLoad}</span>
          <span className="text-xs text-[#6b8a7a]">%</span>
        </div>
      </div>

      <div className="bg-[#0f1613] border border-[#1a2e25] rounded p-4 glow-border">
        <div className="flex justify-between items-start mb-2">
          <span className="text-[10px] tracking-[0.2em] text-[#6b8a7a] font-mono">MEMORY USAGE</span>
          <span className="text-[#6b8a7a]">🗄</span>
        </div>
        <div className="flex items-baseline gap-1">
          <span className="text-3xl font-bold text-white font-mono tracking-tighter">{memoryUsed}</span>
          <span className="text-xs text-[#6b8a7a]">/ {memoryTotal}GB</span>
        </div>
      </div>

      <div className="bg-[#0f1613] border border-[#1a2e25] rounded p-4 flex flex-col items-center justify-center glow-border">
        <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded bg-[#0a1a12] border border-[#00ff88]/20 ${isSyncActive ? "animate-pulse-green" : ""}`}>
          <span className={`w-2 h-2 rounded-full ${isSyncActive ? "bg-[#00ff88]" : "bg-[#6b8a7a]"}`} />
          <span className="text-[10px] tracking-widest text-[#00ff88] font-mono">
            {isSyncActive ? "DESKTOP SYNC ACTIVE" : "SYNC INACTIVE"}
          </span>
        </div>
        <span className="text-[9px] tracking-widest text-[#4a6a5a] mt-2 font-mono">AETHEROPS_WATCH LINKED</span>
      </div>
    </div>
  );
}
