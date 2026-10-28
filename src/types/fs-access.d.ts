// File System Access API members that are not yet part of TypeScript's lib.dom.
export {};

declare global {
  type FileSystemPermissionMode = "read" | "readwrite";

  interface FileSystemHandle {
    queryPermission?(descriptor: { mode: FileSystemPermissionMode }): Promise<PermissionState>;
    requestPermission?(descriptor: { mode: FileSystemPermissionMode }): Promise<PermissionState>;
  }

  interface Window {
    showDirectoryPicker?(options?: { mode?: FileSystemPermissionMode; id?: string }): Promise<FileSystemDirectoryHandle>;
  }
}
