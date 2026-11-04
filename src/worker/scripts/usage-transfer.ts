import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { createClient } from "redis";

type Bucket = {
  project_id: string;
  name: string;
  period_type: "month" | "day";
  period_start: string;
  value: string;
  expires_at_ms: number;
};
export function parseKey(
  key: string,
  prefix: string,
): Omit<Bucket, "value" | "expires_at_ms"> {
  if (!key.startsWith(prefix))
    throw new Error("Key outside installation prefix");
  const parts = key.slice(prefix.length).split("::");
  const period = parts.pop();
  const name = parts.pop();
  const project = parts.join("::");
  if (!project || !name || project.length > 64 || name.length > 128 || !period)
    throw new Error("Malformed usage key");
  const month = /^\d{4}-\d{2}$/.test(period);
  const date = month ? `${period}-01` : period;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number(date.slice(0, 4)) === 0 ||
    Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
  )
    throw new Error("Unknown usage period");
  return {
    project_id: project,
    name,
    period_type: month ? "month" : "day",
    period_start: date,
  };
}
export function validateValue(value: string): void {
  if (!/^-?\d+$/.test(value))
    throw new Error("Usage value is not a PostgreSQL bigint");
  const n = BigInt(value);
  if (n < -(2n ** 63n) || n >= 2n ** 63n)
    throw new Error("Usage value is not a PostgreSQL bigint");
}
export function requireCurrentMonth(
  buckets: Bucket[],
  projects: string[],
  month: string,
): void {
  for (const project of projects)
    for (const name of ["llm_input_tokens", "llm_output_tokens"]) {
      if (
        !buckets.some(
          (b) =>
            b.project_id === project &&
            b.name === name &&
            b.period_type === "month" &&
            b.period_start === `${month}-01`,
        )
      )
        throw new Error(
          `Current-month usage is unknown for: ${project}/${name}`,
        );
    }
}
function option(name: string): string {
  const i = process.argv.indexOf(`--${name}`),
    value = process.argv[i + 1];
  if (i < 0 || !value || value.startsWith("--"))
    throw new Error(`Missing --${name}`);
  return value;
}
async function main() {
  const directionIndex = process.argv.indexOf("--direction");
  if (directionIndex >= 0 && process.argv[directionIndex + 1] !== "redis-to-pg")
    throw new Error("Only redis-to-pg is supported");
  const installation = option("installation-id"),
    file = option("file");
  if (
    !installation ||
    installation.includes("::") ||
    /[\x00-\x1f]/.test(installation)
  )
    throw new Error("Invalid installation ID");
  if (!process.argv.includes("--source-quiesced"))
    throw new Error(
      "Stop source and destination writers and pass --source-quiesced",
    );
  const redis = createClient({
    url: option("redis-url"),
    socket: { connectTimeout: 5000, reconnectStrategy: false },
  });
  redis.on("error", () => {});
  const db = new pg.Client({
    connectionString: option("database-url"),
    connectionTimeoutMillis: 5000,
  });
  let redisConnected = false,
    dbConnected = false;
  try {
    await redis.connect();
    redisConnected = true;
    await db.connect();
    dbConnected = true;
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await db.query("SET LOCAL TIME ZONE 'UTC'");
    const projects = (
      await db.query<{ project_id: string }>(
        "SELECT project_id FROM memoia.projects ORDER BY project_id",
      )
    ).rows.map((r) => r.project_id);
    const month = (
      await db.query<{ month: string }>(
        "SELECT to_char(current_date, 'YYYY-MM') AS month",
      )
    ).rows[0].month;
    const prefix = `memobase_telemetry::${installation}::`;
    const pattern = prefix.replace(/[\\*?\[\]]/g, "\\$&") + "*";
    const buckets: Bucket[] = [];
    const keys = new Set<string>();
    for await (const batch of redis.scanIterator({
      MATCH: pattern,
      COUNT: 1000,
    }))
      for (const key of batch) keys.add(key);
    for (const key of keys) {
      if (!key.startsWith(prefix)) continue;
      const parsed = parseKey(key, prefix);
      if (!projects.includes(parsed.project_id)) continue;
      const result = (await redis.eval(
        `local value=redis.call('GET',KEYS[1]); local ttl=redis.call('PTTL',KEYS[1]); local t=redis.call('TIME'); if not value then return {false,tostring(ttl),'0'} end; return {value,tostring(ttl),string.format('%.0f',t[1]*1000+math.floor(t[2]/1000)+ttl)}`,
        { keys: [key], arguments: [] },
      )) as [string | null, string, string];
      const [value, ttl, expiry] = result;
      if (value === null || Number(ttl) < 0)
        throw new Error("A usage key disappeared or has no expiry");
      validateValue(value);
      const expires_at_ms = Number(expiry);
      if (!Number.isSafeInteger(expires_at_ms))
        throw new Error("Invalid usage expiry");
      buckets.push({ ...parsed, value, expires_at_ms });
    }
    requireCurrentMonth(buckets, projects, month);
    const now = Number(
      (
        await db.query<{ now_ms: string }>(
          "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now_ms",
        )
      ).rows[0].now_ms,
    );
    if (buckets.some((b) => b.expires_at_ms <= now))
      throw new Error(
        "A usage bucket expired during transfer; take a new snapshot",
      );
    buckets.sort((a, b) =>
      JSON.stringify([
        a.project_id,
        a.name,
        a.period_type,
        a.period_start,
      ]).localeCompare(
        JSON.stringify([b.project_id, b.name, b.period_type, b.period_start]),
      ),
    );
    const handle = await open(file, "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({
          version: 1,
          installation_id: installation,
          direction: "redis-to-pg",
          projects,
          buckets,
        }) + "\n",
      );
    } finally {
      await handle.close();
    }
    if (
      (await db.query("SELECT 1 FROM memoia.usage_counters LIMIT 1")).rowCount
    )
      throw new Error("PostgreSQL usage target is not empty");
    for (const b of buckets)
      await db.query(
        "INSERT INTO memoia.usage_counters(project_id,name,period_type,period_start,value,expires_at) VALUES ($1,$2,$3,$4,$5,to_timestamp($6::double precision / 1000))",
        [
          b.project_id,
          b.name,
          b.period_type,
          b.period_start,
          b.value,
          b.expires_at_ms,
        ],
      );
    await db.query("COMMIT");
    process.stdout.write(
      `Transferred ${buckets.length} usage buckets for ${projects.length} projects\n`,
    );
  } catch (error) {
    if (dbConnected) await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (dbConnected) await db.end();
    if (redisConnected) await redis.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    process.stderr.write(
      "Usage transfer failed; verify inputs, scope, and connectivity\n",
    );
    process.exitCode = 1;
  });
