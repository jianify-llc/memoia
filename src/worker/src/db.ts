import pg from "pg";
import type { QueryResult, QueryResultRow } from "pg";
import { SourceError } from "./errors.js";
import { inSpan } from "./observability.js";

export function isDatabaseTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String(error.code) : "";
  return (
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "ETIMEDOUT",
      "ECONNABORTED",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "08000",
      "08001",
      "08003",
      "08006",
      "08007",
      "08P01",
      "57P01",
      "57P02",
      "57P03",
    ].includes(code) ||
    /^(Connection terminated unexpectedly|Connection terminated|Connection ended unexpectedly|Query read timeout|timeout exceeded when trying to connect)/i.test(
      error.message,
    )
  );
}

export function isRetryableDatabaseError(error: unknown): boolean {
  return isDatabaseTransportError(error) ||
    (typeof error === "object" && error !== null && "code" in error &&
      ["40001", "40P01", "55P03", "57014"].includes(String(error.code)));
}

function isConnectionLimit(error: unknown): boolean {
  return error instanceof pg.DatabaseError && error.code === "53300";
}

export class DatabaseUnavailableError extends SourceError {
  constructor() {
    super(
      "database_unavailable",
      "Database temporarily unavailable",
      503,
      true,
    );
  }
}

export interface Sql {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
}
export type UserScope = { userId: string; projectId: string };
type DatabaseOperation = "healthcheck" | "purge_expired_inputs";
export type TransactionOptions = { operation?: DatabaseOperation };

/** Owns a bounded pool; its invocation or Node process owner closes it after work drains. */
export class Database {
  private readonly pool: pg.Pool;
  private readonly active = new Set<() => void>();
  private readonly transactionTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly tracing?: Tracing;
  private vectorSchemaLookup?: Promise<string>;

  constructor(
    connectionString: string,
    options: {
      transactionTimeoutMs?: number;
      closeTimeoutMs?: number;
      maxConnections?: number;
      tracing?: Tracing;
    } = {},
  ) {
    this.transactionTimeoutMs = options.transactionTimeoutMs ?? 35_000;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    this.tracing = options.tracing;
    this.pool = new pg.Pool({
      connectionString,
      max: options.maxConnections ?? 4,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
      query_timeout: 32_000,
      lock_timeout: 5_000,
    });
    this.pool.on("error", () => {
      try {
        console.warn(
          JSON.stringify({ event: "database_idle_connection_error" }),
        );
      } catch {
        // Diagnostics must not turn a handled pool error into an uncaught error.
      }
    });
  }

  vectorSchema(): Promise<string> {
    return this.vectorSchemaLookup ??= this.query<{ schema: string }>(
      `SELECT pg_catalog.quote_ident(n.nspname) AS schema
       FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
       WHERE e.extname='vector'`,
    ).then(({ rows: [row] }) => {
      if (!row) throw new Error("PostgreSQL vector extension is missing");
      return row.schema;
    }).catch((error) => {
      this.vectorSchemaLookup = undefined;
      throw error;
    });
  }

