import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { assertLocalRequest, assertSameOrigin } from "@/lib/api";

const req = (host: string, origin?: string) =>
  new NextRequest(`http://${host}/api/commit`, { method: "POST", headers: { host, ...(origin ? { origin } : {}) } });

test("loopback and *.localhost hosts may reach filesystem endpoints", () => {
  for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "3000.localhost"]) {
    assert.doesNotThrow(() => assertLocalRequest(req(host)), host);
  }
  for (const host of ["attacker.example:3000", "localhost.attacker.example", "192.168.1.5:3000"]) {
    assert.throws(() => assertLocalRequest(req(host)), /only served on localhost/, host);
  }
});

test("cross-origin mutations are rejected; same-origin and non-browser clients pass", () => {
  assert.doesNotThrow(() => assertSameOrigin(req("127.0.0.1:3000", "http://127.0.0.1:3000")));
  assert.doesNotThrow(() => assertSameOrigin(req("127.0.0.1:3000")));
  assert.throws(() => assertSameOrigin(req("127.0.0.1:3000", "https://evil.example")), /Cross-origin/);
});
