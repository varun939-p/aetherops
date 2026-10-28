/** Isomorphic text utilities shared by ingestion, analysis, patching, and the viewport. */

export type Eol = "lf" | "crlf";

export function detectEol(content: string): Eol {
  const crlf = content.match(/\r\n/g)?.length ?? 0;
  const lf = (content.match(/\n/g)?.length ?? 0) - crlf;
  return crlf > lf ? "crlf" : "lf";
}

export function eolString(eol: Eol): string {
  return eol === "crlf" ? "\r\n" : "\n";
}

export function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

export function countLines(content: string): number {
  if (content.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < content.length; i++) if (content.charCodeAt(i) === 10) n++;
  return content.endsWith("\n") ? n - 1 : n;
}

/** SHA-256 over the UTF-8 encoding. Uses Web Crypto, available in browsers and Node 20+. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export interface LineEdit {
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. `endLine = startLine - 1` inserts before startLine without replacing. */
  endLine: number;
  /** Replacement lines joined by "\n"; an empty string deletes the range. */
  replacement: string;
}

export class PatchConflictError extends Error {}

/**
 * Applies non-overlapping line-range edits to `content`, preserving its line ending style
 * and trailing-newline state. Throws PatchConflictError on out-of-range or overlapping edits.
 */
export function applyLineEdits(content: string, edits: LineEdit[]): string {
  if (edits.length === 0) return content;
  const eol = eolString(detectEol(content));
  const hadTrailingNewline = /\r?\n$/.test(content);
  const lines = splitLines(content);
  if (hadTrailingNewline) lines.pop();

  const sorted = [...edits].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  let previousEnd = 0;
  for (const edit of sorted) {
    if (!Number.isInteger(edit.startLine) || !Number.isInteger(edit.endLine)) {
      throw new PatchConflictError("Edit line numbers must be integers");
    }
    if (edit.startLine < 1 || edit.endLine < edit.startLine - 1 || edit.endLine > lines.length) {
      throw new PatchConflictError(`Edit ${edit.startLine}-${edit.endLine} is outside 1-${lines.length}`);
    }
    if (edit.startLine <= previousEnd) {
      throw new PatchConflictError(`Edit at line ${edit.startLine} overlaps a previous edit`);
    }
    previousEnd = Math.max(previousEnd, edit.endLine);
  }

  // Apply bottom-up so earlier line numbers stay valid.
  for (const edit of [...sorted].reverse()) {
    const replacement = edit.replacement === "" ? [] : edit.replacement.replace(/\r\n/g, "\n").split("\n");
    lines.splice(edit.startLine - 1, edit.endLine - edit.startLine + 1, ...replacement);
  }
  return lines.join(eol) + (hadTrailingNewline ? eol : "");
}