  // Standalone statements must qualify application objects and use no session state.
  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
    operation?: DatabaseOperation,
  ): Promise<QueryResult<T>> {
    return this.withClient((client) => client.query<T>(sql, values), operation);
  }

  async transaction<T>(fn: (tx: Sql) => Promise<T>, options: TransactionOptions = {}): Promise<T> {
    return this.withClient(fn, options.operation, "BEGIN");
  }

  private async withClient<T>(
    fn: (tx: Sql) => Promise<T>,
    operation: DatabaseOperation | undefined,
    begin?: string,
  ): Promise<T> {
    let client: import("pg").PoolClient;
    try {
      client = await inSpan(
        this.tracing,
        "memoia.db.acquire",
        {
          "db.operation.name": operation,
          "db.pool.idle": this.pool.idleCount,
          "db.pool.waiting": this.pool.waitingCount,
        },
        () => this.pool.connect(),
      );
    } catch (error) {
      if (isConnectionLimit(error) || isDatabaseTransportError(error))
        throw new DatabaseUnavailableError();
      throw error;
    }
    let released = false;
    let broken = false;
    const release = (discard: boolean) => {
      if (released) return;
      released = true;
      this.active.delete(destroy);
      client.removeListener("error", onClientError);
      client.release(discard);
    };
    const destroy = () => {
      broken = true;
      release(true);
    };
    const onClientError = () => destroy();
    client.on("error", onClientError);
    this.active.add(destroy);
    const query = async <R extends QueryResultRow>(
      sql: string,
      values?: unknown[],
      phase: "begin" | "query" | "commit" | "rollback" = "query",
    ): Promise<QueryResult<R>> => {
      if (released) throw new DatabaseUnavailableError();
      try {
        return await inSpan(
          this.tracing,
          "memoia.db.query",
          { "db.operation.name": operation, "memoia.db.phase": phase },
          () => client.query<R>(sql, values),
        );
      } catch (error) {
        // A connection limit at BEGIN or a standalone probe needs no ROLLBACK.
        if (
          ((!begin || phase === "begin") && isConnectionLimit(error)) ||
          broken ||
          isDatabaseTransportError(error)
        ) {
          destroy();
          throw new DatabaseUnavailableError();
        }
        throw error;
      }
    };
    const tx: Sql = { query };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void inSpan(
          this.tracing,
          "memoia.db.deadline",
          {
            "db.operation.name": operation,
            "memoia.db.phase": begin ? "transaction" : "query",
          },
          async () => {},
        );
        const error = new DatabaseUnavailableError();
        destroy();
        reject(error);
      }, this.transactionTimeoutMs);
    });
    const work = async () => {
      if (!begin) return fn(tx);
      try {
        await query(begin, undefined, "begin");
        const result = await fn(tx);
        await query("COMMIT", undefined, "commit");
        return result;
      } catch (error) {
        if (!broken) {
          try {
            await query("ROLLBACK", undefined, "rollback");
          } catch {
            destroy();
          }
        }
        throw error;
      }
    };
    try {
      return await Promise.race([work(), deadline]);
    } finally {
      clearTimeout(timer);
      release(broken);
    }
  }

  async close(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.pool.end(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            for (const destroy of this.active) destroy();
            resolve();
          }, this.closeTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class InactiveUserError extends Error {
  constructor() {
    super("User does not exist or has been forgotten");
  }
}
export class LeaseLostError extends Error {
  constructor() {
    super("User lease is unavailable or no longer valid");
  }
}

export async function assertActive(tx: Sql, scope: UserScope): Promise<void> {
  const result = await tx.query(
    `SELECT 1 FROM memoia.users u
    WHERE u.id=$1 AND u.project_id=$2 AND NOT EXISTS (
      SELECT 1 FROM memoia.memory_user_tombstones t
      WHERE t.user_id=u.id AND t.project_id=u.project_id)`,
    [scope.userId, scope.projectId],
  );
  if (!result.rowCount) throw new InactiveUserError();
}

export function isForgottenUser(error: unknown): boolean {
  return error instanceof pg.DatabaseError && error.constraint === "memoia_user_forgotten";
}

export async function memoryVersion(db: Sql, scope: UserScope) {
  const { rows: [row] } = await db.query<{ version: string }>(
    "SELECT version FROM memoia.memory_user_states WHERE user_id=$1 AND project_id=$2",
    [scope.userId, scope.projectId],
  );
  return Number(row?.version ?? 0);
}

export async function bumpMemoryVersion(sql: Sql, scope: UserScope): Promise<number> {
  const { rows: [row] } = await sql.query<{ version: string }>(
    `INSERT INTO memoia.memory_user_states AS old (user_id,project_id,version)
     VALUES ($1,$2,1)
     ON CONFLICT (user_id,project_id) DO UPDATE SET version=old.version+1
     RETURNING version`,
    [scope.userId, scope.projectId],
  );
  return Number(row.version);
}

export const identityLockSql =
  "SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::uuid::text, 0))";

export async function lockIdentity(tx: Sql, scope: UserScope): Promise<void> {
  await tx.query(identityLockSql, [scope.projectId, scope.userId]);
}

export const USAGE_HISTORY_DAYS = 30;

export async function purgeExpiredUsage(db: Database): Promise<void> {
  await db.query(
    "DELETE FROM memoia.usage_counters WHERE expires_at<=clock_timestamp()",
  );
}

/** Approximate counters: updates and their daily/monthly expiry are atomic. */
export async function addUsage(
  tx: Sql,
  projectId: string,
  values: Record<string, number>,
): Promise<void> {
  const counters = Object.values(values);
  if (!counters.length) return;
  if (counters.some((value) => !Number.isSafeInteger(value) || value < 0))
    throw new RangeError("Invalid usage");
  await tx.query(
    `INSERT INTO memoia.usage_counters(project_id,name,period_type,period_start,value,expires_at)
     SELECT $1,c.name,p.kind,p.start_date,c.value,p.start_date+p.ttl
     FROM unnest($2::text[],$3::bigint[]) c(name,value)
     CROSS JOIN (VALUES ('day', current_date, interval '${USAGE_HISTORY_DAYS} days'),
                        ('month', date_trunc('month', current_date)::date, interval '1 month')) p(kind,start_date,ttl)
     ON CONFLICT (project_id,name,period_type,period_start) DO UPDATE
     SET value=memoia.usage_counters.value+EXCLUDED.value, expires_at=EXCLUDED.expires_at`,
    [projectId, Object.keys(values), counters],
  );
}

export async function monthlyTokenUsage(
  tx: Sql,
  projectId: string,
): Promise<number> {
  const result = await tx.query<{ total: string }>(
    `SELECT COALESCE(sum(value),0)::text AS total
    FROM memoia.usage_counters WHERE project_id=$1 AND period_type='month'
    AND period_start=date_trunc('month',current_date)::date AND expires_at>clock_timestamp()
    AND name IN ('llm_input_tokens','llm_output_tokens')`,
    [projectId],
  );
  const total = Number(result.rows[0].total);
  if (!Number.isSafeInteger(total))
    throw new RangeError("Usage exceeds safe integer range");
  return total;
}

export type BillingData = {
  tokenLeft: number | null;
  nextRefillAt: Date | null;
  projectTokenCostMonth: number;
};
/** Existing billing row takes precedence; otherwise use the project's status limit. */
export async function getBilling(
  tx: Sql,
  projectId: string,
  limits: Record<string, number>,
  freeRefill: number | null,
): Promise<BillingData> {
  const monthUsage = await monthlyTokenUsage(tx, projectId);
  if (freeRefill !== null) {
    await tx.query(
      `UPDATE memoia.billings b SET usage_left=$2,
      next_refill_at=date_trunc('month', current_timestamp)+interval '1 month'
      WHERE b.id=(SELECT billing_id FROM memoia.project_billings WHERE project_id=$1 LIMIT 1)
      AND b.next_refill_at<current_timestamp AND b.usage_left IS NOT NULL AND b.usage_left<$2`,
      [projectId, freeRefill],
    );
  }
  const billing = await tx.query<{
    usage_left: number | null;
    next_refill_at: Date | null;
  }>(
    `SELECT b.usage_left,b.next_refill_at FROM memoia.billings b JOIN memoia.project_billings p ON p.billing_id=b.id
     WHERE p.project_id=$1 LIMIT 1`,
    [projectId],
  );
  const nextMonth = new Date();
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 1);
  nextMonth.setUTCHours(0, 0, 0, 0);
  if (billing.rowCount)
    return {
      tokenLeft: billing.rows[0].usage_left,
      nextRefillAt: billing.rows[0].next_refill_at,
      projectTokenCostMonth: monthUsage,
    };
  const project = await tx.query<{ status: string }>(
    "SELECT status FROM memoia.projects WHERE project_id=$1",
    [projectId],
  );
  if (!project.rowCount) throw new Error("Project not found");
  const limit = limits[project.rows[0].status];
  if (limit === undefined) throw new Error("Invalid project status");
  return {
    tokenLeft: limit < 0 ? null : limit - monthUsage,
    nextRefillAt: nextMonth,
    projectTokenCostMonth: monthUsage,
  };
}

export async function debitBilling(
  tx: Sql,
  projectId: string,
  inputTokens: number,
  outputTokens: number,
): Promise<void> {
  if (
    ![inputTokens, outputTokens].every((n) => Number.isSafeInteger(n) && n >= 0)
  )
    throw new RangeError("Invalid usage");
  const result = await tx.query(
    `UPDATE memoia.billings SET usage_left=CASE WHEN usage_left IS NULL THEN NULL ELSE usage_left-$2 END
    WHERE id=(SELECT billing_id FROM memoia.project_billings WHERE project_id=$1 LIMIT 1)`,
    [projectId, inputTokens + outputTokens],
  );
  if (!result.rowCount) throw new Error("Billing not found");
}
