/**
 * Minimal multi-language lexer that splits source lines into code / string / comment segments.
 * Used by the heuristic engine (so rules never fire inside comments or string literals) and by the
 * viewport's syntax highlighter. Segment text always concatenates back to the original line, so
 * column offsets are preserved.
 */

export type SegmentKind = "code" | "string" | "comment";

export interface Segment {
  kind: SegmentKind;
  text: string;
}

interface StringRule {
  open: string;
  close: string;
  multiline: boolean;
  escape: boolean;
}

interface Syntax {
  line: string[];
  block: Array<[string, string]>;
  strings: StringRule[];
  regex: boolean;
}

const quote = (q: string, multiline = false, escape = true): StringRule => ({ open: q, close: q, multiline, escape });

const C_LIKE: Syntax = {
  line: ["//"],
  block: [["/*", "*/"]],
  strings: [quote('"'), quote("'")],
  regex: false,
};

const SYNTAX: Record<string, Syntax> = {
  javascript: { ...C_LIKE, strings: [quote("`", true), quote('"'), quote("'")], regex: true },
  typescript: { ...C_LIKE, strings: [quote("`", true), quote('"'), quote("'")], regex: true },
  go: { ...C_LIKE, strings: [quote("`", true, false), quote('"'), quote("'")] },
  kotlin: { ...C_LIKE, strings: [quote('"""', true, false), quote('"'), quote("'")] },
  scala: { ...C_LIKE, strings: [quote('"""', true, false), quote('"'), quote("'")] },
  swift: { ...C_LIKE, strings: [quote('"""', true), quote('"')] },
  java: { ...C_LIKE, strings: [quote('"""', true), quote('"'), quote("'")] },
  rust: C_LIKE,
  c: C_LIKE,
  cpp: C_LIKE,
  csharp: C_LIKE,
  dart: { ...C_LIKE, strings: [quote("'''", true), quote('"""', true), quote('"'), quote("'")] },
  php: { ...C_LIKE, line: ["//", "#"] },
  css: { line: [], block: [["/*", "*/"]], strings: [quote('"'), quote("'")], regex: false },
  python: {
    line: ["#"],
    block: [],
    strings: [quote('"""', true), quote("'''", true), quote('"'), quote("'")],
    regex: false,
  },
  ruby: { line: ["#"], block: [["=begin", "=end"]], strings: [quote('"'), quote("'")], regex: false },
  shell: { line: ["#"], block: [], strings: [quote('"'), quote("'", false, false)], regex: false },
  powershell: { line: ["#"], block: [["<#", "#>"]], strings: [quote('"'), quote("'", false, false)], regex: false },
  yaml: { line: ["#"], block: [], strings: [quote('"'), quote("'", false, false)], regex: false },
  toml: { line: ["#"], block: [], strings: [quote('"""', true), quote('"'), quote("'", false, false)], regex: false },
  dockerfile: { line: ["#"], block: [], strings: [quote('"'), quote("'")], regex: false },
  makefile: { line: ["#"], block: [], strings: [], regex: false },
  hcl: { line: ["#", "//"], block: [["/*", "*/"]], strings: [quote('"')], regex: false },
  sql: { line: ["--"], block: [["/*", "*/"]], strings: [quote("'"), quote('"')], regex: false },
  lua: { line: ["--"], block: [["--[[", "]]"]], strings: [quote('"'), quote("'")], regex: false },
  html: { line: [], block: [["<!--", "-->"]], strings: [], regex: false },
  xml: { line: [], block: [["<!--", "-->"]], strings: [], regex: false },
  markdown: { line: [], block: [["<!--", "-->"]], strings: [], regex: false },
  vue: { ...C_LIKE, block: [["<!--", "-->"], ["/*", "*/"]], strings: [quote("`", true), quote('"'), quote("'")] },
  svelte: { ...C_LIKE, block: [["<!--", "-->"], ["/*", "*/"]], strings: [quote("`", true), quote('"'), quote("'")] },
  json: { line: [], block: [], strings: [quote('"')], regex: false },
  graphql: { line: ["#"], block: [], strings: [quote('"""', true), quote('"')], regex: false },
  protobuf: C_LIKE,
};

