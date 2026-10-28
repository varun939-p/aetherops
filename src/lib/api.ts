import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type ZodType } from "zod";
import { DatabaseConfigError } from "@/db";
import { AppError, type ErrorCode } from "./errors";

/**
 * Server-side API plumbing: every route returns `{ ok, data, meta, error }` with a deterministic
 * HTTP status. Errors are mapped once, here.
 */

export interface ApiMeta {
  requestId: string;
  durationMs: number;
  [key: string]: unknown;
}

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export type Envelope<T> =
  | { ok: true; data: T; meta: ApiMeta; error: null }
  | { ok: false; data: null; meta: ApiMeta; error: ApiErrorBody };

class Success<T> {
  constructor(
    readonly data: T,
    readonly meta: Record<string, unknown>,
    readonly status: number
  ) {}
}

export function ok<T>(data: T, meta: Record<string, unknown> = {}, status = 200): Success<T> {
  return new Success(data, meta, status);
}

const PG_SCHEMA_CODES = new Set(["42P01", "42703", "42704", "42883"]);
const PG_CONNECTION_CODES = new Set(["28P01", "28000", "3D000", "57P01", "57P03", "08000", "08001", "08003", "08004", "08006"]);
const NET_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "EHOSTUNREACH"]);

function rootCauses(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let cur: unknown = err;
  for (let i = 0; cur && i < 5; i++) {
    chain.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return chain;
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return new AppError(400, "VALIDATION_FAILED", "Request validation failed", err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  for (const cause of rootCauses(err)) {
    if (cause instanceof AppError) return cause;
    if (cause instanceof DatabaseConfigError) return new AppError(503, "DB_NOT_CONFIGURED", cause.message);
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string") {
      if (PG_SCHEMA_CODES.has(code)) return new AppError(503, "SCHEMA_NOT_MIGRATED", "Database schema is out of date. Run `npm run db:migrate`.");
      if (PG_CONNECTION_CODES.has(code) || NET_CODES.has(code)) return new AppError(503, "DB_UNAVAILABLE", "Database is unreachable");
    }
    if (cause instanceof Error && /Connection terminated|timeout exceeded when trying to connect/i.test(cause.message)) {
      return new AppError(503, "DB_UNAVAILABLE", "Database is unreachable");
    }
  }
  return new AppError(500, "INTERNAL", "Unexpected server error");
}

function respond<T>(body: Envelope<T>, status: number): NextResponse<Envelope<T>> {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Rejects cross-site browser requests to mutating endpoints (CSRF) by comparing Origin to Host. */
export function assertSameOrigin(req: NextRequest): void {
  if (!MUTATING.has(req.method)) return;
  const origin = req.headers.get("origin");
  if (!origin) return; // non-browser clients (curl, server-to-server)
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new AppError(403, "FORBIDDEN_ORIGIN", "Malformed Origin header");
  }
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!host || originHost !== host) throw new AppError(403, "FORBIDDEN_ORIGIN", "Cross-origin request rejected");
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Server filesystem operations only answer requests addressed to a loopback host. Checking the Host
 * header also defeats DNS-rebinding attacks against the local server.
 */
export function assertLocalRequest(req: NextRequest): void {
  const host = (req.headers.get("host") ?? "").toLowerCase();
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  const trusted = (process.env.AETHEROPS_TRUSTED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  // *.localhost always resolves to loopback (RFC 6761), e.g. Pinokio's https://3000.localhost proxy.
  const loopbackName = hostname.endsWith(".localhost");
  if (!LOOPBACK.has(hostname) && !loopbackName && !trusted.includes(hostname)) {
    throw new AppError(403, "FORBIDDEN_ORIGIN", "Filesystem operations are only served on localhost (see AETHEROPS_TRUSTED_HOSTS)");
  }
}

export async function readJson<T>(req: NextRequest, schema: ZodType<T>, maxBytes = 4 * 1024 * 1024): Promise<T> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) {
    throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new AppError(413, "PAYLOAD_TOO_LARGE", `Request body exceeds ${maxBytes} bytes`);
  const text = await req.text();
  if (text.length > maxBytes) throw new AppError(413, "PAYLOAD_TOO_LARGE", `Request body exceeds ${maxBytes} bytes`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AppError(400, "VALIDATION_FAILED", "Request body is not valid JSON");
  }
  return schema.parse(json);
}

export function parseId(raw: string | null | undefined, name = "id"): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n <= 0) throw new AppError(400, "VALIDATION_FAILED", `${name} must be a positive integer`);
  return n;
}

export function requestId(): string {
  return globalThis.crypto.randomUUID().slice(0, 8);
}

type Handler<C> = (req: NextRequest, ctx: C) => Promise<Success<unknown> | Response>;

/** Wraps a route handler with timing, origin checks, and uniform error envelopes. */
export function handle<C = unknown>(fn: Handler<C>) {
  return async (req: NextRequest, ctx: C): Promise<Response> => {
    const started = performance.now();
    const rid = requestId();
    const meta = () => ({ requestId: rid, durationMs: Math.round(performance.now() - started) });
    try {
      assertSameOrigin(req);
      const result = await fn(req, ctx);
      if (result instanceof Response) return result;
      return respond({ ok: true, data: result.data, meta: { ...result.meta, ...meta() }, error: null }, result.status);
    } catch (err) {
      const appErr = toAppError(err);
      if (appErr.status >= 500) console.error(`[api ${rid}] ${req.method} ${req.nextUrl.pathname}:`, err);
      return respond({ ok: false, data: null, meta: meta(), error: { code: appErr.code, message: appErr.message, details: appErr.details } }, appErr.status);
    }
  };
}
