import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Database,
  DatabaseUnavailableError,
  acquireUserLease,
  releaseUserLease,
} from "../src/db";
import {
  MaintenanceContext,
  consume,
  reconcile,
  retryFlush,
  flush,
  getStatus,
  type Claim,
} from "../src/maintenance";
import { createUser } from "../src/management";
import worker from "../src/index";
import type { Runtime } from "../src/runtime";
import { SourceError } from "../src/errors";
import { getOperation, listOperations } from "../src/facts";
import { maintenanceTasks, projectOperation } from "../src/maintenance-task";

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
const projectId = `recovery_${crypto.randomUUID()}`;
const originalFetch = globalThis.fetch;
async function operationState(id: string) {
  const row = (
    await db.query("SELECT * FROM memoia.memory_operations WHERE id=$1", [id])
  ).rows[0];
  return projectOperation(db, row);
}

test("write pause also stops Queue and Cron mutation before opening a database", async () => {
  const env = {
    OPENAI_API_KEY: "unused",
    MEMOIA_WRITES_ENABLED: "false",
    MAINTENANCE_ENABLED: "true",
  };
  const paused = {
    db: {
      query: async () => {
        throw Error("must not query while writes are paused");
      },
    } as unknown as Database,
    env,
    deadline: Date.now() + 60000,
  };
  await consume(paused, {
    kind: "user",
    project_id: "unused",
    user_id: crypto.randomUUID(),
  });
  await reconcile(paused);
  await worker.scheduled({} as ScheduledController, env);
});

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
  kind: "noop" | "added",
) {
  const messageId = crypto.randomUUID(),
    blobId = crypto.randomUUID(),
    factId = crypto.randomUUID();
  await db.query(
    "INSERT INTO memoia.memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at) VALUES($1,$2,'s',$3,repeat('a',64),'user',now())",
    [scope.userId, projectId, messageId],
  );
  await db.query(
    `INSERT INTO memoia.memory_blobs(id,user_id,project_id,source_id,message_ids,status,fact_completed_at,fact_changes)
    VALUES($3,$1,$2,'s',$4::jsonb,'active',now(),$5::jsonb)`,
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
      `INSERT INTO memoia.memory_facts(id,user_id,project_id,blob_id,content,support_groups,occurred_at)
    VALUES($3,$1,$2,$4,'fact',$5::jsonb,now())`,
      [scope.userId, projectId, factId, blobId, JSON.stringify([[messageId]])],
    );
  return blobId;
}
const wake = (scope: { userId: string; projectId: string }, id: string) => ({
  kind: "flush" as const,
  user_id: scope.userId,
  project_id: scope.projectId,
  operation_id: id,
});
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
  await test("all-noop flush completes without contacting a provider", async () => {
    const scope = await user();
    await batch(scope, "noop");
    const op = await flush(runtime, scope, "noop");
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error("unexpected provider call");
    };
    await consume(runtime, wake(scope, op.operation_id));
    const row = await operationState(op.operation_id);
    assert.equal(row.status, "completed");
    assert.equal(calls, 0);
    assert.equal(row.result.blob_ids.length, 1);
  });
  await test("flush lists project a page of tasks with one task query", async () => {
    const scope = await user();
    await batch(scope, "noop");
    await flush(runtime, scope, "page-one");
    await batch(scope, "noop");
    await flush(runtime, scope, "page-two");
    const original = db.query.bind(db);
    let taskReads = 0;
    db.query = async (sql, values) => {
      if (sql.includes('FROM "memoia"."queue_tasks"')) taskReads++;
      return original(sql, values);
    };
    try {
      assert.equal((await getStatus(runtime, scope)).flushes.length, 2);
      assert.equal(taskReads, 1);
      taskReads = 0;
      assert.equal((await listOperations(runtime, scope)).length, 2);
      assert.equal(taskReads, 1);
    } finally {
      db.query = original;
    }
  });
  await test("completed Agent checkpoint resumes commit without replaying the model", async () => {
    const scope = await user();
    const blob = await batch(scope, "added");
    const op = await flush(runtime, scope, "agent-completed-resume");
    const writer = await acquireUserLease(db, scope, 60_000);
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return response();
    };
    try {
      await consume(runtime, wake(scope, op.operation_id));
      const failed = await db.transaction((tx) =>
        maintenanceTasks.readInTx(tx, op.operation_id),
      );
      assert.equal(failed?.status, "retry_wait");
      assert.equal(failed.executionState?.phase, "agent_completed");
      assert.equal(failed.failureCount, 1);
      assert.equal(calls, 1);
    } finally {
      await releaseUserLease(db, writer);
    }
    await db.query(
      "UPDATE memoia.queue_tasks SET next_run_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [op.operation_id],
    );
    await consume(runtime, wake(scope, op.operation_id));
    const completed = await db.transaction((tx) =>
      maintenanceTasks.readInTx(tx, op.operation_id),
    );
    assert.equal(completed?.status, "succeeded");
    assert.equal(completed.runAttempts, 2);
    assert.equal(completed.failureCount, 1);
    assert.equal(completed.executionState, null);
    assert.deepEqual(completed.result?.blob_ids, [blob]);
    assert.equal(calls, 1);
  });
  await test("a saved tool round resumes from its native parent after a failed slice", async () => {
    const scope = await user();
    await batch(scope, "added");
    const op = await flush(runtime, scope, "native-round-resume");
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls > 1)
        return Response.json(
          {
            error: {
              type: "server_error",
              code: "server_error",
              message: "offline",
            },
          },
          { status: 503 },
        );
      const payload = (await response().json()) as Record<string, unknown>;
      payload.id = "resp_saved";
      payload.output = [
        {
          type: "function_call",
          id: "fc_saved",
          call_id: "call_saved",
          name: "read_changes",
          arguments: '{"cursor":null,"limit":100}',
          status: "completed",
        },
      ];
      return Response.json(payload);
    };
    await consume(runtime, wake(scope, op.operation_id));
    const paused = await db.transaction((tx) =>
      maintenanceTasks.readInTx(tx, op.operation_id),
    );
    assert.equal(paused?.status, "retry_wait");
    assert.equal(paused.executionState?.phase, "agent_running");
    assert.equal(paused.executionState?.parentId, "resp_saved");
    await db.query(
      "UPDATE memoia.queue_tasks SET next_run_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [op.operation_id],
    );
    let resumed: any;
    globalThis.fetch = async (_input, init) => {
      resumed = JSON.parse(String(init?.body));
      return response();
    };
    await consume(runtime, wake(scope, op.operation_id));
    const done = await db.transaction((tx) =>
      maintenanceTasks.readInTx(tx, op.operation_id),
    );
    assert.equal(done?.status, "succeeded");
    assert.equal(done.failureCount, 1);
    assert.equal(resumed.service_tier, "flex");
    assert.equal(resumed.previous_response_id, "resp_saved");
    assert.deepEqual(
      resumed.input.map((item: any) => item.call_id),
      ["call_saved"],
    );
  });
  await test("changed read set rebuilds the same fixed flush before commit", async () => {
    const scope = await user();
    const blob = await batch(scope, "added");
    const op = await flush(runtime, scope, "changed-read-set");
    const writer = await acquireUserLease(db, scope, 60_000);
    let calls = 0;
    const requests: any[] = [];
    globalThis.fetch = async (_input, init) => {
      calls++;
      requests.push(JSON.parse(String(init?.body)));
      return response();
    };
    try {
      await consume(runtime, wake(scope, op.operation_id));
    } finally {
      await releaseUserLease(db, writer);
    }
    const before = await db.transaction((tx) =>
      maintenanceTasks.readInTx(tx, op.operation_id),
    );
    assert.equal(before?.executionState?.phase, "agent_completed");
    const referenceTime = (before.executionState as any).referenceTime;
    await db.query(
      "UPDATE memoia.memory_facts SET revision=revision+1 WHERE blob_id=$1",
      [blob],
    );
    await db.query(
      "UPDATE memoia.queue_tasks SET next_run_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [op.operation_id],
    );
    await consume(runtime, wake(scope, op.operation_id));
    const done = await db.transaction((tx) =>
      maintenanceTasks.readInTx(tx, op.operation_id),
    );
    assert.equal(done?.status, "succeeded");
    assert.deepEqual(done.result?.blob_ids, [blob]);
    assert.equal(calls, 2);
    assert.ok(
      JSON.stringify(requests[1].input).includes(referenceTime.current_date),
    );
  });
  await test("soft yield keeps the same task and spends no failure budget", async () => {
    const scope = await user();
    await batch(scope, "added");
    const op = await flush(runtime, scope, "soft-yield");
    const originalClaim = maintenanceTasks.claimInTx.bind(maintenanceTasks);
    let first = true,
      calls = 0;
    maintenanceTasks.claimInTx = async (tx, id, options) => {
      const task = await originalClaim(tx, id, options);
      if (first && task && id === op.operation_id) {
        first = false;
        const row = await tx.query<{ started_at: Date }>(
          "UPDATE memoia.queue_tasks SET started_at=clock_timestamp()-interval '11 minutes 31 seconds' WHERE id=$1 RETURNING started_at",
          [id],
        );
        task.startedAt = row.rows[0].started_at;
      }
      return task;
    };
    globalThis.fetch = async () => {
      calls++;
      return response();
    };
    try {
      await consume(runtime, wake(scope, op.operation_id));
    } finally {
      maintenanceTasks.claimInTx = originalClaim;
    }
    const yielded = await db.transaction((tx) =>
      maintenanceTasks.readInTx(tx, op.operation_id),
    );
    assert.equal(yielded?.status, "pending");
    assert.equal(yielded.runAttempts, 1);
    assert.equal(yielded.failureCount, 0);
    assert.equal(calls, 0);
    await Promise.all([
      consume(runtime, wake(scope, op.operation_id)),
      consume(runtime, wake(scope, op.operation_id)),
    ]);
    const done = await db.transaction((tx) =>
      maintenanceTasks.readInTx(tx, op.operation_id),
    );
    assert.equal(done?.status, "succeeded");
    assert.equal(done.runAttempts, 2);
    assert.equal(done.failureCount, 0);
    assert.equal(calls, 1);
  });
  await test("SDK tool failures preserve original retry policy and resume the same flush", async () => {
    for (const failure of [
      Object.assign(new Error("query timeout"), { code: "57014" }),
      new Error("Connection terminated unexpectedly"),
      Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
      Object.assign(new Error("bad SQL"), { code: "42601" }),
      new SourceError("maintenance_read_conflict", "changed", 503, true),
      new SourceError("invalid_model_output", "invalid", 502),
    ]) {
      const scope = await user();
      const blob = await batch(scope, "added");
      const op = await flush(runtime, scope, "tool-failure");
      const originalQuery = db.query.bind(db);
      let calls = 0,
        failedReads = 0;
      globalThis.fetch = async () => {
        calls++;
        const payload = (await response().json()) as Record<string, unknown>;
        payload.output = [
          {
            type: "function_call",
            id: "fc",
            call_id: "call",
            name: "read_memory",
            arguments: JSON.stringify({
              collection: "facts",
              ids: null,
              cursor: null,
              query: "fact",
              limit: 10,
            }),
            status: "completed",
          },
        ];
        return Response.json(payload);
      };
      db.query = async (sql, values) => {
        if (sql.startsWith("SELECT * FROM memoia.memory_facts WHERE")) {
          failedReads++;
          throw failure;
        }
        return originalQuery(sql, values);
      };
      try {
        await consume(runtime, wake(scope, op.operation_id));
      } finally {
        db.query = originalQuery;
      }
      const row = await operationState(op.operation_id);
      const taskAfterFailure = await db.transaction((tx) =>
        maintenanceTasks.readInTx(tx, op.operation_id),
      );
      const retryable =
        failure instanceof SourceError
          ? failure.retryable
          : !("code" in failure && failure.code === "42601");
      assert.equal(
        taskAfterFailure?.status,
        retryable ? "retry_wait" : "failed",
      );
      assert.equal(row.status, retryable ? "processing" : "failed");
      assert.equal(row.error.retryable, retryable);
      assert.equal(
        row.error.code,
        failure instanceof SourceError ? failure.code : "maintenance_failed",
      );
      assert.equal(Number(row.attempts), 1);
      assert.equal(row.lease_owner, null);
      assert.equal(failedReads, 1);
      assert.equal(calls, 1);
      if (!retryable) continue;
      assert.ok(new Date(row.available_at).getTime() > Date.now());
      await consume(runtime, wake(scope, op.operation_id));
      assert.equal(
        calls,
        1,
        "duplicate Queue during backoff cannot replay the model",
      );
      await db.query(
        "UPDATE memoia.queue_tasks SET next_run_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [op.operation_id],
      );
      globalThis.fetch = async () => {
        calls++;
        return response();
      };
      await consume(runtime, wake(scope, op.operation_id));
      const completed = await operationState(op.operation_id);
      assert.equal(completed.status, "completed");
      assert.equal(
        (await getOperation(runtime, scope, { operationId: op.operation_id }))
          .error,
        null,
      );
      assert.equal(Number(completed.attempts), 2);
      assert.deepEqual(completed.result.blob_ids, [blob]);
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM memoia.memory_facts WHERE user_id=$1 AND project_id=$2",
            [scope.userId, scope.projectId],
          )
        ).rows[0].n,
        1,
      );
    }
  });
  await test("lost successful COMMIT response reads original task without replaying writes or model", async () => {
    const scope = await user();
    const blob = await batch(scope, "added");
    const op = await flush(runtime, scope, "lost-commit-response");
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return response();
    };
    const originalTransaction = db.transaction.bind(db);
    const originalComplete =
      maintenanceTasks.completeInTx.bind(maintenanceTasks);
    let completedInTransaction = false;
    maintenanceTasks.completeInTx = async (...args) => {
      const result = await originalComplete(...args);
      completedInTransaction = Boolean(result);
      return result;
    };
    db.transaction = async (fn, options) => {
      const result = await originalTransaction(fn, options);
      if (completedInTransaction) {
        completedInTransaction = false;
        throw new DatabaseUnavailableError();
      }
      return result;
    };
    try {
      await consume(runtime, wake(scope, op.operation_id));
    } finally {
      db.transaction = originalTransaction;
      maintenanceTasks.completeInTx = originalComplete;
    }
    const task = await db.transaction((tx) =>
      maintenanceTasks.readInTx(tx, op.operation_id),
    );
    assert.equal(task?.status, "succeeded");
    assert.deepEqual(task.result?.blob_ids, [blob]);
    await consume(runtime, wake(scope, op.operation_id));
    assert.equal(calls, 1);
    const state = await db.query(
      "SELECT version FROM memoia.memory_user_states WHERE user_id=$1 AND project_id=$2",
      [scope.userId, scope.projectId],
    );
    assert.equal(Number(state.rows[0].version), 1);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM memoia.memory_facts WHERE user_id=$1 AND project_id=$2",
          [scope.userId, scope.projectId],
        )
      ).rows[0].n,
      1,
    );
  });
  await test("persistent conversation locks retain the original operation for bounded recovery", async () => {
    const scope = await user();
    const blob = await batch(scope, "added");
    const op = await flush(runtime, scope, "locked");
    const tiers: string[] = [];
    globalThis.fetch = async (_input, init) => {
      tiers.push(JSON.parse(String(init?.body)).service_tier);
      return Response.json(
        {
          error: {
            code: "conversation_locked",
            type: "invalid_request_error",
            message: "locked",
          },
        },
        { status: 400 },
      );
    };
    await consume(runtime, wake(scope, op.operation_id));
    const row = await operationState(op.operation_id);
    assert.equal(row.status, "processing");
    assert.deepEqual(row.error, { code: "model_unavailable", retryable: true });
    assert.equal(Number(row.attempts), 1);
    assert.equal(row.lease_owner, null);
    assert.ok(tiers.length <= 4, "normal provider retry remains bounded");
    assert.deepEqual(tiers.slice(0, 2), ["flex", "default"]);
    await db.query(
      "UPDATE memoia.queue_tasks SET next_run_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [op.operation_id],
    );
    globalThis.fetch = async () => response();
    await consume(runtime, wake(scope, op.operation_id));
    const final = await operationState(op.operation_id);
    assert.equal(final.status, "completed");
    assert.deepEqual(final.result.blob_ids, [blob]);
  });
  await test("duplicate wakeups serialize per user while other users run and batch stays fixed", async () => {
    const a = await user(),
      b = await user();
    const firstBlob = await batch(a, "added");
    await batch(b, "added");
    const opA = await flush(runtime, a, "first");
    const opB = await flush(runtime, b, "first");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bothEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    globalThis.fetch = async () => {
      if (++calls === 2) entered();
      await gate;
      return response();
    };
    const running = [
      consume(runtime, wake(a, opA.operation_id)),
      consume(runtime, wake(b, opB.operation_id)),
    ];
    try {
      await Promise.race([
        bothEntered,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () =>
              reject(new Error("different users did not both reach provider")),
            5000,
          );
          timer.unref();
        }),
      ]);
      await consume(runtime, wake(a, opA.operation_id));
      assert.equal(calls, 2);
      const newBlob = await batch(a, "noop");
      const repeat = await flush(runtime, a, "first");
      assert.equal(repeat.operation_id, opA.operation_id);
      const fixed = (
        await db.query(
          "SELECT id,flush_operation_id FROM memoia.memory_blobs WHERE id=ANY($1::uuid[]) ORDER BY id",
          [[firstBlob, newBlob]],
        )
      ).rows;
      assert.equal(
        fixed.find((r) => r.id === firstBlob)?.flush_operation_id,
        opA.operation_id,
      );
      assert.equal(
        fixed.find((r) => r.id === newBlob)?.flush_operation_id,
        null,
      );
      release();
      await Promise.all(running);
      const rawRows = (
        await db.query(
          "SELECT * FROM memoia.memory_operations WHERE id=ANY($1::uuid[])",
          [[opA.operation_id, opB.operation_id]],
        )
      ).rows;
      const rows = await Promise.all(
        rawRows.map((row) => projectOperation(db, row)),
      );
      assert.equal(rows.length, 2);
      assert.ok(
        rows.every((r) => r.status === "completed" && Number(r.attempts) === 1),
      );
      const next = await flush(runtime, a, "next");
      assert.notEqual(next.operation_id, opA.operation_id);
      assert.deepEqual(next.flush.blob_ids, [newBlob]);
    } finally {
      release();
      await Promise.allSettled(running);
    }
  });
  await test("an unconfirmed notification retains the original operation for Cron redelivery", async () => {
    const scope = await user();
    await batch(scope, "noop");
    const op = await flush(runtime, scope, "unconfirmed-send");
    let sends = 0;
    const uncertain: Runtime = {
      ...runtime,
      deadline: Date.now() + 200,
      maintenanceWakeup: {
        send: async () => {
          sends++;
          await new Promise(() => {});
        },
      },
    };
    await retryFlush(uncertain, scope, op.operation_id);
    assert.equal(sends, 1);
    const pending = (
      await db.query(
        "SELECT status,run_attempts AS attempts,next_dispatch_at>clock_timestamp() AS reserved FROM memoia.queue_tasks WHERE id=$1",
        [op.operation_id],
      )
    ).rows[0];
    assert.equal(pending.status, "queued");
    assert.equal(Number(pending.attempts), 0);
    assert.equal(pending.reserved, true);
    await db.query(
      "UPDATE memoia.queue_tasks SET next_dispatch_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [op.operation_id],
    );
    const delivered: unknown[] = [];
    const resumed: Runtime = {
      ...runtime,
      maintenanceWakeup: {
        send: async (body: unknown) => {
          delivered.push(body);
        },
      },
    };
    await reconcile(resumed);
    assert.equal(
      delivered.filter((item: any) => item.operation_id === op.operation_id)
        .length,
      1,
    );
    await consume(resumed, wake(scope, op.operation_id));
    assert.equal(
      (
        await db.query("SELECT status FROM memoia.queue_tasks WHERE id=$1", [
          op.operation_id,
        ])
      ).rows[0].status,
      "succeeded",
    );
  });
  await test("a superseded flush owner cannot commit its old plan", async () => {
    const scope = await user();
    await batch(scope, "noop");
    const op = await flush(runtime, scope, "stale");
    const task = await db.transaction((tx) =>
      maintenanceTasks.claimInTx(tx, op.operation_id),
    );
    assert.ok(task?.leaseId);
    const owner = task.leaseId;
    const row = (
      await db.query("SELECT * FROM memoia.memory_operations WHERE id=$1", [
        op.operation_id,
      ])
    ).rows[0];
    const claim: Claim = {
      ...scope,
      id: row.id,
      owner,

      blobIds: row.request.blob_ids,
      changes: [],
    };
    const ctx = new MaintenanceContext(runtime, claim, async () => {});
    await ctx.prepare();
    const successor = crypto.randomUUID();
    await db.query(
      "UPDATE memoia.queue_tasks SET lease_id=$2,run_attempts=run_attempts+1 WHERE id=$1",
      [op.operation_id, successor],
    );
    await assert.rejects(ctx.commit(), /no longer owns/i);
    const after = (
      await db.query(
        "SELECT status,lease_id AS lease_owner,run_attempts AS generation,result FROM memoia.queue_tasks WHERE id=$1",
        [op.operation_id],
      )
    ).rows[0];
    assert.equal(after.status, "running");
    assert.equal(after.lease_owner, successor);
    assert.equal(
      String(after.generation),
      String(BigInt(task.runAttempts) + 1n),
    );
    assert.equal(after.result, null);
  });
} finally {
  globalThis.fetch = originalFetch;
  await db.query("DELETE FROM memoia.projects WHERE project_id=$1", [
    projectId,
  ]);
  await db.close();
}
