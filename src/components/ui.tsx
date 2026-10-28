"use client";

import type { ButtonHTMLAttributes, ReactNode, SVGProps } from "react";
import type { Category, FileStatusDto, Severity } from "@/lib/contracts";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------------------------
// Icons (16px stroke set; functional only)
// ---------------------------------------------------------------------------------------------

const ICON_PATHS = {
  chevronRight: "M6 4l4 4-4 4",
  chevronDown: "M4 6l4 4 4-4",
  folder: "M2 4.5A1.5 1.5 0 013.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5z",
  file: "M4 2h5l3 3v9H4zM9 2v3h3",
  refresh: "M13 8a5 5 0 11-1.5-3.5M13 2.5V5h-2.5",
  play: "M5 3.5v9l7-4.5z",
  commit: "M8 10.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM1.5 8h4M10.5 8h4",
  close: "M4 4l8 8M12 4l-8 8",
  search: "M7 12A5 5 0 107 2a5 5 0 000 10zM14 14l-3.5-3.5",
  link: "M6.5 9.5l3-3M7 4.5l1-1a2.83 2.83 0 014 4l-1 1M9 11.5l-1 1a2.83 2.83 0 01-4-4l1-1",
  trash: "M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9",
  alert: "M8 2l6.5 11.5h-13zM8 6.5v3M8 11.5v.01",
  diff: "M5 2v7M2.5 5.5h5M8.5 12h5M11 9.5v5",
  code: "M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5",
  database: "M8 2c3 0 5.5.9 5.5 2v8c0 1.1-2.5 2-5.5 2s-5.5-.9-5.5-2V4c0-1.1 2.5-2 5.5-2zM2.5 4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2",
  sidebar: "M2.5 3h11v10h-11zM10 3v10",
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function Icon({ name, size = 14, className, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={cn("shrink-0", className)} {...rest}>
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------------------------

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-[#0b1220] hover:bg-accent-strong border border-accent",
  secondary: "bg-raised text-fg border border-line-strong hover:bg-hover hover:border-[#3a3e46]",
  ghost: "text-fg-muted hover:text-fg hover:bg-hover border border-transparent",
  danger: "text-sev-critical border border-line-strong hover:bg-[rgb(242_85_90/0.1)] hover:border-sev-critical/40",
};

export function Button({
  variant = "secondary",
  size = "sm",
  icon,
  loading,
  className,
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "xs" | "sm"; icon?: IconName; loading?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={cn(
        "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-[3px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        size === "xs" ? "h-6 px-2 text-[11px]" : "h-7 px-2.5 text-[12px]",
        VARIANTS[variant],
        className
      )}
      {...props}
    >
      {loading ? <Spinner /> : icon ? <Icon name={icon} size={13} /> : null}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span aria-label="Loading" className={cn("inline-block size-3 animate-spin rounded-full border border-current border-t-transparent", className)} />;
}

export function Segmented<T extends string>({ value, options, onChange, size = "sm" }: { value: T; options: Array<{ value: T; label: ReactNode; title?: string }>; onChange: (v: T) => void; size?: "xs" | "sm" }) {
  return (
    <div role="tablist" className="inline-flex rounded-[3px] border border-line-strong bg-canvas p-px">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-[2px] font-medium transition-colors",
            size === "xs" ? "h-5 px-1.5 text-[10.5px]" : "h-6 px-2 text-[11px]",
            value === o.value ? "bg-hover text-fg" : "text-fg-subtle hover:text-fg-muted"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Data atoms
// ---------------------------------------------------------------------------------------------

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export const SEVERITY_TEXT: Record<Severity, string> = {
  critical: "text-sev-critical",
  high: "text-sev-high",
  medium: "text-sev-medium",
  low: "text-sev-low",
  info: "text-sev-info",
};

export const SEVERITY_BG: Record<Severity, string> = {
  critical: "bg-sev-critical",
  high: "bg-sev-high",
  medium: "bg-sev-medium",
  low: "bg-sev-low",
  info: "bg-sev-info",
};

const SEVERITY_LABEL: Record<Severity, string> = { critical: "CRIT", high: "HIGH", medium: "MED", low: "LOW", info: "INFO" };

export function SeverityTag({ severity, className }: { severity: Severity; className?: string }) {
  return (
    <span className={cn("inline-flex h-[18px] w-[38px] shrink-0 items-center justify-center rounded-[2px] border border-current/30 font-mono text-[10px] font-semibold tracking-wide", SEVERITY_TEXT[severity], className)}>
      {SEVERITY_LABEL[severity]}
    </span>
  );
}

export const CATEGORY_LABEL: Record<Category, string> = {
  security: "SECURITY",
  reliability: "RELIABILITY",
  performance: "PERFORMANCE",
  concurrency: "CONCURRENCY",
  maintainability: "MAINTAINABILITY",
};

/** Explorer / table status glyph. Shape plus color, so state is not conveyed by hue alone. */
export function FileStatusMark({ status, critical, stale }: { status: FileStatusDto; critical: number; stale: boolean }) {
  if (status === "analyzing") return <Spinner className="size-2.5 text-accent" />;
  if (status === "error") return <span title="Analysis error" className="font-mono text-[10px] font-bold leading-none text-sev-critical">!</span>;
  if (stale || status === "pending") return <span title="Modified since last analysis" className="size-2 rounded-full border border-sev-medium" />;
  if (critical > 0) return <span title="Critical faults" className="size-2 rotate-45 bg-sev-critical" />;
  if (status === "issues") return <span title="Open issues" className="size-2 rounded-[1px] bg-sev-medium" />;
  return <span title="Clean" className="size-2 rounded-full bg-ok/80" />;
}

export function Kv({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-baseline gap-1.5", className)}>
      <span className="text-[10.5px] uppercase tracking-wider text-fg-subtle">{label}</span>
      <span className="tnum font-mono text-[11.5px] text-fg-muted">{children}</span>
    </span>
  );
}

export function PaneHeader({ title, children, className }: { title: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-8 shrink-0 items-center justify-between gap-2 border-b border-line px-3", className)}>
      <div className="flex min-w-0 items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-muted">{title}</div>
      {children && <div className="flex shrink-0 items-center gap-1">{children}</div>}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <div className="text-[12px] font-medium text-fg-muted">{title}</div>
      {children && <div className="max-w-[340px] text-[11.5px] leading-relaxed text-fg-subtle">{children}</div>}
    </div>
  );
}

export function SkeletonRows({ rows = 8, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-1.5 p-3", className)} aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-3.5 animate-pulse rounded-[2px] bg-hover" style={{ width: `${55 + ((i * 37) % 40)}%` }} />
      ))}
    </div>
  );
}

export function HighlightedText({ text, positions }: { text: string; positions: number[] | undefined }) {
  if (!positions?.length) return <>{text}</>;
  const set = new Set(positions);
  return (
    <>
      {Array.from(text, (ch, i) =>
        set.has(i) ? (
          <span key={i} className="text-accent-strong">
            {ch}
          </span>
        ) : (
          ch
        )
      )}
    </>
  );
}
