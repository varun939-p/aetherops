"use client";
import React from "react";

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse bg-[#1a2e25]/60 rounded ${className}`} />;
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    pending: { label: "PENDING", cls: "bg-[#1e2e24] text-[#ffcc33] border-[#ffcc33]/30" },
    analyzing: { label: "ANALYZING", cls: "bg-[#1a2a2e] text-[#00d4ff] border-[#00d4ff]/30 animate-pulse" },
    issues: { label: "ISSUES FOUND", cls: "bg-[#2e1a1e] text-[#ff3b5c] border-[#ff3b5c]/30" },
    clean: { label: "CLEAN", cls: "bg-[#1a2e22] text-[#00ff88] border-[#00ff88]/30" },
    error: { label: "ERROR", cls: "bg-[#2e1a1a] text-[#ff3b5c] border-[#ff3b5c]/50" },
    committing: { label: "COMMITTING", cls: "bg-[#1e2e24] text-[#00ff88] border-[#00ff88]/30 animate-pulse" },
    synced: { label: "Synced", cls: "bg-transparent text-[#00ff88] border-none" },
  };
  const cfg = map[status?.toLowerCase()] || map.pending;
  return (
    <span className={`inline-flex items-center gap-1.5 text-[10px] tracking-widest font-mono px-2 py-0.5 rounded border ${cfg.cls}`}>
      {status === "synced" && <span className="w-2 h-2 rounded-full bg-[#00ff88] inline-block" />}
      {status !== "synced" && <span className="w-1.5 h-1.5 rounded-full bg-current opacity-80" />}
      {status === "synced" ? "Synced" : cfg.label}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  const m: Record<string, string> = {
    critical: "text-[#ff3b5c] bg-[#ff3b5c]/10 border-[#ff3b5c]/30",
    high: "text-[#ff8c42] bg-[#ff8c42]/10 border-[#ff8c42]/30",
    medium: "text-[#ffcc33] bg-[#ffcc33]/10 border-[#ffcc33]/30",
    low: "text-[#00d4ff] bg-[#00d4ff]/10 border-[#00d4ff]/30",
    info: "text-[#6b8a7a] bg-[#6b8a7a]/10 border-[#6b8a7a]/20",
  };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono tracking-wide ${m[severity] || m.info}`}>
      {severity.toUpperCase()}
    </span>
  );
}

export function Button({
  children,
  variant = "primary",
  size = "sm",
  disabled,
  loading,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger" | "outline";
  size?: "sm" | "md";
  loading?: boolean;
}) {
  const base = "inline-flex items-center justify-center gap-1.5 font-mono text-xs tracking-widest rounded transition-all disabled:opacity-40 disabled:cursor-not-allowed";
  const variants: Record<string, string> = {
    primary: "bg-[#00ff88] text-black hover:bg-[#00cc6a] border border-[#00ff88]",
    ghost: "bg-transparent text-[#6b8a7a] hover:text-[#d6ffe8] hover:bg-[#1a2e25]",
    danger: "bg-transparent text-[#ff3b5c] hover:bg-[#ff3b5c]/10 border border-[#ff3b5c]/20",
    outline: "bg-transparent text-[#00ff88] border border-[#00ff88]/30 hover:bg-[#00ff88]/10",
  };
  const sizes: Record<string, string> = {
    sm: "px-3 py-1.5 h-7",
    md: "px-4 py-2 h-9",
  };
  return (
    <button className={`${base} ${variants[variant]} ${sizes[size]}`} disabled={disabled || loading} {...props}>
      {loading && <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />}
      {children}
    </button>
  );
}
