import { test } from "node:test";
import assert from "node:assert/strict";
import { Database, acquireUserLease, releaseUserLease } from "../src/db";
import {
  MaintenanceContext,
  consume,
  flush,
  pollMaintenance,
  type Claim,
} from "../src/maintenance";
import { createUser } from "../src/management";
import { startMaintenanceWorker } from "../src/maintenance-worker";
import { maintenanceTasks } from "../src/maintenance-task";

const db = new Database(process.env.MEMOIA_TEST_DATABASE_URL!);
const runtime = {
  db,
  env: {
    OPENAI_API_KEY: "local-mock",
    MAINTENANCE_ENABLED: "true",
    MEMOIA_CONFIG: JSON.stringify({ enable_event_embedding: false }),
  },
  deadline: Date.now() + 180_000,
};
const projectId = `node_worker_${crypto.randomUUID()}`;
const originalFetch = globalThis.fetch;
async function user() {
  const scope = { projectId, userId: crypto.randomUUID() };
  await createUser(db, projectId, { id: scope.userId });
  await db.query(
    "INSERT INTO memoia.memory_sources(user_id,project_id,source_id) VALUES($1,$2,'s')",
    [scope.userId, projectId],
  );
  return scope;
}
async function batch(
  scope: { userId: string; projectId: string },
  kind: "noop" | "added" = "noop",
) {
  const messageId = crypto.randomUUID(),
    blobId = crypto.randomUUID(),
    factId = crypto.randomUUID();
  await db.query(
    "INSERT INTO memoia.memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at) VALUES($1,$2,'s',$3,repeat('a',64),'user',now())",
    [scope.userId, projectId, messageId],
  );
  await db.query(
    `INSERT INTO memoia.memory_blobs(id,user_id,project_id,source_id,message_ids,status,fact_completed_at,fact_changes) VALUES($3,$1,$2,'s',$4::jsonb,'active',now()-interval '3 minutes',$5::jsonb)`,
    [
      scope.userId,
      projectId,
      blobId,
      JSON.stringify([messageId]),
      JSON.stringify([
        kind === "noop"
          ? { kind: "noop", version: 1 }
          : { kind: "added", fact_id: factId, version: 1 },
      ]),
    ],
  );
  if (kind === "added")
    await db.query(
      `INSERT INTO memoia.memory_facts(id,user_id,project_id,blob_id,content,support_groups,occurred_at) VALUES($3,$1,$2,$4,'fact',$5::jsonb,now())`,
      [scope.userId, projectId, factId, blobId, JSON.stringify([[messageId]])],
    );
  return blobId;
}
const task = (id: string) =>
  db.transaction((tx) => maintenanceTasks.readInTx(tx, id));
