import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import pg from "pg";
import { Database } from "../src/db";
import { createUser } from "../src/management";
import { flush } from "../src/maintenance";
import { maintenanceTasks } from "../src/maintenance-task";

const databaseUrl = process.env.MEMOIA_TEST_DATABASE_URL!;
const db = new Database(databaseUrl);
const projectId = `node_process_${crypto.randomUUID()}`;
const scope = { projectId, userId: crypto.randomUUID() };
const runtime = {
  db,
  env: {
    OPENAI_API_KEY: "local-mock",
    MAINTENANCE_ENABLED: "true",
    MEMOIA_CONFIG: JSON.stringify({ enable_event_embedding: false }),
  },
  deadline: Date.now() + 180_000,
};
const response = () => ({
  id: `resp_${crypto.randomUUID()}`,
  object: "response",
  created_at: 1,
  status: "completed",
  error: null,
  incomplete_details: null,
  model: "gpt-6-luna",
  output: [
    {
      type: "message",
      id: "msg",
      role: "assistant",
      content: [{ type: "output_text", text: "Done", annotations: [] }],
      status: "completed",
    },
  ],
  usage: {
    input_tokens: 1,
    output_tokens: 1,
    total_tokens: 2,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  },
});
async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 20_000;
  do {
    const value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}`);
}
function exited(child: ChildProcess) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
}
await test("SIGKILL and restart resume the saved checkpoint on the original task", async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response()));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    ACCESS_TOKEN: "local-test",
    OPENAI_API_KEY: "local-mock",
    OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    MEMOIA_CONFIG: runtime.env.MEMOIA_CONFIG,
    MAINTENANCE_ENABLED: "true",
    MEMOIA_WRITES_ENABLED: "true",
  };
  const lock = new pg.Client({ connectionString: databaseUrl });
  let first: ChildProcess | undefined, second: ChildProcess | undefined;
  let firstExit: ReturnType<typeof exited> | undefined,
    secondExit: ReturnType<typeof exited> | undefined;
  const applicationName = `memoia-crash-${scope.userId}`;
  const crashUrl = new URL(databaseUrl);
  crashUrl.searchParams.set("application_name", applicationName);
  const gate = "memoia_test_pause_final_cas";
  let installed = false;
  let stderr = "";
  function start(firstRun = false) {
    const child = spawn(
      process.execPath,
      [process.env.MEMOIA_TEST_WORKER_CLI!],
      { env: firstRun ? { ...env, DATABASE_URL: crashUrl.toString() } : env, stdio: ["ignore", "ignore", "pipe"] },
    );
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    return child;
  }
  try {
    await db.query(
      "INSERT INTO memoia.projects(id,project_id,project_secret,status) VALUES($1,$2,'local','active')",
      [crypto.randomUUID(), projectId],
    );
    await createUser(db, projectId, { id: scope.userId });
    await db.query(
      "INSERT INTO memoia.memory_sources(user_id,project_id,source_id) VALUES($1,$2,'s')",
      [scope.userId, projectId],
    );
    const messageId = crypto.randomUUID(),
      blobId = crypto.randomUUID(),
      factId = crypto.randomUUID();
    await db.query(
      "INSERT INTO memoia.memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at) VALUES($1,$2,'s',$3,repeat('a',64),'user',now())",
      [scope.userId, projectId, messageId],
    );
    await db.query(
      "INSERT INTO memoia.memory_blobs(id,user_id,project_id,source_id,message_ids,status,fact_completed_at,fact_changes) VALUES($3,$1,$2,'s',$4::jsonb,'active',now(),$5::jsonb)",
      [
        scope.userId,
        projectId,
        blobId,
        JSON.stringify([messageId]),
        JSON.stringify([{ kind: "added", fact_id: factId, version: 1 }]),
      ],
    );
    await db.query(
      "INSERT INTO memoia.memory_facts(id,user_id,project_id,blob_id,content,support_groups,occurred_at) VALUES($3,$1,$2,$4,'fact',$5::jsonb,now())",
      [scope.userId, projectId, factId, blobId, JSON.stringify([[messageId]])],
    );
    const op = await flush(runtime, scope, "restart");
    await lock.connect();
    await lock.query("SELECT pg_advisory_lock(83201531)");
    await db.query(`CREATE FUNCTION memoia.${gate}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status='succeeded' AND current_setting('application_name')='${applicationName}' THEN
          PERFORM pg_advisory_xact_lock(83201531);
        END IF;
        RETURN NEW;
      END $$`);
    await db.query(`CREATE TRIGGER ${gate} BEFORE UPDATE ON memoia.queue_tasks
      FOR EACH ROW EXECUTE FUNCTION memoia.${gate}()`);
    installed = true;
    first = start(true);
    firstExit = exited(first);
    const read = async () =>
      db.transaction((tx) => maintenanceTasks.readInTx(tx, op.operation_id));
    const before = await until(
      read,
      (row) =>
        row?.status === "running" &&
        row.executionState?.phase === "agent_completed",
      "saved checkpoint",
    );
    assert.equal(requests, 1);
    const blocked = await until(
      async () => (await db.query(
        "SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
        [applicationName],
      )).rows[0],
      Boolean, "final CAS to wait behind the test gate",
    );
    first.kill("SIGKILL");
    assert.equal((await firstExit).signal, "SIGKILL");
    await db.query("SELECT pg_terminate_backend($1,5000)", [blocked.pid]);
    await lock.query("SELECT pg_advisory_unlock(83201531)");
    await db.query(
      "UPDATE memoia.queue_tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [op.operation_id],
    );
    second = start();
    secondExit = exited(second);
    await until(
      read,
      (row) => row?.status === "retry_wait",
      "expired lease recovery",
    );
    await db.query(
      "UPDATE memoia.queue_tasks SET next_run_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [op.operation_id],
    );
    const after = await until(
      read,
      (row) => row?.status === "succeeded",
      "checkpoint completion",
    ).catch(async (error) => {
      const task = await read();
      const state = {
        status: task?.status,
        resultCode: task?.resultCode,
        lastFailure: task?.lastFailure?.resultCode,
        requests,
      };
      throw new Error(`${error.message}: ${JSON.stringify(state)}
${stderr}`, { cause: error });
    });
    assert.equal(requests, 1);
    assert.equal(Number(after!.runAttempts), Number(before!.runAttempts) + 1);
    assert.equal(Number(after!.failureCount), 1);
    assert.deepEqual(after!.result?.blob_ids, [blobId]);
    assert.equal(
      Number(
        (
          await db.query(
            "SELECT count(*) AS count FROM memoia.memory_operations WHERE project_id=$1 AND user_id=$2",
            [projectId, scope.userId],
          )
        ).rows[0].count,
      ),
      1,
    );
    second.kill("SIGTERM");
    assert.deepEqual(await secondExit, { code: 0, signal: null }, stderr);
  } finally {
    if (first && first.exitCode === null && first.signalCode === null) {
      first.kill("SIGKILL");
      await firstExit;
    }
    if (second && second.exitCode === null && second.signalCode === null) {
      second.kill("SIGKILL");
      await secondExit;
    }
    await lock.end();
    if (installed)
      await db.query(`DROP TRIGGER ${gate} ON memoia.queue_tasks; DROP FUNCTION memoia.${gate}()`);
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await db.query("DELETE FROM memoia.projects WHERE project_id=$1", [
      projectId,
    ]);
    await db.close();
  }
});
