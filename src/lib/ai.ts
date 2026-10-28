import { GoogleGenerativeAI, GoogleGenerativeAIFetchError, SchemaType, type ResponseSchema } from "@google/generative-ai";
import { z } from "zod";
import { scanSource, compareFindings, scoreFindings, type Finding } from "./heuristic";
import { applyLineEdits, splitLines, PatchConflictError, type LineEdit } from "./text";
import type { AnalysisEngine, IssueCategory } from "@/db/schema";

/**
 * Hybrid analysis: the deterministic engine always runs; the LLM adds semantic findings and
 * line-range patches. Large files are split into token-budgeted chunks, each analyzed against
 * absolute line numbers, so a patch can never truncate content it did not see.
 */

export interface AiFinding extends Omit<Finding, "source"> {
  source: "ai";
}

export type AnyFinding = Finding | AiFinding;

export interface DeepAnalysis {
  engine: AnalysisEngine;
  findings: AnyFinding[];
  correctedContent: string | null;
  qualityScore: number;
  summary: string;
  modelUsed: string | null;
  heuristicMs: number;
  aiMs: number;
  coverage: { totalLines: number; analyzedLines: number; chunks: number; chunksAnalyzed: number; complete: boolean };
  /** Set when an AI provider is configured but the call failed or was incomplete. */
  aiError: string | null;
  attempts: number;
  droppedEdits: number;
}

// The two directives below are required verbatim by the product spec (§6.2).
const SPEC_DIRECTIVES = [
  "Act as an expert SRE. Perform a tiered analysis: identify critical security and runtime bugs first. Prioritize them at the top of the JSON output so the UI can highlight them instantly.",
  "Refactor the code to optimize for execution time; flag memory leaks and unnecessary re-allocations found during the initial pass.",
];

const SYSTEM_INSTRUCTION = `${SPEC_DIRECTIVES.join("\n")}

You review one chunk of a source file at a time. Lines are prefixed with their absolute line number ("  42| ").
Rules:
- Report only concrete defects you can point to: security vulnerabilities, runtime errors, concurrency hazards, resource/memory leaks, performance problems. No style or naming nits.
- Every issue's line/endLine must be absolute line numbers inside the chunk you were given.
- Fixes are expressed as edits that replace an inclusive line range [startLine, endLine] with "replacement" (raw code, no line-number prefixes, lines separated by \\n). Use endLine = startLine - 1 to insert before startLine. Edits must not overlap and must stay inside the chunk.
- Preserve behaviour except for the defect being fixed. Keep the file's indentation style.
- If the chunk has no defects return empty issues and edits arrays.
- Findings already reported by the deterministic engine are listed; do not repeat them as issues, but do include edits that fix them.`;

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
const CATEGORIES = ["security", "reliability", "performance", "concurrency", "maintainability"] as const;

const RESPONSE_SCHEMA: ResponseSchema = {
  type: SchemaType.OBJECT,
  properties: {
    summary: { type: SchemaType.STRING },
    qualityScore: { type: SchemaType.INTEGER },
    issues: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          line: { type: SchemaType.INTEGER },
          endLine: { type: SchemaType.INTEGER },
          severity: { type: SchemaType.STRING, format: "enum", enum: [...SEVERITIES] },
          category: { type: SchemaType.STRING, format: "enum", enum: [...CATEGORIES] },
          title: { type: SchemaType.STRING },
          message: { type: SchemaType.STRING },
          remediation: { type: SchemaType.STRING },
        },
        required: ["line", "severity", "category", "title", "message", "remediation"],
      },
    },
    edits: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          startLine: { type: SchemaType.INTEGER },
          endLine: { type: SchemaType.INTEGER },
          replacement: { type: SchemaType.STRING },
        },
        required: ["startLine", "endLine", "replacement"],
      },
    },
  },
  required: ["summary", "qualityScore", "issues", "edits"],
};

