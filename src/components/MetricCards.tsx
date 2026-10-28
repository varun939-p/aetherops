"use client";

import type { ReactNode } from "react";
import type { StatsDto, SystemDto } from "@/lib/contracts";
import { cn, formatInt, formatMs } from "@/lib/utils";

/** Compact telemetry strip. Every value is read from /api/stats or /api/system; absent data renders as "—". */

function Cell({ label, value, unit, sub, tone, className }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode; tone?: string; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col justify-center gap-0.5 border-r border-line px-3.5", className)}>
      <div className="truncate text-[10px] font-semibold uppercase tracking-[0.09em] text-fg-subtle">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className={cn("tnum font-mono text-[17px] font-medium leading-none", tone ?? "text-fg")}>{value}</span>
        {unit && <span className="font-mono text-[10.5px] text-fg-subtle">{unit}</span>}
        {sub && <span className="tnum ml-1 truncate font-mono text-[10.5px] text-fg-subtle">{sub}</span>}
      </div>
    </div>
  );
}

function healthTone(h: number | null): string {
  if (h === null) return "text-fg-muted";
  if (h >= 90) return "text-ok";
  if (h >= 70) return "text-sev-medium";
  return "text-sev-critical";
}

function Dot({ state }: { state: "ok" | "warn" | "down" | "off" }) {
  const cls = { ok: "bg-ok", warn: "bg-sev-medium", down: "bg-sev-critical", off: "bg-fg-faint" }[state];
  return <span className={cn("inline-block size-1.5 rounded-full", cls)} />;
}

export function MetricCards({ stats, system, loading }: { stats: StatsDto | undefined; system: SystemDto | undefined; loading: boolean }) {
  const dash = loading ? "…" : "—";
  const critical = stats?.openIssues.bySeverity.critical ?? null;
  const high = stats?.openIssues.bySeverity.high ?? null;

  const db = system?.db;
  const dbState = !db ? "off" : !db.connected ? "down" : !db.migrated ? "warn" : "ok";
  const dbLabel = !db ? "—" : !db.configured ? "not configured" : !db.connected ? "unreachable" : !db.migrated ? "not migrated" : `${db.driver} ${db.latencyMs ?? "?"}ms`;

  return (
    <div className="grid h-12 shrink-0 grid-cols-2 border-b border-line bg-surface sm:grid-cols-4 lg:grid-cols-[repeat(5,minmax(0,1fr))_minmax(0,1.6fr)]">
      <Cell
        label="System health index"
        value={stats?.healthIndex?.toFixed(1) ?? dash}
        unit={stats?.healthIndex !== null && stats?.healthIndex !== undefined ? "/100" : undefined}
        tone={healthTone(stats?.healthIndex ?? null)}
      />
      <Cell
        label="Active critical faults"
        value={critical ?? dash}
        sub={high !== null ? `+${high} high` : undefined}
        tone={critical ? "text-sev-critical" : "text-fg"}
      />
      <Cell
        label="Mean scan latency"
        value={stats?.scanLatency.meanMs != null ? formatMs(stats.scanLatency.meanMs) : dash}
        sub={stats?.scanLatency.p95Ms != null ? `p95 ${formatMs(stats.scanLatency.p95Ms)}` : undefined}
        className="hidden sm:flex"
      />
      <Cell
        label="Coverage"
        value={stats?.coveragePct != null ? stats.coveragePct.toFixed(1) : dash}
        unit={stats?.coveragePct != null ? "%" : undefined}
        sub={stats ? `${formatInt(stats.files.analyzed)}/${formatInt(stats.files.total)}` : undefined}
        className="hidden lg:flex"
      />
      <Cell label="LOC scanned" value={stats ? formatInt(stats.loc.analyzed) : dash} sub={stats ? `of ${formatInt(stats.loc.total)}` : undefined} className="hidden lg:flex" />
      <div className="hidden min-w-0 flex-col justify-center gap-1 px-3.5 sm:flex">
        <div className="text-[10px] font-semibold uppercase tracking-[0.09em] text-fg-subtle">Engine</div>
        <div className="flex min-w-0 items-center gap-3 font-mono text-[11px] text-fg-muted">
          <span className="flex items-center gap-1.5 truncate" title={db?.error ?? undefined}>
            <Dot state={dbState} /> db {dbLabel}
          </span>
          <span className="flex items-center gap-1.5 truncate">
            <Dot state={system ? (system.ai.configured ? "ok" : "off") : "off"} /> ai {system?.ai.configured ? system.ai.model : "offline"}
          </span>
          <span className="flex items-center gap-1.5 truncate" title={system?.fs.reason ?? undefined}>
            <Dot state={system ? (system.fs.serverMode ? "ok" : "off") : "off"} /> fs {system?.fs.serverMode ? "server" : "browser"}
          </span>
        </div>
      </div>
    </div>
  );
}
