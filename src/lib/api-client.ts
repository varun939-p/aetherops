"use client";

import type { BatchEvent } from "./contracts";

/** Client side of the `{ ok, data, meta, error }` contract. */

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

interface WireEnvelope<T> {
  ok: boolean;
  data: T | null;
  meta?: Record<string, unknown>;
  error: { code: string; message: string; details?: unknown } | null;
}

export async function api<T>(url: string, init: RequestInit & { json?: unknown; timeoutMs?: number } = {}): Promise<T> {
  const { json, timeoutMs = 30_000, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
      signal: rest.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    throw new ApiClientError(0, timedOut ? "TIMEOUT" : "NETWORK", timedOut ? `Request timed out after ${timeoutMs} ms` : "Network request failed");
  }
  let body: WireEnvelope<T>;
  try {
    body = (await res.json()) as WireEnvelope<T>;
  } catch {
    throw new ApiClientError(res.status, "BAD_RESPONSE", `Unexpected ${res.status} response from ${url}`);
  }
  if (!body.ok || body.error) {
    throw new ApiClientError(res.status, body.error?.code ?? "UNKNOWN", body.error?.message ?? "Request failed", body.error?.details);
  }
  return body.data as T;
}

export const swrFetcher = <T>(url: string) => api<T>(url, { timeoutMs: 15_000 });

/** Reads an NDJSON stream of batch events. */
export async function streamBatch(body: unknown, onEvent: (e: BatchEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const env = (await res.json().catch(() => null)) as WireEnvelope<unknown> | null;
    throw new ApiClientError(res.status, env?.error?.code ?? "UNKNOWN", env?.error?.message ?? `Batch scan failed (${res.status})`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as BatchEvent);
    }
  }
  if (buffer.trim()) onEvent(JSON.parse(buffer) as BatchEvent);
}
