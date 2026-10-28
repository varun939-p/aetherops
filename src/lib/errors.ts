export type ErrorCode =
  | "VALIDATION_FAILED"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "FORBIDDEN_ORIGIN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "STALE_CONTENT"
  | "DISK_DRIFT"
  | "ANALYSIS_IN_PROGRESS"
  | "PATCH_UNAVAILABLE"
  | "PATH_OUTSIDE_WORKSPACE"
  | "SERVER_FS_DISABLED"
  | "INTEGRITY_FAILED"
  | "PAYLOAD_TOO_LARGE"
  | "DB_NOT_CONFIGURED"
  | "DB_UNAVAILABLE"
  | "SCHEMA_NOT_MIGRATED"
  | "INTERNAL";

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what: string) => new AppError(404, "NOT_FOUND", `${what} not found`);
