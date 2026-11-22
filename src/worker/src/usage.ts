import {
  type Database,
  isDatabaseTransportError,
  type UserScope,
} from "./db.js";
import type { Runtime } from "./runtime.js";

type MeteredUsage = {
  kind: "fact_extraction" | "agent_loop" | "embedding";
  provider: "openai" | "jina" | "ollama";
  model: string | null;
  service_tier: string | null;
  usage_valid?: boolean;
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens?: number | null;
  cache_write_tokens?: number | null;
  cache_write_30m_tokens?: number | null;
  cache_write_12h_tokens?: number | null;
};

type UsageEventRow = {
  id: string;
  user_id: string;
  recorded_at: Date;
  occurred_at: Date;
  usage: MeteredUsage;
};

export async function writeUsageEvent(
  db: Pick<Database, "query">,
  scope: UserScope,
  occurredAt: Date,
  usage: MeteredUsage,
): Promise<void> {
  const id = crypto.randomUUID();
  const values = [
    scope.projectId,
    scope.userId,
    occurredAt,
    JSON.stringify(usage),
    id,
  ];
  const statement = `INSERT INTO memoia.usage_events (project_id, user_id, occurred_at, usage, id)
     SELECT project_id, id, $3, $4, $5 FROM memoia.users
     WHERE project_id=$1 AND id=$2 FOR KEY SHARE
     ON CONFLICT (id) DO NOTHING`;
  try {
    await db.query(statement, values);
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code !== "database_unavailable" && !isDatabaseTransportError(error))
      throw error;
    // A disconnected COMMIT can already have written this receipt.
    await db.query(statement, values);
  }
}

export async function listUsageEvents(
  runtime: Runtime,
  projectId: string,
  date: string,
  limit: number,
  userId?: string,
  after?: { time: string; id: string },
) {
  const start = new Date(`${date}T00:00:00Z`);
  const end = new Date(start.getTime() + 86_400_000);
  const params: unknown[] = [projectId, start, end, limit + 1];
  let scope = "project_id=$1";
  if (userId) {
    params.push(userId);
    scope += ` AND user_id=$${params.length}`;
  }
  let where = `${scope} AND recorded_at >= $2 AND recorded_at < $3`;
  if (after) {
    const count = params.length;
    params.push(after.time, after.id);
    where += ` AND (recorded_at, id) > ($${count + 1}, $${count + 2})`;
  }
  const page = `SELECT id, user_id, recorded_at, occurred_at, usage FROM memoia.usage_events
     WHERE ${where} ORDER BY recorded_at, id LIMIT $4`;
  // The left join keeps the scope's first date available even when this day is empty.
  const result = await runtime.db.query<
    (UsageEventRow | { id: null }) & { first_recorded_at?: Date | null }
  >(
    after
      ? page
      : `SELECT page.*,
          (SELECT recorded_at FROM memoia.usage_events
           WHERE ${scope} ORDER BY recorded_at LIMIT 1) AS first_recorded_at
         FROM (SELECT 1) AS anchor LEFT JOIN (${page}) AS page ON true
         ORDER BY page.recorded_at, page.id`,
    params,
  );
  const rows = result.rows.filter(
    (row): row is UsageEventRow => row.id !== null,
  );
  const events = rows.slice(0, limit);
  const last = events.at(-1);
  return {
    project_id: projectId,
    ...(!after
      ? {
          first_recorded_date:
            result.rows[0]?.first_recorded_at?.toISOString().slice(0, 10) ??
            null,
        }
      : {}),
    events: events.map(({ id, user_id, occurred_at, usage }) => ({
      id,
      user_id,
      occurred_at: occurred_at.toISOString(),
      ...usage,
    })),
    next_cursor:
      rows.length > limit && last
        ? `${last.recorded_at.toISOString()}/${last.id}`
        : null,
  };
}
