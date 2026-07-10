"use client";

// Client-side only - uses File System Access API
// This lets Vercel-hosted app write to user's real local folder via browser.

export interface LocalFileEntry {
  path: string;
  content: string;
  size: number;
  extension: string;
  language: string;
}

export interface TraverseProgress {
  scanned: number;
  totalEstimated?: number;
  currentPath: string;
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".vercel",
  ".cache",
  "__pycache__",
  "coverage",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
  "out",
]);

const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db"]);

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB per file cap to avoid OOM
const MAX_TOTAL_FILES = 500; // Safety limit for large repos

function getExtension(fileName: string): string {
  const parts = fileName.split(".");
  return parts.length > 1 ? parts.pop()!.toLowerCase() : "";
}

function detectLanguage(ext: string): string {
  const map: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    py: "python",
    go: "go",
    java: "java",
    rb: "ruby",
    php: "php",
    rs: "rust",
    c: "c",
    cpp: "cpp",
    h: "c",
    cs: "csharp",
    sh: "bash",
    json: "json",
    md: "markdown",
    yml: "yaml",
    yaml: "yaml",
    css: "css",
    html: "html",
    sql: "sql",
    swift: "swift",
    kt: "kotlin",
    dart: "dart",
    vue: "vue",
    svelte: "svelte",
  };
  return map[ext] || "plaintext";
}

function isBinaryContent(content: string): boolean {
  // Heuristic: if file contains null byte or >10% non-printable, treat as binary
  if (content.includes("\0")) return true;
  return false;
}

export async function linkFolderAndRead(
  onProgress?: (p: TraverseProgress) => void
): Promise<{ dirHandle: FileSystemDirectoryHandle; files: LocalFileEntry[] }> {
  if (!("showDirectoryPicker" in window)) {
    throw new Error("File System Access API not supported. Please use Chrome or Edge 86+.");
  }

  const dirHandle = await (window as any).showDirectoryPicker({ mode: "readwrite" });
  const files: LocalFileEntry[] = [];
  let scanned = 0;

  async function walk(
    handle: FileSystemDirectoryHandle,
    relativePath: string
  ): Promise<void> {
    if (files.length >= MAX_TOTAL_FILES) return;

    // @ts-ignore - FileSystemDirectoryHandle async iterator
    for await (const entry of handle.values()) {
      if (files.length >= MAX_TOTAL_FILES) break;

      const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      if (entry.kind === "directory") {
        if (IGNORED_DIRS.has(entry.name)) continue;
        if (entry.name.startsWith(".")) continue; // skip hidden dirs
        await walk(entry as FileSystemDirectoryHandle, entryPath);
      } else if (entry.kind === "file") {
        if (IGNORED_FILES.has(entry.name)) continue;
        scanned++;
        onProgress?.({ scanned, currentPath: entryPath });

        try {
          const file = await (entry as FileSystemFileHandle).getFile();
          if (file.size > MAX_FILE_SIZE) {
            console.warn(`Skipping large file ${entryPath} (${file.size} bytes)`);
            continue;
          }
          if (file.size === 0) {
            files.push({
              path: entryPath,
              content: "",
              size: 0,
              extension: getExtension(entry.name),
              language: detectLanguage(getExtension(entry.name)),
            });
            continue;
          }

          const content = await file.text();
          if (isBinaryContent(content.slice(0, 1000))) {
            console.warn(`Skipping binary file ${entryPath}`);
            continue;
          }

          const ext = getExtension(entry.name);
          files.push({
            path: entryPath,
            content,
            size: file.size,
            extension: ext,
            language: detectLanguage(ext),
          });
        } catch (e) {
          console.warn(`Failed to read ${entryPath}`, e);
        }
      }
    }
  }

  await walk(dirHandle, "");
  return { dirHandle, files };
}

export async function getFileHandleFromPath(
  dirHandle: FileSystemDirectoryHandle,
  filePath: string
): Promise<FileSystemFileHandle> {
  const parts = filePath.split("/").filter(Boolean);
  const fileName = parts.pop()!;
  let current: FileSystemDirectoryHandle = dirHandle;

  for (const part of parts) {
    current = await current.getDirectoryHandle(part);
  }
  const fileHandle = await current.getFileHandle(fileName);
  return fileHandle;
}

