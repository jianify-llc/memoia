import pg from "pg";
import type { QueryResult, QueryResultRow } from "pg";
import { SourceError } from "./errors.js";

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
export type TransactionOptions = {
  isolation?: "read committed" | "repeatable read" | "serializable";
  readOnly?: boolean;
};

/** Owns a bounded pool; its invocation or Node process owner closes it after work drains. */
export class Database {
  private readonly pool: pg.Pool;
  private readonly active = new Set<() => void>();
  private readonly transactionTimeoutMs: number;
  private readonly closeTimeoutMs: number;

  constructor(
    connectionString: string,
    options: {
      transactionTimeoutMs?: number;
      closeTimeoutMs?: number;
      maxConnections?: number;
    } = {},
  ) {
    this.transactionTimeoutMs = options.transactionTimeoutMs ?? 35_000;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
    this.pool = new pg.Pool({
      connectionString,
      max: options.maxConnections ?? 4,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 30_000,
      query_timeout: 32_000,
      lock_timeout: 5_000,
      options: "-c search_path=memoia,extensions,public",
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

  private async configureSearchPath(client: Sql): Promise<void> {
    const result =
      await client.query(`SELECT pg_catalog.set_config('search_path',
      pg_catalog.format('memoia,%I,extensions,public', n.nspname), true)
      FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
      WHERE e.extname='vector'`);
    if (!result.rowCount)
      throw new Error("PostgreSQL vector extension is missing");
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.transaction((tx) => tx.query<T>(sql, values));
  }

  async transaction<T>(
    fn: (tx: Sql) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const isolationLevels = {
      "read committed": "READ COMMITTED",
      "repeatable read": "REPEATABLE READ",
      serializable: "SERIALIZABLE",
    } as const;
    const isolation = options.isolation && isolationLevels[options.isolation];
    if (options.isolation && !isolation)
      throw new Error("Invalid transaction isolation");
    const begin = [
      "BEGIN",
      isolation && `ISOLATION LEVEL ${isolation}`,
      options.readOnly === undefined
        ? undefined
        : options.readOnly
          ? "READ ONLY"
          : "READ WRITE",
    ]
      .filter(Boolean)
      .join(" ");
    let client: import("pg").PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      if (isDatabaseTransportError(error)) throw new DatabaseUnavailableError();
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
    const tx: Sql = {
      query: async (sql, values) => {
        if (released) throw new DatabaseUnavailableError();
        try {
          return await client.query(sql, values);
        } catch (error) {
          if (broken || isDatabaseTransportError(error)) {
            destroy();
            throw new DatabaseUnavailableError();
          }
          throw error;
        }
      },
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new DatabaseUnavailableError();
        destroy();
        reject(error);
      }, this.transactionTimeoutMs);
    });
    const work = async () => {
      try {
        await tx.query(begin);
        await this.configureSearchPath(tx);
        const result = await fn(tx);
        await tx.query("COMMIT");
        return result;
      } catch (error) {
        if (!broken) {
          try {
            await tx.query("ROLLBACK");
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

export async function lockIdentity(tx: Sql, scope: UserScope): Promise<void> {
  await tx.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::uuid::text, 0))",
    [scope.projectId, scope.userId],
  );
}

/** Serialize short user-scoped transactions with deletion and other writers. */
export async function lockUser(tx: Sql, scope: UserScope): Promise<void> {
  await lockIdentity(tx, scope);
  const result = await tx.query(
    `SELECT 1 FROM memoia.users u
    WHERE u.id=$1 AND u.project_id=$2 AND NOT EXISTS (
      SELECT 1 FROM memoia.memory_user_tombstones t
      WHERE t.user_id=u.id AND t.project_id=u.project_id) FOR UPDATE OF u`,
    [scope.userId, scope.projectId],
  );
  if (!result.rowCount) throw new InactiveUserError();
}

export type UserLease = UserScope & { generation: string; version: string };

/** Acquire or replace an expired lease. Each acquisition increments the fencing generation. */
export async function acquireUserLease(
  db: Database,
  scope: UserScope,
  ttlMs: number,
): Promise<UserLease> {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)
    throw new RangeError("Invalid lease duration");
  return db.transaction(async (tx) => {
    await lockUser(tx, scope);
    await tx.query(
      `INSERT INTO memoia.memory_user_states (user_id, project_id)
      VALUES ($1,$2) ON CONFLICT (user_id,project_id) DO NOTHING`,
      [scope.userId, scope.projectId],
    );
    const result = await tx.query<{ generation: string; version: string }>(
      `UPDATE memoia.memory_user_states
      SET generation=generation+1, writer_lease_until=clock_timestamp()+($3 * interval '1 millisecond')
      WHERE user_id=$1 AND project_id=$2 AND (writer_lease_until IS NULL OR writer_lease_until <= clock_timestamp())
      RETURNING generation, version`,
      [scope.userId, scope.projectId, ttlMs],
    );
    if (!result.rowCount) throw new LeaseLostError();
    return { ...scope, ...result.rows[0] };
  });
}

/** Validate while holding the state row lock, in the same transaction as final writes. */
export async function assertUserLease(
  tx: Sql,
  lease: UserLease,
): Promise<void> {
  await lockUser(tx, lease);
  const result = await tx.query(
    `SELECT 1 FROM memoia.memory_user_states
    WHERE user_id=$1 AND project_id=$2 AND generation=$3 AND version=$4
      AND writer_lease_until > clock_timestamp() FOR UPDATE`,
    [lease.userId, lease.projectId, lease.generation, lease.version],
  );
  if (!result.rowCount) throw new LeaseLostError();
}

export async function renewUserLease(
  db: Database,
  lease: UserLease,
  ttlMs: number,
): Promise<void> {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)
    throw new RangeError("Invalid lease duration");
  await db.transaction(async (tx) => {
    await assertUserLease(tx, lease);
    await tx.query(
      `UPDATE memoia.memory_user_states SET writer_lease_until=clock_timestamp()+($5 * interval '1 millisecond')
      WHERE user_id=$1 AND project_id=$2 AND generation=$3 AND version=$4`,
      [lease.userId, lease.projectId, lease.generation, lease.version, ttlMs],
    );
  });
}

export async function releaseUserLease(
  db: Database,
  lease: UserLease,
): Promise<void> {
  await db.transaction(async (tx) => {
    await assertUserLease(tx, lease);
    await tx.query(
      `UPDATE memoia.memory_user_states SET writer_lease_until=NULL
      WHERE user_id=$1 AND project_id=$2 AND generation=$3 AND version=$4`,
      [lease.userId, lease.projectId, lease.generation, lease.version],
    );
  });
}

/** Approximate counters: updates and their daily/monthly expiry are atomic. */
export async function addUsage(
  tx: Sql,
  projectId: string,
  values: Record<string, number>,
): Promise<void> {
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError("Invalid usage");
    await tx.query(
      `INSERT INTO memoia.usage_counters(project_id,name,period_type,period_start,value,expires_at)
      SELECT $1,$2,p.kind,p.start_date,$3,clock_timestamp()+p.ttl
      FROM (VALUES ('day', current_date, interval '14 days'),
                   ('month', date_trunc('month', current_date)::date, interval '420 days')) p(kind,start_date,ttl)
      ON CONFLICT (project_id,name,period_type,period_start) DO UPDATE
      SET value=memoia.usage_counters.value+EXCLUDED.value, expires_at=EXCLUDED.expires_at`,
      [projectId, name, value],
    );
  }
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

/** Call last in the write transaction: failure rolls back all preceding writes. */
export async function finishUserLease(
  tx: Sql,
  lease: UserLease,
): Promise<string> {
  const result = await tx.query<{ version: string }>(
    `UPDATE memoia.memory_user_states s
    SET version=s.version+1, writer_lease_until=NULL
    WHERE s.user_id=$1 AND s.project_id=$2 AND s.generation=$3 AND s.version=$4
      AND s.writer_lease_until>clock_timestamp()
      AND EXISTS (SELECT 1 FROM memoia.users u WHERE u.id=s.user_id AND u.project_id=s.project_id)
      AND NOT EXISTS (SELECT 1 FROM memoia.memory_user_tombstones t
        WHERE t.user_id=s.user_id AND t.project_id=s.project_id)
    RETURNING version`,
    [lease.userId, lease.projectId, lease.generation, lease.version],
  );
  if (!result.rowCount) throw new LeaseLostError();
  return result.rows[0].version;
}
