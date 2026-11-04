import { Database } from "./db.js";
import { readServiceConfig } from "./config.js";
import type { RuntimeEnv } from "./runtime.js";

export function readNodeEnv(
  input: Record<string, string | undefined> = process.env,
): RuntimeEnv {
  for (const name of [
    "DATABASE_URL",
    "ACCESS_TOKEN",
    "OPENAI_API_KEY",
  ] as const) {
    if (!input[name]?.trim()) throw new Error(`${name} is required`);
  }
  readServiceConfig(input.MEMOIA_CONFIG);
  return {
    DATABASE_URL: input.DATABASE_URL,
    ACCESS_TOKEN: input.ACCESS_TOKEN,
    OPENAI_API_KEY: input.OPENAI_API_KEY!,
    OPENAI_BASE_URL: input.OPENAI_BASE_URL,
    EMBEDDING_API_KEY: input.EMBEDDING_API_KEY,
    EMBEDDING_BASE_URL: input.EMBEDDING_BASE_URL,
    PROJECT_ID: input.PROJECT_ID,
    ADMIN_URL: input.ADMIN_URL,
    ADMIN_TOKEN: input.ADMIN_TOKEN,
    MEMOIA_CONFIG: input.MEMOIA_CONFIG,
    MAINTENANCE_ENABLED: input.MAINTENANCE_ENABLED ?? "true",
    MEMOIA_WRITES_ENABLED: input.MEMOIA_WRITES_ENABLED ?? "true",
  };
}

export function createNodeDatabase(env: RuntimeEnv): Database {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  return new Database(env.DATABASE_URL, { maxConnections: 8 });
}
