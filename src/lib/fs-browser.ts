"use client";

import ignore, { type Ignore } from "ignore";
import { describeFile, type IngestedFile } from "./ingest";
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_UPLOAD_BATCH_BYTES,
  isBinaryExtension,
  isSensitiveFile,
  looksBinary,
  normalizeRelativePath,
  shouldSkipDirectory,
} from "./policy";
import { sha256Hex } from "./text";

/**
 * Browser fallback (hosted mode): the File System Access API handle lives in the browser, so reads
 * and writes happen client-side and the server only stores hashes, content, and analysis. The same
 * ingestion policy as the server walker applies.
 */

export class ReconnectRequiredError extends Error {}

export function browserFsSupported(): boolean {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!browserFsSupported()) throw new Error("This browser does not support the File System Access API. Use Chrome or Edge.");
  return window.showDirectoryPicker!({ mode: "readwrite", id: "aetherops-workspace" });
}

export async function ensurePermission(handle: FileSystemHandle, mode: FileSystemPermissionMode): Promise<void> {
  if (!handle.queryPermission || !handle.requestPermission) return;
  if ((await handle.queryPermission({ mode })) === "granted") return;
  if ((await handle.requestPermission({ mode })) !== "granted") {
    throw new ReconnectRequiredError(`Permission to ${mode === "readwrite" ? "write to" : "read"} ${handle.name} was not granted.`);
  }
}

// ---------------------------------------------------------------------------------------------
// Handle persistence (IndexedDB) so a page reload does not orphan the linked folder
// ---------------------------------------------------------------------------------------------

const DB_NAME = "aetherops";
const STORE = "handles";

function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openStore();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function saveHandle(workspaceId: number, handle: FileSystemDirectoryHandle): Promise<void> {
  await tx("readwrite", (s) => s.put(handle, workspaceId));
}

export async function loadHandle(workspaceId: number): Promise<FileSystemDirectoryHandle | null> {
  try {
    return ((await tx("readonly", (s) => s.get(workspaceId))) as FileSystemDirectoryHandle | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function forgetHandle(workspaceId: number): Promise<void> {
  await tx("readwrite", (s) => s.delete(workspaceId)).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------------------------

export interface BrowserWalkProgress {
  discovered: number;
  currentPath: string;
}

export interface BrowserWalkResult {
  files: IngestedFile[];
  skipped: number;
  truncated: boolean;
}

async function readIgnore(dir: FileSystemDirectoryHandle): Promise<Ignore | null> {
  try {
    const file = await (await dir.getFileHandle(".gitignore")).getFile();
    return ignore().add(await file.text());
  } catch {
    return null;
  }
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export async function walkDirectoryHandle(root: FileSystemDirectoryHandle, onProgress?: (p: BrowserWalkProgress) => void): Promise<BrowserWalkResult> {
  await ensurePermission(root, "read");
  const files: IngestedFile[] = [];
  let skipped = 0;
  let truncated = false;
  const rootIgnore = await readIgnore(root);
  const stack: Array<{ dir: FileSystemDirectoryHandle; rel: string; frames: Array<{ base: string; matcher: Ignore }> }> = [
    { dir: root, rel: "", frames: rootIgnore ? [{ base: "", matcher: rootIgnore }] : [] },
  ];
  const ignored = (frames: Array<{ base: string; matcher: Ignore }>, rel: string, isDir: boolean) =>
    frames.some(({ base, matcher }) => (!base || rel.startsWith(base + "/")) && matcher.ignores((base ? rel.slice(base.length + 1) : rel) + (isDir ? "/" : "")));

  while (stack.length && !truncated) {
    const { dir, rel, frames } = stack.pop()!;
    for await (const entry of dir.values()) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.kind === "directory") {
        if (shouldSkipDirectory(entry.name) || ignored(frames, childRel, true)) {
          skipped++;
          continue;
        }
        const sub = entry as FileSystemDirectoryHandle;
        const nested = await readIgnore(sub);
        stack.push({ dir: sub, rel: childRel, frames: nested ? [...frames, { base: childRel, matcher: nested }] : frames });
        continue;
      }
      if (isSensitiveFile(entry.name) || isBinaryExtension(entry.name) || ignored(frames, childRel, false)) {
        skipped++;
        continue;
      }
      if (files.length >= MAX_FILES) {
        truncated = true;
        break;
      }
      try {
        const file = await (entry as FileSystemFileHandle).getFile();
        if (file.size > MAX_FILE_BYTES) {
          skipped++;
          continue;
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (looksBinary(bytes)) {
          skipped++;
          continue;
        }
        files.push(await describeFile(childRel, decoder.decode(bytes)));
        onProgress?.({ discovered: files.length, currentPath: childRel });
      } catch {
        // Unreadable or non-UTF-8 files are skipped rather than ingested with lossy content.
        skipped++;
      }
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, skipped, truncated };
}

/** Groups files into upload batches that stay under the serverless request-body limit. */
export function batchBySize<T extends { size: number }>(items: T[], maxBytes = MAX_UPLOAD_BATCH_BYTES): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const cost = item.size * 1.2 + 512; // JSON escaping and field overhead
    if (current.length && bytes + cost > maxBytes) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

async function resolveFileHandle(root: FileSystemDirectoryHandle, relPath: string): Promise<{ parent: FileSystemDirectoryHandle; name: string }> {
  const rel = normalizeRelativePath(relPath);
  if (!rel) throw new Error(`Unsafe path: ${relPath}`);
  const parts = rel.split("/");
  const name = parts.pop()!;
  let parent = root;
  for (const part of parts) parent = await parent.getDirectoryHandle(part);
  return { parent, name };
}

/** Hash-guarded write: refuses if the file drifted since analysis, verifies the bytes after closing. */
export async function writeFileViaHandle(root: FileSystemDirectoryHandle, relPath: string, content: string, expectedHash: string): Promise<string> {
  await ensurePermission(root, "readwrite");
  const { parent, name } = await resolveFileHandle(root, relPath);
  const handle = await parent.getFileHandle(name); // no { create: true }: never resurrect deleted files
  const current = decoder.decode(new Uint8Array(await (await handle.getFile()).arrayBuffer()));
  if ((await sha256Hex(current)) !== expectedHash) {
    throw new Error(`${relPath} changed on disk since it was analyzed. Re-sync the workspace before committing.`);
  }
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    await writable.write(content);
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => undefined);
    throw err;
  }
  const written = decoder.decode(new Uint8Array(await (await handle.getFile()).arrayBuffer()));
  const writtenHash = await sha256Hex(written);
  if (writtenHash !== (await sha256Hex(content))) throw new Error(`Post-write verification failed for ${relPath}`);
  return writtenHash;
}

export async function deleteFileViaHandle(root: FileSystemDirectoryHandle, relPath: string): Promise<void> {
  await ensurePermission(root, "readwrite");
  const { parent, name } = await resolveFileHandle(root, relPath);
  try {
    await parent.removeEntry(name);
  } catch (err) {
    if ((err as DOMException)?.name !== "NotFoundError") throw err;
  }
}