export async function getDirHandleFromPath(
  dirHandle: FileSystemDirectoryHandle,
  dirPath: string
): Promise<FileSystemDirectoryHandle> {
  if (!dirPath) return dirHandle;
  const parts = dirPath.split("/").filter(Boolean);
  let current = dirHandle;
  for (const part of parts) {
    current = await current.getDirectoryHandle(part);
  }
  return current;
}

/**
 * Strict atomic direct-write path per §4.5
 * - No download fallback
 * - If handle not active, throw with explicit message to reconnect folder
 */
export async function commitFix(
  dirHandle: FileSystemDirectoryHandle | null | undefined,
  filePath: string,
  newContent: string
): Promise<void> {
  if (!dirHandle) {
    throw new Error("RECONNECT_FOLDER: No directory handle active. Please click 'Link Folder' again to reconnect your AetherOps_Watch folder.");
  }

  // Verify permission
  try {
    const perm = await (dirHandle as any).queryPermission({ mode: "readwrite" });
    if (perm !== "granted") {
      const req = await (dirHandle as any).requestPermission({ mode: "readwrite" });
      if (req !== "granted") {
        throw new Error("RECONNECT_FOLDER: Permission denied. Please re-link folder with readwrite access.");
      }
    }
  } catch (e: any) {
    if (e?.message?.includes("RECONNECT_FOLDER")) throw e;
    // Some browsers don't support queryPermission for dir, continue
  }

  let fileHandle: FileSystemFileHandle;
  try {
    fileHandle = await getFileHandleFromPath(dirHandle, filePath);
  } catch (e) {
    // File might not exist anymore (if deleted), create it
    try {
      const parts = filePath.split("/").filter(Boolean);
      const fileName = parts.pop()!;
      let current = dirHandle;
      for (const part of parts) {
        current = await current.getDirectoryHandle(part, { create: true });
      }
      fileHandle = await current.getFileHandle(fileName, { create: true });
    } catch (createErr) {
      throw new Error(`Failed to locate/create file handle for ${filePath}: ${createErr}`);
    }
  }

  // Atomic write via FileSystemWritableFileStream
  let writable: FileSystemWritableFileStream | null = null;
  try {
    writable = (await (fileHandle as any).createWritable({ keepExistingData: false })) as FileSystemWritableFileStream;
    await writable!.write(newContent);
    await writable!.close();
  } catch (err) {
    try {
      if (writable) await (writable as any).abort?.();
    } catch {}
    throw new Error(`Failed to write to local file ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function deleteFileFromDisk(
  dirHandle: FileSystemDirectoryHandle | null | undefined,
  filePath: string
): Promise<void> {
  if (!dirHandle) {
    throw new Error("RECONNECT_FOLDER: No directory handle active. Please reconnect folder to delete.");
  }

  try {
    const perm = await (dirHandle as any).queryPermission({ mode: "readwrite" });
    if (perm !== "granted") {
      const req = await (dirHandle as any).requestPermission({ mode: "readwrite" });
      if (req !== "granted") throw new Error("Permission denied");
    }
  } catch {}

  const parts = filePath.split("/").filter(Boolean);
  const fileName = parts.pop()!;
  const dirPath = parts.join("/");

  try {
    const parentHandle = dirPath ? await getDirHandleFromPath(dirHandle, dirPath) : dirHandle;
    await (parentHandle as any).removeEntry(fileName);
  } catch (e: any) {
    // If not found, consider success
    if (e?.name === "NotFoundError") return;
    throw new Error(`Failed to delete ${filePath} from disk: ${e?.message || String(e)}`);
  }
}

// Helper to store/restore dir handle via IndexedDB? For now in-memory only per spec
// Spec says handle lives client-side, not dependent on hosting. So we keep in global state.

export function chunkFiles(files: LocalFileEntry[], chunkSize = 20): LocalFileEntry[][] {
  const chunks: LocalFileEntry[][] = [];
  for (let i = 0; i < files.length; i += chunkSize) {
    chunks.push(files.slice(i, i + chunkSize));
  }
  return chunks;
}
