import { mkdirSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "drizzle-kit";

// drizzle-kit does not read .env on its own.
try {
  process.loadEnvFile(".env");
} catch {
  // No .env file: rely on the process environment.
}

const url = process.env.DATABASE_URL ?? "";
const PGLITE_PREFIX = "pglite:";
const pgliteDir = path.resolve(url.slice(PGLITE_PREFIX.length) || ".data/pglite");
if (url.startsWith(PGLITE_PREFIX)) mkdirSync(path.dirname(pgliteDir), { recursive: true });

export default url.startsWith(PGLITE_PREFIX)
  ? defineConfig({
      schema: "./src/db/schema.ts",
      out: "./drizzle",
      dialect: "postgresql",
      driver: "pglite",
      dbCredentials: { url: pgliteDir },
      strict: true,
      verbose: true,
    })
  : defineConfig({
      schema: "./src/db/schema.ts",
      out: "./drizzle",
      dialect: "postgresql",
      dbCredentials: { url },
      strict: true,
      verbose: true,
    });
