import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the project root so a lockfile in a parent directory is never mistaken for the workspace root.
  turbopack: { root: path.resolve(__dirname) },
  // PGlite ships a WASM Postgres build that must be loaded by Node at runtime, not bundled.
  serverExternalPackages: ["@electric-sql/pglite"],
  poweredByHeader: false,
};

export default nextConfig;