const chunkResponse = z.object({
  summary: z.string().max(4000).catch(""),
  qualityScore: z.coerce.number().int().min(0).max(100).catch(70),
  issues: z
    .array(
      z.object({
        line: z.coerce.number().int(),
        endLine: z.coerce.number().int().optional(),
        severity: z.enum(SEVERITIES).catch("medium"),
        category: z.enum(CATEGORIES).catch("reliability"),
        title: z.string().min(1).max(255),
        message: z.string().min(1).max(4000),
        remediation: z.string().max(8000).catch(""),
      })
    )
    .max(200),
  edits: z
    .array(
      z.object({
        startLine: z.coerce.number().int(),
        endLine: z.coerce.number().int(),
        replacement: z.string(),
      })
    )
    .max(200),
});

type ChunkResponse = z.infer<typeof chunkResponse>;

export interface AiConfig {
  apiKey: string;
  model: string;
}

export function getAiConfig(): AiConfig | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const model = process.env.GEMINI_MODEL?.trim();
  if (!apiKey || !model) return null;
  return { apiKey, model };
}

const numberEnv = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

// ---------------------------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------------------------

export interface Chunk {
  startLine: number;
  endLine: number;
}

const estimateTokens = (text: string) => Math.ceil(text.length / 3.5) + 1;

/** Splits lines into token-budgeted chunks, preferring to cut at blank lines. */
export function chunkLines(lines: string[], budgetTokens: number): Chunk[] {
  const chunks: Chunk[] = [];
  let start = 0;
  while (start < lines.length) {
    let tokens = 0;
    let end = start;
    let lastBlank = -1;
    while (end < lines.length) {
      const t = estimateTokens(lines[end]) + 2;
      if (tokens + t > budgetTokens && end > start) break;
      tokens += t;
      if (lines[end].trim() === "") lastBlank = end;
      end++;
    }
    // Cut at a blank line in the last 25% of the chunk to keep functions together.
    if (end < lines.length && lastBlank > start + Math.floor((end - start) * 0.75)) end = lastBlank + 1;
    chunks.push({ startLine: start + 1, endLine: end });
    start = end;
  }
  return chunks;
}

// ---------------------------------------------------------------------------------------------
// Retry with exponential backoff and full jitter
// ---------------------------------------------------------------------------------------------

export class AiCallError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly attempts: number
  ) {
    super(message);
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof GoogleGenerativeAIFetchError) {
    const status = err.status ?? 0;
    return status === 408 || status === 429 || status >= 500;
  }
  if (err instanceof SchemaViolation) return true;
  if (err instanceof Error) {
    return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timed? ?out|aborted/i.test(err.message);
  }
  return false;
}

class SchemaViolation extends Error {}

export async function withBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  opts: { maxAttempts: number; baseMs: number; capMs: number; deadline: number; sleep?: (ms: number) => Promise<void> }
): Promise<{ value: T; attempts: number }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return { value: await fn(attempt), attempts: attempt };
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === opts.maxAttempts) {
        throw new AiCallError(describe(err), isRetryable(err), attempt);
      }
      const delay = Math.random() * Math.min(opts.capMs, opts.baseMs * 2 ** (attempt - 1));
      if (Date.now() + delay >= opts.deadline) throw new AiCallError(`${describe(err)} (deadline reached)`, true, attempt);
      await sleep(delay);
    }
  }
  throw new AiCallError(describe(lastError), false, opts.maxAttempts);
}

