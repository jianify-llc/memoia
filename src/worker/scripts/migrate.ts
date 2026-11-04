import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";

const identifier = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s))
    throw new Error(`Invalid SQL identifier: ${s}`);
  return `"${s}"`;
};
function option(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1] || process.argv[i + 1].startsWith("--"))
    throw new Error(`Missing --${name}`);
  return process.argv[i + 1];
}
const local = (url: string) =>
  new pg.Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
const qualified = (schema: string, table: string) =>
  `${identifier(schema)}.${identifier(table)}`;

async function main() {
  const action = process.argv[2];
  const target = local(option("target"));
  if (action === "init" || action === "upgrade") {
    await target.connect();
    try {
      await target.query("BEGIN");
      try {
        await target.query(
          "SELECT pg_advisory_xact_lock(hashtext('memoia.drizzle.migrations'))",
        );
        const journal = JSON.parse(
          await readFile(
            fileURLToPath(
              new URL("../migrations/meta/_journal.json", import.meta.url),
            ),
            "utf8",
          ),
        );
        const entries = await Promise.all(
          (journal.entries as { tag: string; when: number }[]).map(
            async (entry) => {
              if (
                !/^\d{4}_[a-z0-9_]+$/.test(entry.tag) ||
                !Number.isSafeInteger(entry.when)
              )
                throw new Error("Invalid migration journal");
              const sql = await readFile(
                fileURLToPath(
                  new URL(`../migrations/${entry.tag}.sql`, import.meta.url),
                ),
                "utf8",
              );
              return {
                ...entry,
                sql,
                hash: createHash("sha256").update(sql).digest("hex"),
              };
            },
          ),
        );
        if (
          !entries.length ||
          entries.some((e, i) => i > 0 && e.when <= entries[i - 1].when)
        )
          throw new Error("Invalid migration journal");
        let applied = 0;
        if (action === "upgrade") {
          const exists = await target.query(
            "SELECT to_regclass('memoia.__drizzle_migrations') AS ledger",
          );
          if (!exists.rows[0].ledger)
            throw new Error(
              "Missing memoia migration ledger; initialize an empty target first",
            );
          await target.query(
            "LOCK TABLE memoia.__drizzle_migrations IN SHARE ROW EXCLUSIVE MODE",
          );
          const ledger = await target.query<{
            hash: string;
            created_at: string;
          }>(
            "SELECT hash,created_at::text FROM memoia.__drizzle_migrations ORDER BY id",
          );
          if (
            !ledger.rows.length ||
            ledger.rows.length > entries.length ||
            ledger.rows.some(
              (row, i) =>
                row.hash !== entries[i].hash ||
                row.created_at !== String(entries[i].when),
            )
          )
            throw new Error("Migration ledger is not a known journal prefix");
          applied = ledger.rows.length;
        }
        for (const entry of entries.slice(applied)) {
          await target.query(entry.sql);
          await target.query(
            "CREATE TABLE IF NOT EXISTS memoia.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)",
          );
          await target.query(
            "INSERT INTO memoia.__drizzle_migrations(hash,created_at) VALUES ($1,$2)",
            [entry.hash, entry.when],
          );
        }
        await target.query("COMMIT");
      } catch (error) {
        await target.query("ROLLBACK");
        throw error;
      }
    } finally {
      await target.end();
    }
    return;
  }
  if (action === "bootstrap") {
    const index = process.argv.indexOf("--usage-token-limit-active");
    const rawLimit = index < 0 ? "0" : process.argv[index + 1];
    if (!rawLimit || !/^\d+$/.test(rawLimit) || Number(rawLimit) > 2147483647) {
      throw new Error("Invalid --usage-token-limit-active");
    }
    const limit = Number(rawLimit) || null;
    await target.connect();
    try {
      await target.query("BEGIN");
      try {
        await target.query(
          `INSERT INTO memoia.projects(id,project_id,project_secret,status)
          VALUES ($1,'__root__','__root__','active') ON CONFLICT (project_id) DO NOTHING`,
          [randomUUID()],
        );
        await target.query(
          "SELECT 1 FROM memoia.projects WHERE project_id='__root__' FOR UPDATE",
        );
        const linked = await target.query(
          "SELECT 1 FROM memoia.project_billings WHERE project_id='__root__' LIMIT 1",
        );
        if (!linked.rowCount) {
          const id = randomUUID();
          await target.query(
            `INSERT INTO memoia.billings(id,usage_left,next_refill_at)
            VALUES ($1,$2,date_trunc('month',now()) + interval '1 month')`,
            [id, limit],
          );
          await target.query(
            "INSERT INTO memoia.project_billings(project_id,billing_id) VALUES ('__root__',$1)",
            [id],
          );
        }
        await target.query("COMMIT");
      } catch (error) {
        await target.query("ROLLBACK");
        throw error;
      }
    } finally {
      await target.end();
    }
    return;
  }
  if (action !== "copy")
    throw new Error(
      "Usage: migrate.ts init --target URL | upgrade --target URL | bootstrap --target URL [--usage-token-limit-active N] | copy --source URL --source-schema NAME --target URL --source-quiesced",
    );
  if (!process.argv.includes("--source-quiesced"))
    throw new Error(
      "Stop source writers and pass --source-quiesced before copying",
    );
  const source = local(option("source"));
  const sourceSchema = option("source-schema");
  identifier(sourceSchema);
  let sourceConnected = false;
  let targetConnected = false;
  try {
    await source.connect();
    sourceConnected = true;
    await target.connect();
    targetConnected = true;
    await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await target.query("BEGIN");
    await source.query("SET LOCAL TIME ZONE 'UTC'");
    await target.query("SET LOCAL TIME ZONE 'UTC'");
    const vector =
      await target.query(`SELECT pg_catalog.set_config('search_path',
      pg_catalog.format('memoia,%I,extensions,public', n.nspname), true)
      FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace
      WHERE e.extname='vector'`);
    if (!vector.rowCount) throw new Error("Target vector extension is missing");
    await target.query("SET CONSTRAINTS ALL DEFERRED");
    // 0015 and 0016 have identical columns. The target baseline already carries
    // 0016 trigger functions and removes its redundant Fact-to-Blob foreign key;
    // deferred constraints below validate the copied data against that baseline.
    const revision = await source.query(
      `SELECT version_num FROM ${qualified(sourceSchema, "alembic_version")}`,
    );
    if (
      revision.rows.length !== 1 ||
      !["0015_event_time", "0016_source_cascade"].includes(
        revision.rows[0].version_num,
      )
    )
      throw new Error(
        "Source must be at Alembic revision 0015_event_time or 0016_source_cascade",
      );
    const targetRevision = await target.query(
      "SELECT version_num FROM memoia.alembic_version",
    );
    if (
      targetRevision.rows.length !== 1 ||
      targetRevision.rows[0].version_num !== "0016_source_cascade"
    )
      throw new Error("Target baseline mismatch");
    const tables = [
      "projects",
      "billings",
      "project_billings",
      "project_api_keys",
      "users",
      "general_blobs",
      "buffer_zones",
      "user_profiles",
      "user_events",
      "user_statuses",
      "memory_user_states",
      "memory_user_tombstones",
      "memory_sources",
      "memory_messages",
      "memory_blobs",
      "memory_operations",
      "memory_facts",
      "memory_profile_revisions",
      "memory_event_facts",
      "memory_deleted_events",
    ];
    for (const table of tables) {
      const columnsSql = `SELECT a.attname AS column_name, format_type(a.atttypid,a.atttypmod) AS type
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`;
      const sourceCols = await source.query(columnsSql, [sourceSchema, table]);
      const targetCols = await target.query(columnsSql, ["memoia", table]);
      const normal = (type: string) =>
        type.replace(
          /^(?:"(?:[^"]|"")*"|[A-Za-z_][\w$]*)\.vector\(/,
          "vector(",
        );
      const actual = new Map(
        targetCols.rows.map((r) => [r.column_name, normal(r.type)]),
      );
      const allowed =
        table === "memory_user_states"
          ? ["writer_lease_until"]
          : table === "memory_operations"
            ? ["dispatch_reserved_until"]
            : [];
      if (
        !sourceCols.rowCount ||
        sourceCols.rows.some(
          (r) => actual.get(r.column_name) !== normal(r.type),
        ) ||
        targetCols.rows.some(
          (r) =>
            !sourceCols.rows.some((x) => x.column_name === r.column_name) &&
            !allowed.includes(r.column_name),
        )
      )
        throw new Error(`Column mismatch: ${table}`);
      const existing = await target.query(
        `SELECT 1 FROM ${qualified("memoia", table)} LIMIT 1`,
      );
      if (existing.rowCount)
        throw new Error(`Target table is not empty: ${table}`);
    }
    for (const table of tables) {
      const cols = await source.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position",
        [sourceSchema, table],
      );
      const names = cols.rows.map((c) => identifier(c.column_name)).join(",");
      await source.query(
        `DECLARE transfer_cursor NO SCROLL CURSOR FOR SELECT data FROM (SELECT row_to_json(t)::text AS data FROM ${qualified(sourceSchema, table)} t) rows ORDER BY data COLLATE "C"`,
      );
      let count = 0;
      const sourceHash = createHash("sha256");
      for (;;) {
        const batch = await source.query<{ data: string }>(
          "FETCH FORWARD 250 FROM transfer_cursor",
        );
        if (!batch.rowCount) break;
        for (const row of batch.rows) {
          sourceHash.update(`${Buffer.byteLength(row.data)}:`).update(row.data);
          await target.query(
            `INSERT INTO ${qualified("memoia", table)} (${names}) SELECT ${names} FROM jsonb_populate_record(NULL::${qualified("memoia", table)}, $1::jsonb)`,
            [row.data],
          );
          count++;
        }
      }
      await source.query("CLOSE transfer_cursor");
      const copied = await target.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${qualified("memoia", table)}`,
      );
      if (BigInt(copied.rows[0].count) !== BigInt(count))
        throw new Error(`Copy count mismatch: ${table}`);
      await target.query(
        `DECLARE verify_cursor NO SCROLL CURSOR FOR SELECT data FROM (SELECT row_to_json(t)::text AS data FROM (SELECT ${names} FROM ${qualified("memoia", table)}) t) rows ORDER BY data COLLATE "C"`,
      );
      const targetHash = createHash("sha256");
      for (;;) {
        const batch = await target.query<{ data: string }>(
          "FETCH FORWARD 250 FROM verify_cursor",
        );
        if (!batch.rowCount) break;
        for (const row of batch.rows)
          targetHash.update(`${Buffer.byteLength(row.data)}:`).update(row.data);
      }
      await target.query("CLOSE verify_cursor");
      if (sourceHash.digest("hex") !== targetHash.digest("hex"))
        throw new Error(`Copy content mismatch: ${table}`);
      process.stdout.write(`${table}: ${count} verified\n`);
    }
    const owned = await target.query(
      "SELECT 1 FROM memoia.memory_operations WHERE kind='flush' AND lease_owner IS NOT NULL LIMIT 1",
    );
    if (owned.rowCount)
      throw new Error(
        "Drain all flush owners before migrating execution state",
      );
    await target.query(`INSERT INTO memoia.queue_tasks
      (id,request_key,business_key,type,user_id,biz_params,status,run_attempts,execution_ms,created_at,updated_at,next_run_at,finished_at,result,result_code,fail_reasons)
      SELECT o.id,o.id::text,o.id::text,'maintenance_flush',NULL,'{}'::jsonb,
        CASE o.status WHEN 'completed' THEN 'succeeded' WHEN 'failed' THEN 'failed' ELSE 'pending' END,
        o.attempts::integer,NULL,o.created_at,clock_timestamp(),COALESCE(o.available_at,clock_timestamp()),
        NULL,
        o.result,CASE WHEN o.status='completed' THEN 'COMPLETED' WHEN o.status='failed' THEN left(COALESCE(o.error->>'code','maintenance_failed'),64) ELSE NULL END,
        jsonb_build_array(jsonb_build_object('resultCode','TASK_FAILURE_BUDGET_BASELINE','failureCount',o.attempts::integer))
      FROM memoia.memory_operations o WHERE o.kind='flush'`);
    await target.query("SET CONSTRAINTS ALL IMMEDIATE");
    await target.query("COMMIT");
    await source.query("COMMIT");
  } catch (error) {
    if (targetConnected) await target.query("ROLLBACK").catch(() => {});
    if (sourceConnected) await source.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    try {
      if (sourceConnected) await source.end();
    } finally {
      if (targetConnected) await target.end();
    }
  }
}
main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Migration failed"}\n`,
  );
  process.exitCode = 1;
});
