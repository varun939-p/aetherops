import path from "node:path";
import { promises as fs, type Dirent } from "node:fs";
import { randomBytes } from "node:crypto";
import ignore, { type Ignore } from "ignore";
import { AppError } from "./errors";
import { describeFile, type IngestedFile } from "./ingest";
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  isBinaryExtension,
  isSensitiveFile,
  looksBinary,
  normalizeRelativePath,
  shouldSkipDirectory,
} from "./policy";
import { sha256Hex } from "./text";

/**
 * Server-side desktop ingestion (local-first mode). Every path that reaches the filesystem is
 * resolved against an allow-listed workspace root and re-checked after symlink resolution, so
 * no API input can read or write outside it.
 */

const isWindows = process.platform === "win32";
const samePathCase = (p: string) => (isWindows ? p.toLowerCase() : p);

export interface ServerFsStatus {
  enabled: boolean;
  reason: string | null;
  allowedRoots: string[];
}

export function serverFsStatus(): ServerFsStatus {
  if (process.env.VERCEL) {
    return { enabled: false, reason: "Server filesystem access is disabled on hosted deployments; use the browser folder picker.", allowedRoots: [] };
  }
  const roots = (process.env.AETHEROPS_ALLOWED_ROOTS ?? "")
    .split(path.delimiter)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => path.resolve(r));
  if (roots.length === 0) {
    return { enabled: false, reason: "Set AETHEROPS_ALLOWED_ROOTS in .env to the directories this server may read and write.", allowedRoots: [] };
  }
  return { enabled: true, reason: null, allowedRoots: roots };
}

