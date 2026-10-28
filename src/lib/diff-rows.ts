import { diffArrays } from "diff";
import { splitLines } from "./text";

export type DiffKind = "ctx" | "add" | "del" | "gap";

export interface UnifiedRow {
  kind: DiffKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
  /** For gap rows: number of hidden unchanged lines. */
  hidden?: number;
}

export interface SplitRow {
  kind: "ctx" | "change" | "gap";
  left: { no: number; text: string; changed: boolean } | null;
  right: { no: number; text: string; changed: boolean } | null;
  hidden?: number;
}

export interface DiffModel {
  unified: UnifiedRow[];
  split: SplitRow[];
  added: number;
  removed: number;
}

function linesOf(content: string): string[] {
  const lines = splitLines(content);
  if (/\r?\n$/.test(content)) lines.pop();
  return lines;
}

/** Line diff with unchanged regions collapsed to `context` lines around each hunk. */
export function buildDiff(before: string, after: string, context = 3): DiffModel {
  const parts = diffArrays(linesOf(before), linesOf(after));
  const full: UnifiedRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  let added = 0;
  let removed = 0;
  for (const part of parts) {
    for (const text of part.value) {
      if (part.added) {
        full.push({ kind: "add", oldNo: null, newNo: newNo++, text });
        added++;
      } else if (part.removed) {
        full.push({ kind: "del", oldNo: oldNo++, newNo: null, text });
        removed++;
      } else full.push({ kind: "ctx", oldNo: oldNo++, newNo: newNo++, text });
    }
  }

  const keep = new Array<boolean>(full.length).fill(false);
  full.forEach((row, i) => {
    if (row.kind === "ctx") return;
    for (let j = Math.max(0, i - context); j <= Math.min(full.length - 1, i + context); j++) keep[j] = true;
  });
  const unified: UnifiedRow[] = [];
  for (let i = 0; i < full.length; ) {
    if (keep[i]) {
      unified.push(full[i++]);
      continue;
    }
    let j = i;
    while (j < full.length && !keep[j]) j++;
    unified.push({ kind: "gap", oldNo: full[i].oldNo, newNo: full[i].newNo, text: "", hidden: j - i });
    i = j;
  }

  const split: SplitRow[] = [];
  for (let i = 0; i < unified.length; ) {
    const row = unified[i];
    if (row.kind === "gap") {
      split.push({ kind: "gap", left: null, right: null, hidden: row.hidden });
      i++;
    } else if (row.kind === "ctx") {
      split.push({ kind: "ctx", left: { no: row.oldNo!, text: row.text, changed: false }, right: { no: row.newNo!, text: row.text, changed: false } });
      i++;
    } else {
      const dels: UnifiedRow[] = [];
      const adds: UnifiedRow[] = [];
      while (i < unified.length && unified[i].kind === "del") dels.push(unified[i++]);
      while (i < unified.length && unified[i].kind === "add") adds.push(unified[i++]);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
        const d = dels[k];
        const a = adds[k];
        split.push({
          kind: "change",
          left: d ? { no: d.oldNo!, text: d.text, changed: true } : null,
          right: a ? { no: a.newNo!, text: a.text, changed: true } : null,
        });
      }
    }
  }
  return { unified, split, added, removed };
}