const response = () =>
  Response.json({
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
try {
  await db.query(
    "INSERT INTO memoia.projects(id,project_id,project_secret,status) VALUES($1,$2,'local','active')",
    [crypto.randomUUID(), projectId],
  );
  await test("Node automatically seals and executes a due noop without Queue or model", async () => {
    const scope = await user();
    const blob = await batch(scope);
    globalThis.fetch = async () => {
      throw Error("unexpected model call");
    };
    const messages = await pollMaintenance(runtime);
    const message = messages.find((m) => m.user_id === scope.userId);
    assert.ok(message);
    await consume(runtime, message);
    const result = await task(message.operation_id);
    assert.equal(result?.status, "succeeded");
    assert.deepEqual(result?.result?.blob_ids, [blob]);
  });
  await test("Node ignores notification reservation but honors next_run_at", async () => {
    const ready = await user(),
      delayed = await user();
    await batch(ready);
    await batch(delayed);
    const a = await flush(runtime, ready, "ready"),
      b = await flush(runtime, delayed, "delayed");
    await db.query(
      "UPDATE memoia.queue_tasks SET next_dispatch_at=clock_timestamp()+interval '1 hour' WHERE id=ANY($1::uuid[])",
      [[a.operation_id, b.operation_id]],
    );
    await db.query(
      "UPDATE memoia.queue_tasks SET next_run_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
      [b.operation_id],
    );
    const messages = await pollMaintenance(runtime, 10);
    assert.ok(messages.some((m) => m.operation_id === a.operation_id));
    assert.ok(!messages.some((m) => m.operation_id === b.operation_id));
    await consume(
      runtime,
      messages.find((m) => m.operation_id === a.operation_id)!,
    );
    await db.query(
      "UPDATE memoia.queue_tasks SET next_run_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [b.operation_id],
    );
    const next = await pollMaintenance(runtime, 10);
    assert.ok(next.some((m) => m.operation_id === b.operation_id));
    await consume(
      runtime,
      next.find((m) => m.operation_id === b.operation_id)!,
    );
  });
  await test("selection limits users and excludes a user with a running claim", async () => {
    const a = await user(),
      b = await user(),
      c = await user();
    await batch(a);
    const a1 = await flush(runtime, a, "one");
    await batch(a);
    const a2 = await flush(runtime, a, "two");
    await batch(b);
    const b1 = await flush(runtime, b, "one");
    await batch(c);
    const c1 = await flush(runtime, c, "one");
    const selected = await pollMaintenance(runtime, 2);
    assert.equal(selected.length, 2);
    assert.equal(new Set(selected.map((m) => m.user_id)).size, 2);
    const claimed = await db.transaction((tx) =>
      maintenanceTasks.claimInTx(tx, a1.operation_id),
    );
    assert.ok(claimed?.leaseId);
    const running = await pollMaintenance(runtime, 10);
    assert.ok(!running.some((m) => m.user_id === a.userId));
    assert.ok(running.some((m) => m.operation_id === b1.operation_id));
    assert.ok(running.some((m) => m.operation_id === c1.operation_id));
    const row = (
      await db.query("SELECT * FROM memoia.memory_operations WHERE id=$1", [
        a1.operation_id,
      ])
    ).rows[0];
    const claim: Claim = {
      ...a,
      id: row.id,
      owner: claimed.leaseId,
      blobIds: row.request.blob_ids,
      changes: [],
    };
    const context = new MaintenanceContext(runtime, claim, async () => {});
    await context.prepare();
    const successor = crypto.randomUUID();
    await db.query(
      "UPDATE memoia.queue_tasks SET lease_id=$2,run_attempts=run_attempts+1 WHERE id=$1",
      [a1.operation_id, successor],
    );
    await assert.rejects(context.commit(), /no longer owns/i);
    assert.equal((await task(a1.operation_id))?.leaseId, successor);
    await db.query(
      "UPDATE memoia.queue_tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [a1.operation_id],
    );
    await pollMaintenance(runtime, 10);
    // Keep unfinished tasks outside subsequent polls until the project is removed.
    await db.query(
      "UPDATE memoia.queue_tasks SET next_run_at=clock_timestamp()+interval '1 day' WHERE id=ANY($1::uuid[])",
      [[a1.operation_id, a2.operation_id, b1.operation_id, c1.operation_id]],
    );
  });
  await test("a restarted worker resumes an agent checkpoint on the same operation", async () => {
    const scope = await user();
    const blob = await batch(scope, "added");
    const op = await flush(runtime, scope, "resume");
    const lease = await acquireUserLease(db, scope, 60_000);
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return response();
    };
    try {
      const first = (await pollMaintenance(runtime, 10)).find(
        (m) => m.operation_id === op.operation_id,
      );
      assert.ok(first);
      await consume(runtime, first);
      const saved = await task(op.operation_id);
      assert.equal(saved?.status, "retry_wait");
      assert.equal(saved?.executionState?.phase, "agent_completed");
      assert.equal(saved?.failureCount, 1);
      assert.equal(calls, 1);
    } finally {
      await releaseUserLease(db, lease);
    }
    await db.query(
      "UPDATE memoia.queue_tasks SET next_run_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [op.operation_id],
    );
    const restarted = { ...runtime, deadline: Date.now() + 180_000 };
    const message = (await pollMaintenance(restarted, 10)).find(
      (m) => m.operation_id === op.operation_id,
    );
    assert.ok(message);
    await consume(restarted, message);
    const completed = await task(op.operation_id);
    assert.equal(completed?.status, "succeeded");
    assert.equal(completed?.failureCount, 1);
    assert.equal(completed?.runAttempts, 2);
    assert.deepEqual(completed?.result?.blob_ids, [blob]);
    assert.equal(calls, 1);
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
  });
  await test("stopping drains an in-flight task without making it fail", async () => {
    const scope = await user();
    await batch(scope, "added");
    const op = await flush(runtime, scope, "drain");
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = async () => {
      entered();
      await gate;
      return response();
    };
    const worker = startMaintenanceWorker(runtime.env, db, {
      concurrency: 1,
      pollIntervalMs: 20,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        waiting,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Error("model was not reached")),
            5000,
          );
        }),
      ]);
      assert.equal(await worker.stop(20), false);
      const inFlight = await task(op.operation_id);
      assert.equal(inFlight?.status, "running");
      assert.equal(inFlight?.failureCount, 0);
      release();
      assert.equal(await worker.stop(5000), true);
      assert.equal((await task(op.operation_id))?.status, "succeeded");
    } finally {
      if (timer) clearTimeout(timer);
      release();
      await worker.stop(5000);
    }
  });
  await test("input cleanup failure does not starve ready tasks", async () => {
    const scope = await user();
    await batch(scope);
    const op = await flush(runtime, scope, "cleanup-contention");
    const transaction = db.transaction.bind(db);
    db.transaction = (fn, options) =>
      transaction(
        (tx) =>
          fn({
            query: async (sql, values) => {
              if (
                sql.startsWith(
                  "UPDATE memoia.memory_operations SET request=jsonb_build_object",
                )
              )
          throw new Error("local cleanup failure");
              return tx.query(sql, values);
            },
          }),
        options,
      );
    const worker = startMaintenanceWorker(runtime.env, db, {
      pollIntervalMs: 20,
    });
    try {
      const deadline = Date.now() + 5000;
      while (
        (await task(op.operation_id))?.status !== "succeeded" &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal((await task(op.operation_id))?.status, "succeeded");
    } finally {
      assert.equal(await worker.stop(5000), true);
      db.transaction = transaction;
    }
  });
  await test("paused Node polling never touches the database", async () => {
    const paused = {
      ...runtime,
      db: {
        query: async () => {
          throw Error("unexpected database access");
        },
      } as unknown as Database,
      env: { ...runtime.env, MEMOIA_WRITES_ENABLED: "false" },
    };
    assert.deepEqual(await pollMaintenance(paused), []);
  });
} finally {
  globalThis.fetch = originalFetch;
  await db.query("DELETE FROM memoia.projects WHERE project_id=$1", [
    projectId,
  ]);
  await db.close();
}