export function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(samePathCase(root), samePathCase(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function assertEnabled(): ServerFsStatus {
  const status = serverFsStatus();
  if (!status.enabled) throw new AppError(403, "SERVER_FS_DISABLED", status.reason ?? "Server filesystem access is disabled");
  return status;
}

/** Validates a user-supplied workspace root: absolute, existing directory, inside an allowed root. */
export async function resolveWorkspaceRoot(input: string): Promise<string> {
  const status = assertEnabled();
  if (!path.isAbsolute(input)) throw new AppError(400, "VALIDATION_FAILED", "Workspace path must be absolute");
  let real: string;
  try {
    real = await fs.realpath(path.resolve(input));
  } catch {
    throw new AppError(404, "NOT_FOUND", `Directory not found: ${input}`);
  }
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw new AppError(400, "VALIDATION_FAILED", "Workspace path is not a directory");
  const allowedReal = await Promise.all(status.allowedRoots.map((r) => fs.realpath(r).catch(() => r)));
  if (!allowedReal.some((root) => isWithin(root, real))) {
    throw new AppError(403, "PATH_OUTSIDE_WORKSPACE", "Directory is outside AETHEROPS_ALLOWED_ROOTS");
  }
  return real;
}

/**
 * Resolves a workspace-relative path to an absolute one, rejecting traversal both lexically and
 * after resolving symlinks on the deepest existing ancestor.
 */
export async function resolveInside(root: string, relPath: string): Promise<string> {
  assertEnabled();
  const rel = normalizeRelativePath(relPath);
  if (!rel) throw new AppError(400, "PATH_OUTSIDE_WORKSPACE", `Unsafe path: ${relPath}`);
  const realRoot = await fs.realpath(root);
  const target = path.resolve(realRoot, ...rel.split("/"));
  if (!isWithin(realRoot, target)) throw new AppError(403, "PATH_OUTSIDE_WORKSPACE", `Path escapes workspace: ${relPath}`);

  let probe = target;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (!isWithin(realRoot, real)) throw new AppError(403, "PATH_OUTSIDE_WORKSPACE", `Path resolves outside workspace: ${relPath}`);
      break;
    } catch (err) {
      if (err instanceof AppError) throw err;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  return target;
}

// ---------------------------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------------------------

export interface WalkSummary {
  files: IngestedFile[];
  skipped: Record<"ignored" | "sensitive" | "binary" | "tooLarge" | "nonUtf8" | "symlink" | "unreadable", number>;
  truncated: boolean;
}

interface IgnoreFrame {
  base: string;
  matcher: Ignore;
}

function isIgnored(frames: IgnoreFrame[], rel: string, isDir: boolean): boolean {
  for (const { base, matcher } of frames) {
    if (base && !rel.startsWith(base + "/")) continue;
    const local = base ? rel.slice(base.length + 1) : rel;
    if (matcher.ignores(isDir ? `${local}/` : local)) return true;
  }
  return false;
}

async function readIgnoreFile(dir: string): Promise<Ignore | null> {
  try {
    return ignore().add(await fs.readFile(path.join(dir, ".gitignore"), "utf8"));
  } catch {
    return null;
  }
}

// ignoreBOM keeps a leading BOM in the decoded string so commits round-trip the exact bytes.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

async function readTextFile(abs: string, rel: string, skipped: WalkSummary["skipped"]): Promise<IngestedFile | null> {
  try {
    const stat = await fs.stat(abs);
    if (stat.size > MAX_FILE_BYTES) {
      skipped.tooLarge++;
      return null;
    }
    const bytes = await fs.readFile(abs);
    if (looksBinary(bytes)) {
      skipped.binary++;
      return null;
    }
    let content: string;
    try {
      content = utf8.decode(bytes);
    } catch {
      // Non-UTF-8 files cannot be round-tripped safely on commit, so they are not ingested.
      skipped.nonUtf8++;
      return null;
    }
    return describeFile(rel, content);
  } catch {
    skipped.unreadable++;
    return null;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

export async function walkWorkspace(root: string, maxFiles = Number(process.env.AETHEROPS_MAX_FILES) || MAX_FILES): Promise<WalkSummary> {
  assertEnabled();
  const realRoot = await fs.realpath(root);
  const skipped: WalkSummary["skipped"] = { ignored: 0, sensitive: 0, binary: 0, tooLarge: 0, nonUtf8: 0, symlink: 0, unreadable: 0 };
  const candidates: Array<{ abs: string; rel: string }> = [];
  let truncated = false;

  const rootIgnore = await readIgnoreFile(realRoot);
  const stack: Array<{ dir: string; rel: string; frames: IgnoreFrame[] }> = [
    { dir: realRoot, rel: "", frames: rootIgnore ? [{ base: "", matcher: rootIgnore }] : [] },
  ];

  while (stack.length && !truncated) {
    const { dir, rel, frames } = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      skipped.unreadable++;
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        skipped.symlink++;
        continue;
      }
      if (entry.isDirectory()) {
        if (shouldSkipDirectory(entry.name) || isIgnored(frames, childRel, true)) {
          skipped.ignored++;
          continue;
        }
        const nested = await readIgnoreFile(abs);
        stack.push({ dir: abs, rel: childRel, frames: nested ? [...frames, { base: childRel, matcher: nested }] : frames });
        continue;
      }
      if (!entry.isFile()) continue;
      if (isSensitiveFile(entry.name)) {
        skipped.sensitive++;
        continue;
      }
      if (isBinaryExtension(entry.name)) {
        skipped.binary++;
        continue;
      }
      if (isIgnored(frames, childRel, false)) {
        skipped.ignored++;
        continue;
      }
      if (candidates.length >= maxFiles) {
        truncated = true;
        break;
      }
      candidates.push({ abs, rel: childRel });
    }
  }

  const read = await mapLimit(candidates, 16, ({ abs, rel }) => readTextFile(abs, rel, skipped));
  const files = read.filter((f): f is IngestedFile => f !== null).sort((a, b) => a.path.localeCompare(b.path));
  return { files, skipped, truncated };
}

// ---------------------------------------------------------------------------------------------
// Reads and writes
// ---------------------------------------------------------------------------------------------

export async function readWorkspaceFile(root: string, relPath: string): Promise<{ content: string; hash: string } | null> {
  const abs = await resolveInside(root, relPath);
  try {
    const content = utf8.decode(await fs.readFile(abs));
    return { content, hash: await sha256Hex(content) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Atomically replaces a file: verifies the on-disk content still matches `expectedHash`, writes a
 * sibling temp file, fsyncs, renames over the target, then re-reads and verifies the new hash.
 */
export async function writeWorkspaceFileAtomic(root: string, relPath: string, content: string, expectedHash: string): Promise<string> {
  const abs = await resolveInside(root, relPath);
  const current = await readWorkspaceFile(root, relPath);
  if (!current) throw new AppError(409, "DISK_DRIFT", `${relPath} no longer exists on disk; re-sync the workspace`);
  if (current.hash !== expectedHash) {
    throw new AppError(409, "DISK_DRIFT", `${relPath} changed on disk since it was analyzed; re-sync before committing`);
  }

  const expectedNewHash = await sha256Hex(content);
  const temp = path.join(path.dirname(abs), `.${path.basename(abs)}.aetherops-${randomBytes(6).toString("hex")}.tmp`);
  const mode = (await fs.stat(abs)).mode;
  const handle = await fs.open(temp, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temp, abs);
  } catch (err) {
    await fs.rm(temp, { force: true });
    throw err;
  }

  const written = await readWorkspaceFile(root, relPath);
  if (!written || written.hash !== expectedNewHash) {
    throw new AppError(500, "INTEGRITY_FAILED", `Post-write verification failed for ${relPath}`);
  }
  return expectedNewHash;
}

export async function deleteWorkspaceFile(root: string, relPath: string): Promise<boolean> {
  const abs = await resolveInside(root, relPath);
  try {
    await fs.unlink(abs);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
