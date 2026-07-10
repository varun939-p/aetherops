export function cn(...classes: (string | boolean | undefined | null)[]) {
  return classes.filter(Boolean).join(" ");
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export function getFileNameFromPath(path: string): string {
  return path.split("/").pop() || path;
}

export function getDirFromPath(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/") || "/";
}

export function debounce<T extends (...args: any[]) => any>(fn: T, ms: number): T {
  let timer: NodeJS.Timeout;
  return ((...args: any[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}
