import { handle, ok } from "@/lib/api";
import { systemStatus } from "@/server/workspaces";

export const runtime = "nodejs";

/** Engine health: database connectivity/migration state, AI provider, and filesystem mode. Never throws for DB errors. */
export const GET = handle(async () => ok(await systemStatus()));