const PLAIN: Syntax = { line: [], block: [], strings: [], regex: false };

export function syntaxFor(language: string): Syntax {
  return SYNTAX[language] ?? PLAIN;
}

/** Characters after which a `/` starts a regex literal rather than a division. */
const REGEX_PRECEDERS = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);

function regexAllowed(code: string): boolean {
  const trimmed = code.trimEnd();
  if (trimmed.length === 0) return true;
  if (/\b(return|typeof|case|throw|in|of|void|delete|yield|await)$/.test(trimmed)) return true;
  return REGEX_PRECEDERS.has(trimmed[trimmed.length - 1]);
}

function scanRegex(line: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      let end = i + 1;
      while (end < line.length && /[a-z]/i.test(line[end])) end++;
      return end;
    }
  }
  return -1;
}

function findClose(line: string, from: number, rule: StringRule): number {
  for (let i = from; i < line.length; i++) {
    if (rule.escape && line[i] === "\\") {
      i++;
      continue;
    }
    if (line.startsWith(rule.close, i)) return i + rule.close.length;
  }
  return -1;
}

export function lexLines(lines: string[], language: string): Segment[][] {
  const syntax = syntaxFor(language);
  const strings = [...syntax.strings].sort((a, b) => b.open.length - a.open.length);
  let blockClose: string | null = null;
  let openString: StringRule | null = null;
  const out: Segment[][] = [];

  for (const line of lines) {
    const segments: Segment[] = [];
    let code = "";
    const push = (kind: SegmentKind, text: string) => {
      if (!text) return;
      if (kind !== "code" && code) {
        segments.push({ kind: "code", text: code });
        code = "";
      }
      const last = segments[segments.length - 1];
      if (last && last.kind === kind) last.text += text;
      else segments.push({ kind, text });
    };

    let i = 0;
    while (i < line.length) {
      if (blockClose) {
        const end = line.indexOf(blockClose, i);
        if (end === -1) {
          push("comment", line.slice(i));
          i = line.length;
        } else {
          push("comment", line.slice(i, end + blockClose.length));
          i = end + blockClose.length;
          blockClose = null;
        }
        continue;
      }
      if (openString) {
        const end = findClose(line, i, openString);
        if (end === -1) {
          push("string", line.slice(i));
          i = line.length;
          if (!openString.multiline) openString = null;
        } else {
          push("string", line.slice(i, end));
          i = end;
          openString = null;
        }
        continue;
      }

      const lineComment = syntax.line.find((tok) => line.startsWith(tok, i));
      if (lineComment) {
        push("comment", line.slice(i));
        i = line.length;
        continue;
      }
      const block = syntax.block.find(([open]) => line.startsWith(open, i));
      if (block) {
        push("comment", block[0]);
        i += block[0].length;
        blockClose = block[1];
        continue;
      }
      const str = strings.find((rule) => line.startsWith(rule.open, i));
      if (str) {
        push("string", str.open);
        i += str.open.length;
        openString = str;
        continue;
      }
      if (syntax.regex && line[i] === "/" && line[i + 1] !== "/" && line[i + 1] !== "*" && regexAllowed(code || lastCode(segments))) {
        const end = scanRegex(line, i);
        if (end !== -1) {
          push("string", line.slice(i, end));
          i = end;
          continue;
        }
      }
      code += line[i];
      i++;
    }
    if (code) segments.push({ kind: "code", text: code });
    out.push(segments);
  }
  return out;
}

function lastCode(segments: Segment[]): string {
  for (let i = segments.length - 1; i >= 0; i--) if (segments[i].kind === "code") return segments[i].text;
  return "";
}

const blank = (text: string) => text.replace(/[^\t]/g, " ");

/** Line with strings and comments blanked (same length): what the program "does". */
export function codeView(segments: Segment[]): string {
  return segments.map((s) => (s.kind === "code" ? s.text : blank(s.text))).join("");
}

/** Line with only comments blanked: keeps literals for injection/secret rules. */
export function noCommentView(segments: Segment[]): string {
  return segments.map((s) => (s.kind === "comment" ? blank(s.text) : s.text)).join("");
}
