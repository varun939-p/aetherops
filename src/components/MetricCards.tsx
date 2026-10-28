"use client";

import type { ReactNode } from "react";
import type { StatsDto, SystemDto } from "@/lib/contracts";
import { cn, formatInt, formatMs } from "@/lib/utils";
import { Hint } from "./ui";

/** Project overview strip. Every value comes from /api/stats or /api/system; missing data renders as "—". */

function Metric({
  label,
  hint,
  value,
  suffix,
  caption,
  tone,
  className,
  hintAlign,
}: {
  label: string;
  hint: ReactNode;
  value: ReactNode;
  suffix?: string;
  caption?: ReactNode;
  tone?: string;
  className?: string;
  hintAlign?: "left" | "right";
}) {
  return (
    <div className={cn("flex min-w-0 flex-col justify-center gap-1 border-r border-line px-4 py-2.5", className)}>
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-fg-subtle">
        <span className="truncate">{label}</span>
        <Hint align={hintAlign}>{hint}</Hint>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className={cn("tnum text-[22px] font-semibold leading-none tracking-tight", tone ?? "text-fg")}>{value}</span>
        {suffix && <span className="text-[12.5px] text-fg-subtle">{suffix}</span>}
      </div>
      {caption && <div className="tnum truncate text-[12px] text-fg-subtle">{caption}</div>}
    </div>
  );
}

function healthTone(h: number | null | undefined): string {
  if (h === null || h === undefined) return "text-fg-muted";
  if (h >= 90) return "text-ok";
  if (h >= 70) return "text-sev-medium";
  return "text-sev-critical";
}

function healthWord(h: number | null | undefined): string {
  if (h === null || h === undefined) return "Not analyzed yet";
  if (h >= 90) return "Good";
  if (h >= 70) return "Needs attention";
  return "At risk";
}

function StatusRow({ state, label, detail }: { state: "ok" | "warn" | "down" | "off"; label: string; detail: string }) {
  const dot = { ok: "bg-ok", warn: "bg-sev-medium", down: "bg-sev-critical", off: "bg-fg-faint" }[state];
  return (
    <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
      <span className={cn("size-2 shrink-0 rounded-full", dot)} />
      <span className="w-[68px] shrink-0 text-fg-muted">{label}</span>
      <span className="truncate text-fg">{detail}</span>
    </div>
  );
}

export function MetricCards({ stats, system, loading }: { stats: StatsDto | undefined; system: SystemDto | undefined; loading: boolean }) {
  const dash = loading ? "…" : "—";
  const critical = stats?.openIssues.bySeverity.critical;
  const high = stats?.openIssues.bySeverity.high ?? 0;
  const db = system?.db;
  const dbState = !db ? "off" : !db.connected ? "down" : !db.migrated ? "warn" : "ok";
  const dbDetail = !db ? "—" : !db.configured ? "Not configured" : !db.connected ? "Unreachable" : !db.migrated ? "Needs migration" : `Connected · ${db.latencyMs ?? "?"} ms`;

  return (
    <div className="grid shrink-0 grid-cols-2 border-b border-line bg-canvas sm:grid-cols-3 lg:grid-cols-[repeat(5,minmax(0,1fr))_minmax(0,1.35fr)]">
      <Metric
        label="Health score"
        hint="Overall code health from 0 to 100. Each open issue lowers it by severity (critical counts most), weighted by file size. 100 means no open issues."
        value={stats?.healthIndex != null ? stats.healthIndex.toFixed(1) : dash}
        suffix={stats?.healthIndex != null ? "/ 100" : undefined}
        caption={healthWord(stats?.healthIndex)}
        tone={healthTone(stats?.healthIndex)}
      />
      <Metric
        label="Critical issues"
        hint="Open issues that can cause a security breach, data loss, or a crash. Fix these first."
        value={critical ?? dash}
        caption={stats ? `${high} high · ${stats.openIssues.total} open in total` : undefined}
        tone={critical ? "text-sev-critical" : "text-fg"}
      />
      <Metric
        label="Files analyzed"
        hint="Files whose current content has been analyzed. Files edited since their last analysis count as not analyzed."
        value={stats ? formatInt(stats.files.analyzed) : dash}
        suffix={stats ? `of ${formatInt(stats.files.total)}` : undefined}
        caption={stats?.coveragePct != null ? `${stats.coveragePct.toFixed(0)}% coverage` : undefined}
        className="hidden sm:flex"
      />
      <Metric
        label="Lines of code"
        hint="Total lines across all indexed files in this project."
        value={stats ? formatInt(stats.loc.total) : dash}
        caption={stats ? `${formatInt(stats.files.total)} file${stats.files.total === 1 ? "" : "s"}` : undefined}
        className="hidden lg:flex"
      />
      <Metric
        label="Avg. analysis time"
        hint="Average time to analyze one file over the last 50 analyses. AI reviews take seconds; rule-only scans take milliseconds."
        value={stats?.scanLatency.meanMs != null ? formatMs(stats.scanLatency.meanMs) : dash}
        caption={stats?.scanLatency.p95Ms != null ? `95% finish within ${formatMs(stats.scanLatency.p95Ms)}` : "No analyses yet"}
        className="hidden lg:flex"
      />
      <div className="hidden min-w-0 flex-col justify-center gap-1 px-4 py-2.5 sm:flex">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-fg-subtle">
          System status
          <Hint align="right">
            Database stores files and findings. AI review is optional; without it the built-in rules still run. File access shows whether AetherOps can write fixes to folders on this computer.
          </Hint>
        </div>
        <StatusRow state={dbState} label="Database" detail={dbDetail} />
        <StatusRow state={system ? (system.ai.configured ? "ok" : "off") : "off"} label="AI review" detail={system?.ai.configured ? (system.ai.model ?? "On") : "Off (rules only)"} />
        <StatusRow state={system ? (system.fs.serverMode ? "ok" : "off") : "off"} label="File access" detail={system?.fs.serverMode ? "Local folders" : "Browser only"} />
      </div>
    </div>
  );
}
