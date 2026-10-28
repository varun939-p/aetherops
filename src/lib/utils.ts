export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

const integer = new Intl.NumberFormat("en-US");

export function formatInt(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : integer.format(n);
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export interface FuzzyMatch {
  score: number;
  /** Indices in the candidate string that matched the query, for highlighting. */
  positions: number[];
}

/**
 * Subsequence fuzzy match scored for file paths: consecutive runs, matches at segment starts
 * (after `/`, `.`, `_`, `-`) and matches in the basename rank higher.
 */
export function fuzzyMatch(query: string, candidate: string): FuzzyMatch | null {
  if (!query) return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  const baseStart = c.lastIndexOf("/") + 1;
  const positions: number[] = [];
  let score = 0;
  let qi = 0;
  let prev = -2;
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] !== q[qi]) continue;
    positions.push(ci);
    let s = 1;
    if (ci === prev + 1) s += 4;
    if (ci === 0 || "/._-".includes(c[ci - 1])) s += 3;
    if (ci >= baseStart) s += 2;
    score += s;
    prev = ci;
    qi++;
  }
  if (qi < q.length) return null;
  return { score: score - (c.length - baseStart) * 0.01, positions };
}
