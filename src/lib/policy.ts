/**
 * Ingestion policy shared by the server-side walker (fs-desktop.ts) and the browser fallback (fs-browser.ts).
 * Isomorphic: no Node or DOM imports.
 */

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_FILES = 5000;
/** Request bodies stay under Vercel's 4.5 MB limit with headroom for JSON escaping. */
export const MAX_UPLOAD_BATCH_BYTES = 3 * 1024 * 1024;

/** Directories never traversed, regardless of .gitignore. */
export const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".cache",
  ".parcel-cache",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "vendor",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".venv",
  "venv",
  "env",
  ".idea",
  ".vscode",
  ".gradle",
  ".terraform",
  ".data",
]);

/** Hidden directories that still hold reviewable code. */
const ALLOWED_HIDDEN_DIRS = new Set([".github", ".circleci", ".gitlab"]);

const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "tif", "tiff", "avif", "heic", "psd",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt",
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar", "jar", "war", "whl", "egg",
  "exe", "dll", "so", "dylib", "bin", "o", "a", "lib", "obj", "class", "pyc", "pyo", "wasm", "node",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "wav", "ogg", "flac", "mov", "avi", "mkv", "webm",
  "sqlite", "sqlite3", "db", "mdb", "parquet", "pkl", "pt", "onnx", "safetensors", "ckpt",
  "lock", "map",
]);

const SENSITIVE_NAMES = new Set([
  ".npmrc", ".pypirc", ".netrc", ".git-credentials", ".htpasswd",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
  "credentials", "credentials.json", "service-account.json",
]);
const SENSITIVE_EXTENSIONS = new Set(["pem", "key", "p12", "pfx", "jks", "keystore", "kdbx", "asc", "gpg"]);
const ENV_TEMPLATE_SUFFIXES = new Set(["example", "sample", "template", "dist"]);

export function shouldSkipDirectory(name: string): boolean {
  if (IGNORED_DIRS.has(name)) return true;
  return name.startsWith(".") && !ALLOWED_HIDDEN_DIRS.has(name);
}

/** Files that may contain credentials are never ingested, stored, or sent to an AI provider. */
export function isSensitiveFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (SENSITIVE_NAMES.has(lower)) return true;
  if (lower === ".env" || lower.startsWith(".env.")) {
    const suffix = lower.slice(".env.".length);
    return !ENV_TEMPLATE_SUFFIXES.has(suffix);
  }
  return SENSITIVE_EXTENSIONS.has(extensionOf(lower));
}

export function isBinaryExtension(name: string): boolean {
  return BINARY_EXTENSIONS.has(extensionOf(name));
}

/** Null bytes in the leading window are the same signal git uses to classify binary blobs. */
export function looksBinary(sample: Uint8Array): boolean {
  const limit = Math.min(sample.length, 8000);
  for (let i = 0; i < limit; i++) if (sample[i] === 0) return true;
  return false;
}

export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  py: "python", pyi: "python",
  go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", scala: "scala",
  c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp",
  rb: "ruby", php: "php", swift: "swift", dart: "dart", lua: "lua",
  sh: "shell", bash: "shell", zsh: "shell", ps1: "powershell",
  sql: "sql", json: "json", yml: "yaml", yaml: "yaml", toml: "toml", xml: "xml",
  html: "html", htm: "html", vue: "vue", svelte: "svelte",
  css: "css", scss: "css", less: "css", md: "markdown", mdx: "markdown",
  dockerfile: "dockerfile", tf: "hcl", hcl: "hcl", graphql: "graphql", proto: "protobuf",
};

export function detectLanguage(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  if (base === "makefile") return "makefile";
  return LANGUAGE_BY_EXTENSION[extensionOf(base)] ?? "plaintext";
}

/**
 * Validates a workspace-relative path: POSIX separators, no absolute roots, no traversal segments.
 * Returns the normalized path or null when it is unsafe.
 */
export function normalizeRelativePath(input: string): string | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 1024) return null;
  if (input.includes("\0")) return null;
  const unified = input.replace(/\\/g, "/");
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) return null;
  const parts = unified.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0 || parts.some((p) => p === "..")) return null;
  return parts.join("/");
}
