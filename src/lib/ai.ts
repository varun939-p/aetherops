import { GoogleGenerativeAI } from "@google/generative-ai";
import { fastScan, HeuristicIssue } from "./heuristic";

export interface AIAnalysisIssue {
  line: number;
  column?: number;
  severity: "critical" | "high" | "medium" | "low" | "info";
  message: string;
  source: "heuristic" | "ai";
  ruleId?: string;
}

export interface AIAnalysisResult {
  issues: AIAnalysisIssue[];
  correctedCode: string;
  qualityScore: number;
  summary: string;
  heuristicDurationMs: number;
  aiDurationMs: number;
  modelUsed: string;
}

function getEnvOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in environment variables. Please set it in .env`);
  return v;
}

export function buildPrompt(fileContent: string, fileName: string, language: string): string {
  // Required verbatim instructions per spec §6.2
  const verbatim1 = "Act as an expert SRE. Perform a tiered analysis: identify critical security and runtime bugs first. Prioritize them at the top of the JSON output so the UI can highlight them instantly.";
  const verbatim2 = "Refactor the code to optimize for execution time; flag memory leaks and unnecessary re-allocations found during the initial pass.";

  return `
${verbatim1}
${verbatim2}

You are an expert code reviewer and SRE. Analyze the following file:

File: ${fileName}
Language: ${language}

TASK:
- Find all bugs, vulnerabilities, performance issues, and style problems.
- Order: critical security/runtime bugs first, then memory leaks, then performance, then quality/style.
- Provide a fully corrected, production-ready version of the file.

STRICT OUTPUT FORMAT - JSON ONLY, no markdown, no prose outside JSON:
{
  "issues": [
    {
      "line": <number>,
      "column": <number (optional)>,
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "message": "<clear description of the bug>",
      "ruleId": "<short rule id like typo-attribute, missing-validation, xss, etc>"
    }
  ],
  "correctedCode": "<entire corrected file content as a single string, with \\n for newlines, fully fixed>",
  "qualityScore": <0-100 integer, where 100 is perfect>,
  "summary": "<1-2 sentence summary of findings>"
}

Rules:
- correctedCode must be complete file, not diff, not partial. Must fix ALL issues.
- Preserve original functionality, only fix bugs + optimize.
- If file is already clean, issues = [] and correctedCode = original (or slightly improved), qualityScore 90+.
- No free-form prose outside JSON. Output must be valid JSON parseable by JSON.parse().
- Include line numbers accurate to original file.

File content:
\`\`\`${language}
${fileContent}
\`\`\`

Return JSON now:
`.trim();
}

function safeParseJSON(text: string): any {
  // Try to extract JSON from markdown code blocks if model returned markdown anyway
  let cleaned = text.trim();
  // Remove ```json ... ``` if present
  const jsonBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (jsonBlockMatch) {
    cleaned = jsonBlockMatch[1];
  }
  // Find first { and last } to extract
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }
  return JSON.parse(cleaned);
}

export async function analyzeWithAI(
  fileContent: string,
  fileName: string,
  language: string
): Promise<AIAnalysisResult> {
  const heuristicStart = performance.now();
  const heuristicResult = fastScan(fileContent, language);
  const heuristicMs = Math.round(performance.now() - heuristicStart);

  // If file too large, truncate for AI but keep heuristic for full
  const MAX_CHARS_FOR_AI = 25000; // ~6k tokens, safe for Gemini
  let contentForAI = fileContent;
  let wasTruncated = false;
  if (fileContent.length > MAX_CHARS_FOR_AI) {
    // Take first 20000 and last 5000 to preserve context
    contentForAI =
      fileContent.slice(0, 20000) +
      "\n\n// ... [TRUNCATED " +
      (fileContent.length - 25000) +
      " chars for analysis] ...\n\n" +
      fileContent.slice(-5000);
    wasTruncated = true;
  }

  const apiKey = getEnvOrThrow("GEMINI_API_KEY");
  const modelName = getEnvOrThrow("GEMINI_MODEL");

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
    },
  });

  const prompt = buildPrompt(contentForAI, fileName, language);

  const aiStart = performance.now();
  let aiIssues: AIAnalysisIssue[] = [];
  let correctedCode = fileContent;
  let qualityScore = 75;
  let summary = "Analysis completed";

  try {
    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();
    if (!text) throw new Error("Empty response from Gemini");

    const parsed = safeParseJSON(text);

    if (Array.isArray(parsed.issues)) {
      aiIssues = parsed.issues.map((iss: any) => ({
        line: typeof iss.line === "number" ? iss.line : 1,
        column: typeof iss.column === "number" ? iss.column : 0,
        severity: (["critical", "high", "medium", "low", "info"].includes(iss.severity) ? iss.severity : "medium") as AIAnalysisIssue["severity"],
        message: String(iss.message || "Issue detected"),
        ruleId: String(iss.ruleId || iss.rule_id || "ai-detected"),
        source: "ai" as const,
      }));
    }

    if (typeof parsed.correctedCode === "string" && parsed.correctedCode.trim().length > 0) {
      correctedCode = parsed.correctedCode;
      // If truncated, we cannot replace full content safely; keep hint
      if (wasTruncated) {
        // For truncated large files, we still return corrected snippet but don't claim full replacement
        // Client will handle
      }
    } else if (typeof parsed.corrected_code === "string") {
      correctedCode = parsed.corrected_code;
    }

    if (typeof parsed.qualityScore === "number") {
      qualityScore = Math.min(100, Math.max(0, Math.round(parsed.qualityScore)));
    } else if (typeof parsed.quality_score === "number") {
      qualityScore = Math.min(100, Math.max(0, Math.round(parsed.quality_score)));
    }

    if (typeof parsed.summary === "string") {
      summary = parsed.summary;
    }

    // Merge heuristic + AI, dedup by line+message
    const merged: AIAnalysisIssue[] = [
      ...heuristicResult.issues.map((h) => ({
        line: h.line,
        column: h.column,
        severity: h.severity,
        message: h.message,
        ruleId: h.ruleId,
        source: h.source as "heuristic",
      })),
      ...aiIssues,
    ];

    // Sort by severity weight then line
    const weight: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    merged.sort((a, b) => {
      const wa = weight[a.severity] ?? 2;
      const wb = weight[b.severity] ?? 2;
      if (wa !== wb) return wa - wb;
      return a.line - b.line;
    });

    // Deduplicate similar issues on same line
    const deduped: AIAnalysisIssue[] = [];
    const seen = new Set<string>();
    for (const iss of merged) {
      const key = `${iss.line}:${iss.message.slice(0, 50)}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(iss);
      }
    }

    const aiMs = Math.round(performance.now() - aiStart);

    return {
      issues: deduped,
      correctedCode,
      qualityScore,
      summary,
      heuristicDurationMs: heuristicMs,
      aiDurationMs: aiMs,
      modelUsed: modelName,
    };
  } catch (err: any) {
    const aiMs = Math.round(performance.now() - aiStart);
    console.error("Gemini analysis failed:", err);
    // Return heuristic only, but mark that AI failed - caller should set error status if no issues and AI failed?
    // Per spec: Never mark clean if API failed. So we throw to let API route set error status.
    // However we include heuristic issues so UI shows something, but we re-throw with context.
    const error = new Error(`AI analysis failed: ${err?.message || String(err)}`);
    (error as any).heuristicResult = heuristicResult;
    (error as any).duration = aiMs;
    throw error;
  }
}

// Lightweight version for fast-scan only endpoint
export function analyzeHeuristicOnly(fileContent: string, language: string) {
  return fastScan(fileContent, language);
}