function describe(err: unknown): string {
  if (err instanceof GoogleGenerativeAIFetchError) return `AI provider HTTP ${err.status ?? "?"}: ${err.statusText ?? err.message}`;
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------------------------
// Provider call
// ---------------------------------------------------------------------------------------------

function numbered(lines: string[], chunk: Chunk): string {
  const width = String(chunk.endLine).length;
  const out: string[] = [];
  for (let n = chunk.startLine; n <= chunk.endLine; n++) out.push(`${String(n).padStart(width, " ")}| ${lines[n - 1]}`);
  return out.join("\n");
}

function buildPrompt(path: string, language: string, lines: string[], chunk: Chunk, totalLines: number, known: Finding[]): string {
  const knownList = known.length
    ? known.map((f) => `- L${f.line} ${f.ruleId} (${f.severity}): ${f.message}`).join("\n")
    : "- none";
  return `File: ${path}
Language: ${language}
Chunk: lines ${chunk.startLine}-${chunk.endLine} of ${totalLines}

Deterministic findings in this chunk:
${knownList}

Source:
${numbered(lines, chunk)}`;
}

/** Parses provider text into the validated chunk shape; tolerates stray markdown fences. */
export function parseChunkResponse(text: string): ChunkResponse {
  let body = text.trim();
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) body = fence[1];
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new SchemaViolation("AI response was not valid JSON");
  }
  const parsed = chunkResponse.safeParse(json);
  if (!parsed.success) throw new SchemaViolation(`AI response failed schema validation: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

async function callChunk(config: AiConfig, prompt: string, timeoutMs: number): Promise<ChunkResponse> {
  const model = new GoogleGenerativeAI(config.apiKey).getGenerativeModel(
    {
      model: config.model,
      systemInstruction: SYSTEM_INSTRUCTION,
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA,
      },
    },
    { timeout: timeoutMs }
  );
  const result = await model.generateContent(prompt, { signal: AbortSignal.timeout(timeoutMs) });
  const text = result.response.text();
  if (!text) throw new SchemaViolation("AI response was empty");
  return parseChunkResponse(text);
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

function aiRuleId(category: IssueCategory): string {
  const code = { security: "SEC", reliability: "REL", performance: "PERF", concurrency: "CONC", maintainability: "MNT" }[category];
  return `AI-${code}`;
}

/** Accepts edits greedily in line order, dropping any that conflict with an already-accepted edit. */
export function selectEdits(edits: LineEdit[], lineCount: number): { accepted: LineEdit[]; dropped: number } {
  const sorted = [...edits].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const accepted: LineEdit[] = [];
  let lastEnd = 0;
  for (const e of sorted) {
    const valid = e.startLine >= 1 && e.endLine >= e.startLine - 1 && e.endLine <= lineCount && e.startLine > lastEnd;
    if (!valid) continue;
    accepted.push(e);
    lastEnd = Math.max(lastEnd, e.endLine);
  }
  return { accepted, dropped: edits.length - accepted.length };
}

export interface AnalyzeOptions {
  /** Absolute epoch-ms deadline for the whole analysis (keeps serverless invocations inside maxDuration). */
  deadline?: number;
  config?: AiConfig | null;
  call?: (prompt: string, timeoutMs: number) => Promise<ChunkResponse>;
}

export async function analyzeDeep(content: string, path: string, language: string, options: AnalyzeOptions = {}): Promise<DeepAnalysis> {
  const heuristic = scanSource(content, language);
  const lines = splitLines(content);
  if (/\r?\n$/.test(content)) lines.pop();
  const totalLines = lines.length;
  const config = options.config === undefined ? getAiConfig() : options.config;

  const base: DeepAnalysis = {
    engine: "heuristic",
    findings: heuristic.findings,
    correctedContent: null,
    qualityScore: scoreFindings(heuristic.findings),
    summary: "",
    modelUsed: null,
    heuristicMs: heuristic.durationMs,
    aiMs: 0,
    coverage: { totalLines, analyzedLines: 0, chunks: 0, chunksAnalyzed: 0, complete: false },
    aiError: null,
    attempts: 0,
    droppedEdits: 0,
  };

  if (!config) {
    return { ...base, summary: `Deterministic analysis only (AI provider not configured): ${heuristic.findings.length} finding(s).` };
  }
  if (totalLines === 0) {
    return { ...base, engine: "hybrid", modelUsed: config.model, summary: "Empty file.", coverage: { ...base.coverage, complete: true } };
  }

  const chunks = chunkLines(lines, numberEnv("AETHEROPS_AI_CHUNK_TOKENS", 6000));
  const maxChunks = numberEnv("AETHEROPS_AI_MAX_CHUNKS", 8);
  const selected = chunks.slice(0, maxChunks);
  const deadline = options.deadline ?? Date.now() + numberEnv("AETHEROPS_AI_DEADLINE_MS", 55_000);
  const call = options.call ?? ((prompt: string, timeoutMs: number) => callChunk(config, prompt, timeoutMs));
  const aiStarted = performance.now();

  const results: Array<{ chunk: Chunk; response: ChunkResponse } | { chunk: Chunk; error: string }> = [];
  let attempts = 0;
  // Two chunks in flight keeps large files fast without tripping provider rate limits.
  const queue = [...selected];
  await Promise.all(
    Array.from({ length: Math.min(2, queue.length) }, async () => {
      for (let chunk = queue.shift(); chunk; chunk = queue.shift()) {
        const known = heuristic.findings.filter((f) => f.line >= chunk!.startLine && f.line <= chunk!.endLine);
        const prompt = buildPrompt(path, language, lines, chunk, totalLines, known);
        try {
          const { value, attempts: used } = await withBackoff(
            () => call(prompt, Math.max(5_000, Math.min(45_000, deadline - Date.now()))),
            { maxAttempts: 4, baseMs: 500, capMs: 8_000, deadline }
          );
          attempts += used;
          results.push({ chunk, response: value });
        } catch (err) {
          attempts += err instanceof AiCallError ? err.attempts : 1;
          results.push({ chunk, error: err instanceof Error ? err.message : String(err) });
        }
      }
    })
  );
  const aiMs = Math.round(performance.now() - aiStarted);

  const succeeded = results.filter((r): r is { chunk: Chunk; response: ChunkResponse } => "response" in r);
  const failed = results.filter((r): r is { chunk: Chunk; error: string } => "error" in r);
  if (succeeded.length === 0) {
    return { ...base, aiMs, attempts, modelUsed: config.model, aiError: failed[0]?.error ?? "AI analysis failed", summary: "AI analysis failed; deterministic findings shown." };
  }

  const aiFindings: AiFinding[] = [];
  const edits: LineEdit[] = [];
  let scoreWeight = 0;
  let scoreSum = 0;
  const summaries: string[] = [];
  for (const { chunk, response } of succeeded.sort((a, b) => a.chunk.startLine - b.chunk.startLine)) {
    const span = chunk.endLine - chunk.startLine + 1;
    scoreSum += response.qualityScore * span;
    scoreWeight += span;
    if (response.summary) summaries.push(response.summary);
    for (const issue of response.issues) {
      if (issue.line < chunk.startLine || issue.line > chunk.endLine) continue;
      const endLine = Math.min(chunk.endLine, Math.max(issue.line, issue.endLine ?? issue.line));
      const duplicate = heuristic.findings.some((h) => h.line === issue.line && h.category === issue.category);
      if (duplicate) continue;
      aiFindings.push({
        ruleId: aiRuleId(issue.category),
        title: issue.title,
        category: issue.category,
        severity: issue.severity,
        line: issue.line,
        column: 1,
        endLine,
        endColumn: (lines[endLine - 1]?.length ?? 0) + 1,
        message: issue.message,
        remediation: issue.remediation,
        source: "ai",
      });
    }
    for (const e of response.edits) {
      if (e.startLine < chunk.startLine || e.endLine > chunk.endLine) continue;
      edits.push(e);
    }
  }

  const { accepted, dropped } = selectEdits(edits, totalLines);
  let correctedContent: string | null = null;
  try {
    const patched = applyLineEdits(content, accepted);
    correctedContent = patched === content ? null : patched;
  } catch (err) {
    if (!(err instanceof PatchConflictError)) throw err;
  }

  const findings: AnyFinding[] = [...heuristic.findings, ...aiFindings].sort(compareFindings);
  const analyzedLines = succeeded.reduce((n, r) => n + (r.chunk.endLine - r.chunk.startLine + 1), 0);
  const complete = failed.length === 0 && selected.length === chunks.length;
  const notes: string[] = [];
  if (failed.length) notes.push(`${failed.length}/${selected.length} chunk(s) failed: ${failed[0].error}`);
  if (selected.length < chunks.length) notes.push(`only the first ${selected.length} of ${chunks.length} chunks were analyzed (AETHEROPS_AI_MAX_CHUNKS)`);

  return {
    engine: "hybrid",
    findings,
    correctedContent,
    qualityScore: Math.round(Math.min(scoreSum / scoreWeight, scoreFindings(heuristic.findings))),
    summary: summaries.slice(0, 2).join(" ") || `${findings.length} finding(s).`,
    modelUsed: config.model,
    heuristicMs: heuristic.durationMs,
    aiMs,
    coverage: { totalLines, analyzedLines, chunks: chunks.length, chunksAnalyzed: succeeded.length, complete },
    aiError: notes.length ? `AI coverage incomplete: ${notes.join("; ")}` : null,
    attempts,
    droppedEdits: dropped,
  };
}
