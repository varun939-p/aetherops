"use client";
import { useState, useMemo, useRef, useEffect } from "react";
import { Skeleton, Button, SeverityBadge } from "./ui";

interface Issue {
  id?: number;
  line: number;
  severity: string;
  message: string;
  source: string;
  ruleId?: string;
}

interface FileData {
  id: number;
  path: string;
  content: string;
  correctedContent?: string | null;
  language: string;
  status: string;
  qualityScore?: number | null;
  errorMessage?: string | null;
  issues?: Issue[];
}

function highlightLine(content: string, lang: string): string {
  // Minimal highlighting placeholder - for portfolio we use mono but keep safe
  return content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function CodePane({
  code,
  issues,
  title,
  isCorrected,
  language,
}: {
  code: string;
  issues: Issue[];
  title: string;
  isCorrected?: boolean;
  language: string;
}) {
  const lines = code.split("\n");
  const scrollRef = useRef<HTMLDivElement>(null);
  const issueMap = useMemo(() => {
    const m = new Map<number, Issue[]>();
    issues.forEach((iss) => {
      const arr = m.get(iss.line) || [];
      arr.push(iss);
      m.set(iss.line, arr);
    });
    return m;
  }, [issues]);

  return (
    <div className="flex flex-col h-full bg-[#0a1210] border border-[#1a2e25] rounded overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 bg-[#0f1613] border-b border-[#1a2e25]">
        <span className="text-[10px] tracking-widest font-mono text-[#6b8a7a]">{title}</span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-[#4a6a5a]">{lines.length} lines • {language}</span>
          {isCorrected && <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#00ff88]/10 text-[#00ff88] border border-[#00ff88]/20">AI RECTIFIED</span>}
        </div>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-auto font-mono text-[12px] leading-5">
        <div className="min-w-max">
          {lines.map((line, idx) => {
            const lineNo = idx + 1;
            const lineIssues = issueMap.get(lineNo) || [];
            const hasCritical = lineIssues.some((i) => i.severity === "critical");
            const hasIssue = lineIssues.length > 0;
            return (
              <div
                key={idx}
                className={`flex ${hasCritical ? "bg-[#ff3b5c]/10" : hasIssue ? "bg-[#ffcc33]/5" : ""} hover:bg-[#1a2e25]/50 group`}
              >
                <div className="sticky left-0 flex">
                  <span className="w-12 text-right pr-3 py-0.5 text-[#3a4a44] select-none bg-[#0a1210] border-r border-[#1a2e25]/50">
                    {String(lineNo).padStart(3, " ")}
                  </span>
                  <span className="w-4 text-center py-0.5">
                    {hasIssue && <span className={`text-[10px] ${hasCritical ? "text-[#ff3b5c]" : "text-[#ffcc33]"}`}>●</span>}
                  </span>
                </div>
                <pre className="pl-2 pr-4 py-0.5 whitespace-pre text-[#cde8d6] overflow-visible">
                  {line || " "}
                </pre>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function CodeViewport({
  file,
  loading,
  onCommit,
  onReanalyze,
  committing,
  reanalyzing,
}: {
  file: FileData | null;
  loading: boolean;
  onCommit: () => void;
  onReanalyze: () => void;
  committing: boolean;
  reanalyzing: boolean;
}) {
  const [view, setView] = useState<"split" | "original" | "corrected">("split");

  if (loading) {
    return (
      <div className="h-full p-3 space-y-3">
        <Skeleton className="h-8 w-full" />
        <div className="grid grid-cols-2 gap-3 h-[500px]">
          <Skeleton className="h-full w-full" />
          <Skeleton className="h-full w-full" />
        </div>
      </div>
    );
  }

  if (!file) {
    return (
      <div className="h-full flex flex-col items-center justify-center p-8 text-center bg-[#0a1210] border border-dashed border-[#1a2e25] rounded m-3">
        <div className="text-3xl mb-3 opacity-20">◧</div>
        <div className="text-xs font-mono tracking-widest text-[#4a6a5a]">NO FILE SELECTED</div>
        <div className="text-[11px] font-mono text-[#2a3e35] mt-2 max-w-[280px]">Select a file from the repository explorer to view its source and AI remediation</div>
      </div>
    );
  }

  const issues = file.issues || [];
  const corrected = file.correctedContent || "";

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#1a2e25] bg-[#0f1613]">
        <div className="flex items-center gap-2">
          <span className="text-[#00ff88]">⚡</span>
          <span className="text-[11px] tracking-widest font-mono text-white">AI CODE RESOLUTION</span>
          <span className="text-[10px] font-mono text-[#6b8a7a]">File: <span className="text-[#00ff88]">{file.path}</span></span>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setView("original")} className={`text-[10px] px-2 py-1 rounded font-mono ${view === "original" ? "bg-[#1a2e25] text-white" : "text-[#6b8a7a]"}`}>ORIGINAL</button>
          <button onClick={() => setView("split")} className={`text-[10px] px-2 py-1 rounded font-mono ${view === "split" ? "bg-[#1a2e25] text-white" : "text-[#6b8a7a]"}`}>SPLIT</button>
          <button onClick={() => setView("corrected")} className={`text-[10px] px-2 py-1 rounded font-mono ${view === "corrected" ? "bg-[#1a2e25] text-white" : "text-[#6b8a7a]"}`}>CORRECTED</button>
        </div>
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between px-3 py-2 bg-[#0a0f0e] border-b border-[#1a2e25]">
        <div className="flex items-center gap-3">
          <span className={`text-[10px] px-2 py-0.5 rounded border font-mono tracking-wide ${
            file.status === "clean" ? "bg-[#00ff88]/10 text-[#00ff88] border-[#00ff88]/20" :
            file.status === "issues" ? "bg-[#ff3b5c]/10 text-[#ff3b5c] border-[#ff3b5c]/20" :
            file.status === "error" ? "bg-[#ff3b5c]/20 text-[#ff3b5c] border-[#ff3b5c]/30" :
            file.status === "analyzing" ? "bg-[#00d4ff]/10 text-[#00d4ff] border-[#00d4ff]/20" :
            "bg-[#ffcc33]/10 text-[#ffcc33] border-[#ffcc33]/20"
          }`}>
            {file.status.toUpperCase()} {file.status === "issues" ? `• ${issues.length} ISSUES` : ""} {file.qualityScore ? `• Q:${file.qualityScore}` : ""}
          </span>
          {file.errorMessage && <span className="text-[10px] text-[#ff3b5c] font-mono truncate max-w-[300px]">{file.errorMessage}</span>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onReanalyze} loading={reanalyzing}>↻ RE-ANALYZE</Button>
          {corrected && (
            <Button variant="primary" size="sm" onClick={onCommit} loading={committing} disabled={file.status === "clean"}>⚡ COMMIT FIX</Button>
          )}
        </div>
      </div>

      {/* Code panes */}
      <div className="flex-1 overflow-hidden p-2 bg-[#050a09]">
        {file.status === "error" ? (
          <div className="h-full flex flex-col items-center justify-center p-6 bg-[#1a1010] border border-[#ff3b5c]/20 rounded">
            <div className="text-[#ff3b5c] text-xs font-mono tracking-widest mb-2">ANALYSIS ERROR</div>
            <div className="text-[11px] font-mono text-[#ff8a8a] max-w-[500px] text-center mb-4">{file.errorMessage || "AI analysis failed. Check GEMINI_API_KEY and retry."}</div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={onReanalyze}>RETRY ANALYSIS</Button>
            </div>
            {issues.length > 0 && (
              <div className="mt-4 w-full max-w-[600px]">
                <div className="text-[10px] text-[#6b8a7a] font-mono mb-2">Heuristic results (fast-scan) still available:</div>
                <CodePane code={file.content} issues={issues} title="VULNERABLE SOURCE (HEURISTIC)" language={file.language} />
              </div>
            )}
          </div>
        ) : view === "split" ? (
          <div className="grid grid-cols-2 gap-2 h-full">
            <CodePane code={file.content} issues={issues} title="VULNERABLE SOURCE CODE" language={file.language} />
            {corrected ? (
              <CodePane code={corrected} issues={[]} title="AI RECTIFIED CODE" language={file.language} isCorrected />
            ) : (
              <div className="flex flex-col items-center justify-center bg-[#0a1210] border border-[#1a2e25] rounded">
                {file.status === "analyzing" || file.status === "pending" ? (
                  <>
                    <div className="w-6 h-6 border-2 border-[#00ff88] border-t-transparent rounded-full animate-spin mb-3" />
                    <div className="text-[11px] font-mono text-[#6b8a7a]">AI is rectifying code...</div>
                    <div className="text-[10px] font-mono text-[#4a6a5a] mt-1">This may take a few seconds</div>
                  </>
                ) : file.status === "clean" ? (
                  <>
                    <div className="text-[#00ff88] text-2xl mb-2">✓</div>
                    <div className="text-[11px] font-mono text-[#00ff88]">CODE IS CLEAN</div>
                    <div className="text-[10px] font-mono text-[#4a6a5a] mt-1">No issues detected</div>
                  </>
                ) : (
                  <>
                    <div className="text-[11px] font-mono text-[#6b8a7a]">No corrected code yet</div>
                    <Button variant="ghost" size="sm" onClick={onReanalyze} className="mt-2">Analyze</Button>
                  </>
                )}
              </div>
            )}
          </div>
        ) : view === "original" ? (
          <CodePane code={file.content} issues={issues} title="VULNERABLE SOURCE CODE" language={file.language} />
        ) : (
          <CodePane code={corrected || file.content} issues={[]} title={corrected ? "AI RECTIFIED CODE" : "ORIGINAL (NO FIX YET)"} language={file.language} isCorrected={!!corrected} />
        )}
      </div>

      {/* Issues list bottom */}
      {issues.length > 0 && file.status !== "error" && (
        <div className="border-t border-[#1a2e25] bg-[#0f1613] max-h-[160px] overflow-auto">
          <div className="px-3 py-1.5 text-[10px] tracking-widest font-mono text-[#6b8a7a] border-b border-[#1a2e25]/50">ISSUES ({issues.length}) — sorted critical first</div>
          <div className="divide-y divide-[#1a2e25]/50">
            {issues.map((iss, i) => (
              <div key={i} className="flex items-start gap-2 px-3 py-1.5 hover:bg-[#1a2e25]/30">
                <SeverityBadge severity={iss.severity} />
                <span className="text-[11px] font-mono text-[#4a6a5a] min-w-[50px]">L{iss.line}</span>
                <span className="text-[11px] font-mono text-[#d6ffe8] flex-1">{iss.message}</span>
                <span className="text-[9px] font-mono text-[#4a6a5a]">{iss.source} • {iss.ruleId}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
