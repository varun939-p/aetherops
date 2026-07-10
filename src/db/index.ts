import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

declare global {
  var __pgPool: Pool | undefined;
  var __drizzleDb: ReturnType<typeof drizzle<typeof schema>> | undefined;
}

function getPool() {
  if (globalThis.__pgPool) return globalThis.__pgPool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Please set it in .env");
  }
  const pool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  pool.on("error", (err) => {
    console.error("Unexpected PG pool error", err);
  });
  globalThis.__pgPool = pool;
  return pool;
}

function getDb() {
  if (globalThis.__drizzleDb) return globalThis.__drizzleDb;
  const pool = getPool();
  const db = drizzle(pool, { schema });
  globalThis.__drizzleDb = db;
  return db;
}

export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_, prop) {
    const instance = getDb();
    const value = (instance as any)[prop];
    if (typeof value === "function") {
      return value.bind(instance);
    }
    return value;
  },
});

// Helper to ensure connection works
export async function testConnection(): Promise<boolean> {
  try {
    const pool = getPool();
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    return true;
  } catch (e) {
    console.error("DB connection failed", e);
    return false;
  }
}

export { schema };
