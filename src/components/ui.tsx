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
  sidebar: "M2.5 3h11v10h-11zM6 3v10",
  info: "M8 14.5a6.5 6.5 0 100-13 6.5 6.5 0 000 13zM8 7.5v4M8 5v.01",
  sun: "M8 11a3 3 0 100-6 3 3 0 000 6zM8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1",
  moon: "M13.5 9.5A5.5 5.5 0 016.5 2.5a5.5 5.5 0 107 7z",
  plus: "M8 3.5v9M3.5 8h9",
  minus: "M3.5 8h9",
  rotate: "M3 8a5 5 0 105-5H5M5 1v2.5h2.5",
  check: "M3.5 8.5l3 3 6-7",
  sparkle: "M8 2l1.3 3.7L13 7l-3.7 1.3L8 12l-1.3-3.7L3 7l3.7-1.3z",
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function Icon({ name, size = 14, className, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden className={cn("shrink-0", className)} {...rest}>
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------------------------

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-strong border border-accent shadow-sm",
  secondary: "bg-raised text-fg border border-line-strong hover:bg-hover shadow-[0_1px_1px_rgb(16_24_40/0.04)]",
  ghost: "text-fg-muted hover:text-fg hover:bg-hover border border-transparent",
  danger: "bg-raised text-danger-fg border border-line-strong hover:bg-danger-bg",
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
        "inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        size === "xs" ? "h-7 px-2.5 text-[12.5px]" : "h-8 px-3 text-[13px]",
        VARIANTS[variant],
        className
      )}
      {...props}
    >
      {loading ? <Spinner /> : icon ? <Icon name={icon} size={14} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon, label, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn("inline-flex size-8 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-hover hover:text-fg disabled:opacity-40", className)}
      {...props}
    >
      <Icon name={icon} size={15} />
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span aria-label="Loading" className={cn("inline-block size-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent", className)} />;
}

export function Segmented<T extends string>({ value, options, onChange, size = "sm", label }: { value: T; options: Array<{ value: T; label: ReactNode; title?: string }>; onChange: (v: T) => void; size?: "xs" | "sm"; label?: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-md border border-line bg-hover p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-[5px] font-medium transition-colors",
            size === "xs" ? "h-6 px-2 text-[12px]" : "h-7 px-2.5 text-[12.5px]",
            value === o.value ? "bg-raised text-fg shadow-[0_1px_2px_rgb(16_24_40/0.08)]" : "text-fg-subtle hover:text-fg"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Inline explanation: an info glyph that reveals a short description on hover or keyboard focus. */
export function Hint({ children, align = "left", className }: { children: ReactNode; align?: "left" | "right"; className?: string }) {
  return (
    <span className={cn("group/hint relative inline-flex", className)}>
      <span tabIndex={0} aria-label="More information" className="inline-flex cursor-help rounded-full text-fg-faint outline-none hover:text-fg-muted focus-visible:text-fg-muted">
        <Icon name="info" size={13} />
      </span>
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none invisible absolute top-full z-50 mt-1.5 w-64 rounded-md border border-line bg-raised px-3 py-2 text-left text-[12.5px] font-normal normal-case leading-relaxed tracking-normal text-fg-muted opacity-0 shadow-[var(--shadow-pop)] transition-opacity group-hover/hint:visible group-hover/hint:opacity-100 group-focus-within/hint:visible group-focus-within/hint:opacity-100",
          align === "left" ? "left-0" : "right-0"
        )}
      >
        {children}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------------------------
// Data atoms
// ---------------------------------------------------------------------------------------------

export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info" };

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

const SEVERITY_SOFT: Record<Severity, string> = {
  critical: "bg-sev-critical-soft",
  high: "bg-sev-high-soft",
  medium: "bg-sev-medium-soft",
  low: "bg-sev-low-soft",
  info: "bg-sev-info-soft",
};

export function SeverityTag({ severity, className }: { severity: Severity; className?: string }) {
  return (
    <span className={cn("inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[11.5px] font-semibold", SEVERITY_SOFT[severity], SEVERITY_TEXT[severity], className)}>
      <span className={cn("size-1.5 rounded-full", SEVERITY_BG[severity])} />
      {SEVERITY_LABEL[severity]}
    </span>
  );
}

export const CATEGORY_LABEL: Record<Category, string> = {
  security: "Security",
  reliability: "Reliability",
  performance: "Performance",
  concurrency: "Concurrency",
  maintainability: "Maintainability",
};

/** Explorer status glyph. Shape plus color, so state is not conveyed by hue alone. */
export function FileStatusMark({ status, critical, stale }: { status: FileStatusDto; critical: number; stale: boolean }) {
  if (status === "analyzing") return <Spinner className="size-2.5 text-accent" />;
  if (status === "error") return <span title="Analysis failed" className="text-[11px] font-bold leading-none text-sev-critical">!</span>;
  if (stale || status === "pending") return <span title="Changed since last analysis" className="size-2 rounded-full border-[1.5px] border-sev-medium" />;
  if (critical > 0) return <span title="Has critical issues" className="size-2 rotate-45 bg-sev-critical" />;
  if (status === "issues") return <span title="Has issues" className="size-2 rounded-[1px] bg-sev-medium" />;
  return <span title="No issues" className="size-2 rounded-full bg-ok" />;
}

export function PaneHeader({ title, hint, children, className }: { title: ReactNode; hint?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line px-3", className)}>
      <div className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold text-fg">
        {title}
        {hint && <Hint>{hint}</Hint>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-1">{children}</div>}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <div className="text-[14px] font-semibold text-fg">{title}</div>
      {children && <div className="max-w-[360px] text-[13px] leading-relaxed text-fg-subtle">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function SkeletonRows({ rows = 8, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2 p-3", className)} aria-busy>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-3.5 animate-pulse rounded bg-hover" style={{ width: `${55 + ((i * 37) % 40)}%` }} />
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
          <span key={i} className="font-semibold text-accent">
            {ch}
          </span>
        ) : (
          ch
        )
      )}
    </>
  );
}
