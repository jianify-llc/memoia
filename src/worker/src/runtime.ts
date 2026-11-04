/** Workers own invocation pools; Node injects its process pool. Model waits hold no SQL transaction. */
import { Database } from "./db.js";
import { SourceError } from "./errors.js";
import { readServiceConfig } from "./config.js";

export type Wakeup =
  | { kind: "user"; user_id: string; project_id: string }
  | {
      kind: "flush";
      operation_id: string;
      user_id: string;
      project_id: string;
    };
export interface MaintenanceWakeup {
  send(message: Wakeup, delaySeconds: number): Promise<void>;
}
export interface RuntimeEnv
  extends Partial<
    Pick<CloudflareBindings, "MAINTENANCE_ENABLED" | "MEMOIA_WRITES_ENABLED">
  > {
  DATABASE_URL?: string;
  OPENAI_API_KEY: string;
  OPENAI_BASE_URL?: string;
  EMBEDDING_API_KEY?: string;
  EMBEDDING_BASE_URL?: string;
  ACCESS_TOKEN?: string;
  PROJECT_ID?: string;
  ADMIN_URL?: string;
  ADMIN_TOKEN?: string;
  MEMOIA_CONFIG?: string;
  tracing?: Tracing;
}
export interface Runtime {
  db: Database;
  ownsDatabase?: boolean;
  maintenanceWakeup?: MaintenanceWakeup;
  env: RuntimeEnv;
  deadline: number;
  signal?: AbortSignal;
  tracing?: Tracing;
  operationId?: string;
}
export function createRuntime(
  env: RuntimeEnv,
  signal?: AbortSignal,
  database?: Database,
): Runtime {
  readServiceConfig(env.MEMOIA_CONFIG);
  let db = database;
  if (!db) {
    const connection = env.DATABASE_URL;
    if (!connection)
      throw new SourceError(
        "database_unavailable",
        "Database binding is missing",
        503,
        true,
      );
    db = new Database(connection);
  }
  return {
    db,
    ownsDatabase: !database,
    env,
    signal,
    tracing: env.tracing,
    deadline: Date.now() + 780_000,
  };
}
export async function closeRuntime(runtime: Runtime): Promise<void> {
  if (runtime.ownsDatabase !== false) await runtime.db.close();
}
export function assertRunning(runtime: Runtime, reserveMs = 0): void {
  if (runtime.signal?.aborted || Date.now() + reserveMs >= runtime.deadline)
    throw new SourceError(
      "execution_deadline",
      "Execution no longer has a valid time budget",
      503,
      true,
    );
}
