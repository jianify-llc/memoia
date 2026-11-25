import { test } from "node:test";
import assert from "node:assert/strict";
import type { QueryResultRow } from "pg";
import { SliceBudget, TaskTimeout, TaskYield } from "@jianify/legato";
import {
  Database,
  DatabaseUnavailableError,
  type Sql,
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
import { createUser, updateEvent } from "../src/management";
import worker from "../src/index";
import { createApp } from "../src/http";
import { createCloudflareRuntime } from "../src/cloudflare-runtime";
import type { Runtime } from "../src/runtime";
import { SourceError } from "../src/errors";
import {
  deleteMessages,
  forgetUser,
  prepareFactAppend,
  getOperation,
  listOperations,
  purgeExpiredInputs,
  retryOperation,
  stageImport,
} from "../src/facts";
import { runFactAgent } from "../src/fact-agent";
import { flushBlob } from "../src/fact-flush";
import { claimTask, maintenanceTasks, projectOperation } from "../src/maintenance-task";
import { getConfig } from "../src/models";

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

test("Cron separates maintenance, input expiry and usage expiry", async (t) => {
  const statements: string[] = [];
  t.mock.method(Database.prototype, "query", async (sql: string, _values?: unknown[], operation?: string) => {
    statements.push(operation === "purge_expired_inputs" ? operation : sql.split(/\s+/, 3).join(" "));
    return { rows: [] };
  });
  t.mock.method(Database.prototype, "transaction", async () => {
    assert.fail("idle Cron should not open a transaction");
  });
  const env = {
    ...runtime.env,
    HYPERDRIVE: { connectionString: process.env.MEMOIA_TEST_DATABASE_URL! },
  };
  await worker.scheduled({ cron: "* * * * *" } as ScheduledController, env);
  assert.deepEqual(statements.splice(0), ["WITH expired AS", "SELECT * FROM"]);

  await worker.scheduled({ cron: "*/5 * * * *" } as ScheduledController, env);
  assert.deepEqual(statements.splice(0), ["purge_expired_inputs"]);

  await worker.scheduled({ cron: "0 0 * * *" } as ScheduledController, env);
  assert.deepEqual(statements, ["DELETE FROM memoia.usage_counters"]);
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

const sourceMessage = (message_id: string) => ({
  message_id,
  role: "user" as const,
  occurred_at: "2026-11-19T10:00:00Z",
  content: `I drink tea (${message_id}).`,
});
const factCandidate = (message_id: string) => ({
  messages: [
    {
      message_id,
      facts: [
        {
          content: "The user drinks tea.",
          subject: "the user",
          reporter: "the user",
          certainty: "asserted",
          fact_time: null,
          any_of: [{ all_of: [message_id] }],
        },
      ],
    },
  ],
});
const toolResponse = (name: string, args: unknown) =>
  Response.json({
    id: `resp_${crypto.randomUUID()}`,
    status: "completed",
    model: "gpt-6-luna",
    usage: {
      input_tokens: 7,
      output_tokens: 3,
      total_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    output: [
      {
        id: `fc_fixture_${crypto.randomUUID()}`,
        call_id: `call_fixture_${crypto.randomUUID()}`,
        type: "function_call",
        status: "completed",
        name,
        arguments: JSON.stringify(args),
      },
    ],
  });
async function importGroup(
  scope: Awaited<ReturnType<typeof user>>,
  ids: string[],
) {
  const staged = [];
  for (const id of ids) {
    const receipt = await stageImport(runtime, scope, {
      source_id: "s",
      idempotency_key: `stage-${id}`,
      messages: [sourceMessage(id)],
    });
    assert.ok(receipt.blob_id);
    staged.push({ blobId: receipt.blob_id, operationId: receipt.operation_id });
  }
  const { operation_id } = await flushBlob(runtime, scope, "s", {
    idempotency_key: "seal",
    append_operation_ids: staged.map((row) => row.operationId),
  });
  return {
    staged,
    id: operation_id,
    message: { ...wake(scope, operation_id), kind: "fact_flush" as const },
  };
}

try {
  await db.query(
    "INSERT INTO memoia.projects(id,project_id,project_secret,status) VALUES($1,$2,$3,'active')",
    [crypto.randomUUID(), projectId, `sk-${projectId}-local`],
  );
  await test("a deletion receipt returns while its Queue hint is unconfirmed and Cron can recover it", async () => {
    const scope = await user();
    const blobId = await batch(scope, "added");
    const {
      rows: [{ message_id: messageId }],
    } = await db.query(
      "SELECT message_id FROM memoia.memory_messages WHERE user_id=$1 AND project_id=$2",
      [scope.userId, scope.projectId],
    );
    const pending: Promise<unknown>[] = [];
    let rejectDelivery!: (error: Error) => void;
    const delivery = new Promise<never>((_, reject) => {
      rejectDelivery = reject;
    });
    const sent: unknown[] = [];
    const env = {
      ...runtime.env,
      HYPERDRIVE: { connectionString: process.env.MEMOIA_TEST_DATABASE_URL! },
      waitUntil(work: Promise<unknown>) {
        pending.push(work);
      },
      MAINTENANCE_QUEUE: {
        send(message: unknown, options: unknown) {
          sent.push([message, options]);
          return delivery;
        },
      },
    };
    const request = new Request(
      `https://local.test/api/users/${scope.userId}/sources/s/messages`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer sk-${projectId}-local`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          idempotency_key: "retract",
          message_ids: [messageId],
        }),
      },
    );
    const response = createApp(createCloudflareRuntime).fetch(request, env);
    try {
      const result = await Promise.race([
        response,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("HTTP is still waiting for the Queue")),
            3000,
          );
          timer.unref();
        }),
      ]);
      assert.equal(result.status, 200);
      const receipt = (await result.json()) as {
        operation_id: string;
        status: string;
      };
      assert.equal(receipt.status, "completed");
      assert.equal(
        (
          await getOperation(runtime, scope, {
            operationId: receipt.operation_id,
          })
        ).status,
        "completed",
      );
      assert.equal(pending.length, 1);
      assert.deepEqual(sent, [
        [
          { kind: "user", user_id: scope.userId, project_id: projectId },
          { delaySeconds: 30 },
        ],
      ]);
      rejectDelivery(new Error("Queue unavailable"));
      await Promise.all(pending);
      await db.query(
        "UPDATE memoia.memory_blobs SET fact_completed_at=clock_timestamp()-interval '31 seconds' WHERE user_id=$1 AND project_id=$2",
        [scope.userId, projectId],
      );
      const recovered: string[] = [];
      await reconcile({
        ...runtime,
        maintenanceWakeup: {
          async send(message) {
            if (message.kind === "flush" && message.user_id === scope.userId)
              recovered.push(message.operation_id);
          },
        },
      });
      assert.equal(recovered.length, 1);
      assert.ok(
        (await operationState(recovered[0])).request.blob_ids.includes(blobId),
      );
    } finally {
      void delivery.catch(() => {});
      rejectDelivery(new Error("Test finished"));
      await Promise.resolve(response).catch(() => {});
      await Promise.allSettled(pending);
    }
  });
  await test("Fact flush keeps its committed receipt when dispatch reservation fails and Cron reuses the Task", async (t) => {
    const scope = await user();
    const appended = await stageImport(runtime, scope, {
      source_id: "s",
      idempotency_key: "upload",
      messages: [sourceMessage("reserve")],
    });
    const input = {
      idempotency_key: "seal",
      append_operation_ids: [appended.operation_id],
    };
    const reserve = maintenanceTasks.reserveDispatchInTx.bind(maintenanceTasks);
    let attemptedId: string | undefined;
    t.mock.method(
      maintenanceTasks,
      "reserveDispatchInTx",
      async (sql: Sql, id: string, limit?: number) => {
        if (!attemptedId) {
          attemptedId = id;
          throw new DatabaseUnavailableError();
        }
        return reserve(sql, id, limit);
      },
    );
    const deliveries: Extract<
      import("../src/runtime").Wakeup,
      { kind: "fact_flush" }
    >[] = [];
    const queuedRuntime: Runtime = {
      ...runtime,
      maintenanceWakeup: {
        async send(message) {
          if (message.kind === "fact_flush" && message.user_id === scope.userId)
            deliveries.push(message);
        },
      },
    };
    const api = createApp(() => ({ ...queuedRuntime, ownsDatabase: false }));
    const response = await api.request(
      `/api/users/${scope.userId}/blobs/s/flush`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer sk-${projectId}-local`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      },
      runtime.env,
    );
    assert.equal(response.status, 202);
    const receipt = (await response.json()) as Awaited<
      ReturnType<typeof flushBlob>
    >;
    assert.equal(attemptedId, receipt.operation_id);
    assert.equal(receipt.status, "processing");
    assert.deepEqual(deliveries, []);
    assert.deepEqual(
      await getOperation(runtime, scope, { key: "seal" }),
      receipt,
    );
    await reconcile(queuedRuntime);
    assert.deepEqual(deliveries, [
      { ...wake(scope, receipt.operation_id), kind: "fact_flush" },
    ]);
    assert.deepEqual(await flushBlob(runtime, scope, "s", input), receipt);
    globalThis.fetch = async () =>
      toolResponse("finish_facts", { candidate: factCandidate("reserve") });
    await consume(queuedRuntime, deliveries[0]);
    const completed = await getOperation(runtime, scope, { key: "seal" });
    assert.equal(completed.operation_id, receipt.operation_id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.fact_ids.length, 1);
  });
  await test("two automatic wakeups that both see due work register only one flush", async (t) => {
    const scope = await user();
    const blob = await batch(scope, "added");
    await db.query(
      "UPDATE memoia.memory_blobs SET fact_completed_at=clock_timestamp()-interval '31 seconds' WHERE id=$1",
      [blob],
    );
    let bothRead!: () => void;
    const bothSawDue = new Promise<void>((resolve) => {
      bothRead = resolve;
    });
    const query = db.query.bind(db);
    let dueReads = 0;
    t.mock.method(db, "query", async (sql: string, values: unknown[]) => {
      const result = await query(sql, values);
      if (sql.includes(" AS due") && values[0] === scope.userId) {
        assert.ok(result.rows[0].due);
        if (++dueReads === 2) bothRead();
        await bothSawDue;
      }
      return result;
    });
    const wakeup = {
      kind: "user" as const,
      user_id: scope.userId,
      project_id: projectId,
    };
    await Promise.all([consume(runtime, wakeup), consume(runtime, wakeup)]);
    assert.equal((await getStatus(runtime, scope)).flushes.length, 1);
  });
  await test("all-noop flush prepares once and completes without contacting a provider", async (t) => {
    const scope = await user();
    await batch(scope, "noop");
    const op = await flush(runtime, scope, "noop");
    const prepare = t.mock.method(MaintenanceContext.prototype, "prepare");
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new Error("unexpected provider call");
    };
    await consume(runtime, wake(scope, op.operation_id));
    const row = await operationState(op.operation_id);
    assert.equal(row.status, "completed");
    assert.equal(calls, 0);
    assert.equal(prepare.mock.callCount(), 1);
    assert.equal(row.result.blob_ids.length, 1);
  });
  await test("receipt reads join Legato state in one query and leave payloads in PostgreSQL", async (t) => {
    const scope = await user();
    await batch(scope, "noop");
    const first = await flush(runtime, scope, "page-one");
    await batch(scope, "noop");
    await flush(runtime, scope, "page-two");
    await db.query(
      `UPDATE memoia.queue_tasks SET execution_state='{"checkpoint":"private"}' WHERE id=$1`,
      [first.operation_id],
    );
    const appended = await stageImport(runtime, scope, {
      source_id: "s",
      idempotency_key: "private-input",
      messages: [sourceMessage("private")],
    });
    const statement = db.query.bind(db);
    const reads: string[] = [];
    t.mock.method(
      db,
      "query",
      async (...args: Parameters<Database["query"]>) => {
        const result = await statement(...args);
        if (args[0].includes("LEFT JOIN memoia.queue_tasks")) {
          reads.push(args[0]);
          for (const row of result.rows) {
            assert.equal(row.request?.messages, undefined);
            assert.equal(row.execution_state, undefined);
            assert.equal(row.task_execution_state, undefined);
          }
        }
        return result;
      },
    );
    assert.equal((await getStatus(runtime, scope)).flushes.length, 2);
    assert.equal((await listOperations(runtime, scope)).length, 3);
    assert.deepEqual(
      await getOperation(runtime, scope, { key: "private-input" }),
      appended,
    );
    assert.equal(reads.length, 3);
  });
  await test("receipt already read with its Task stays consistent across permanent forgetting", async (t) => {
    const scope = await user();
    await batch(scope, "noop");
    const receipt = await flush(runtime, scope, "forget-during-read");
    const statement = db.query.bind(db);
    let forgotten = false;
    t.mock.method(
      db,
      "query",
      async (...args: Parameters<Database["query"]>) => {
        const result = await statement(...args);
        if (!forgotten && args[1]?.[2] === receipt.operation_id) {
          forgotten = true;
          await forgetUser(runtime, scope);
        }
        return result;
      },
    );
    assert.deepEqual(
      await getOperation(runtime, scope, { operationId: receipt.operation_id }),
      receipt,
    );
    assert.ok(forgotten);
    await assert.rejects(
      getOperation(runtime, scope, { operationId: receipt.operation_id }),
      (error) => error instanceof SourceError && error.status === 404,
    );
  });

  await test("Fact soft yield preserves new evidence coverage and charges a no-progress attempt only after a model call", async () => {
    const scope = await user();
    const messages = [sourceMessage("progress"), sourceMessage("other")];
    const attempt = () => {
      const startedAt = Date.now();
      let clock = startedAt;
      const budget = new SliceBudget(startedAt, undefined, () => clock);
      return {
        budget,
        reachSoftLimit: () => {
          clock = budget.softDeadlineAt;
        },
      };
    };
    const saved: { messages: { message_id: string; facts: unknown[] }[] }[] =
      [];
    const save = async (draft: (typeof saved)[number]) => {
      saved.push(draft);
    };
    let calls = 0;
    const before = attempt();
    before.reachSoftLimit();
    globalThis.fetch = async () => {
      calls++;
      throw new Error("unexpected model request");
    };
    await assert.rejects(
      runFactAgent(
        runtime,
        scope,
        messages,
        before.budget,
        null,
        save,
        async () => {},
      ),
      TaskYield,
    );
    assert.equal(calls, 0);

    const noProgress = attempt();
    globalThis.fetch = async () => {
      calls++;
      noProgress.reachSoftLimit();
      return toolResponse("check_facts", {});
    };
    await assert.rejects(
      runFactAgent(
        runtime,
        scope,
        messages,
        noProgress.budget,
        null,
        save,
        async () => {},
      ),
      { code: "fact_no_progress", retryable: true },
    );
    assert.equal(calls, 1);
    assert.equal(saved.length, 0);

    const progress = attempt();
    globalThis.fetch = async () => {
      progress.reachSoftLimit();
      return toolResponse("stage_facts", factCandidate("progress"));
    };
    await assert.rejects(
      runFactAgent(
        runtime,
        scope,
        messages,
        progress.budget,
        null,
        save,
        async () => {},
      ),
      TaskYield,
    );
    assert.deepEqual(saved, [factCandidate("progress")]);

    const wrong = factCandidate("progress");
    wrong.messages[0]!.facts[0]!.any_of[0]!.all_of.push("missing");
    const repair = attempt();
    globalThis.fetch = async () => {
      repair.reachSoftLimit();
      return toolResponse("stage_facts", factCandidate("progress"));
    };
    await assert.rejects(
      runFactAgent(
        runtime,
        scope,
        messages,
        repair.budget,
        wrong,
        save,
        async () => {},
      ),
      TaskYield,
    );
    assert.deepEqual(saved.at(-1), factCandidate("progress"));

    const repeated = attempt();
    globalThis.fetch = async () => {
      repeated.reachSoftLimit();
      return toolResponse("stage_facts", factCandidate("progress"));
    };
    await assert.rejects(
      runFactAgent(
        runtime,
        scope,
        messages,
        repeated.budget,
        saved[0]!,
        save,
        async () => {},
      ),
      { code: "fact_no_progress" },
    );

    globalThis.fetch = async () =>
      toolResponse("finish_facts", { candidate: null });
    const resumed = await runFactAgent(
      runtime,
      scope,
      messages,
      attempt().budget,
      { messages: [...saved[0]!.messages, { message_id: "other", facts: [] }] },
      save,
      async () => {},
    );
    assert.deepEqual(resumed[0]?.support_groups, [["progress"]]);
  });
  await test("Fact flush recovers beyond four lost slices", async () => {
    const scope = await user();
    const group = await importGroup(scope, ["first", "second"]);
    const attempted: string[] = [];
    for (let i = 0; i < 5; i++) {
      const claimed = await maintenanceTasks.claimInTx(db, group.id);
      assert.ok(claimed?.leaseId);
      if (i === 0) {
        let now = Date.now();
        const budget = new SliceBudget(now, undefined, () => now);
        globalThis.fetch = async () => {
          now = budget.hardDeadlineAt;
          return toolResponse("check_facts", {});
        };
        await assert.rejects(
          prepareFactAppend(
            runtime,
            scope,
            group.id,
            claimed.leaseId,
            group.staged[0]!.operationId,
            budget,
            () => getConfig(runtime, scope.projectId),
          ),
          TaskTimeout,
        );
      } else if (i === 1) {
        globalThis.fetch = async () => {
          attempted.push("first");
          return toolResponse("finish_facts", {
            candidate: factCandidate("first"),
          });
        };
        await prepareFactAppend(
          runtime,
          scope,
          group.id,
          claimed.leaseId,
          group.staged[0]!.operationId,
          new SliceBudget(Date.now(), undefined),
          () => getConfig(runtime, scope.projectId),
        );
        const isolated = await db.query(
          "SELECT count(*)::int AS n FROM memoia.memory_facts WHERE user_id=$1 AND project_id=$2",
          [scope.userId, scope.projectId],
        );
        assert.equal(isolated.rows[0]?.n, 0);
      }
      await db.query(
        "UPDATE memoia.queue_tasks SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [group.id],
      );
      await reconcile(runtime);
      const revoked = await maintenanceTasks.readInTx(db, group.id);
      assert.equal(revoked?.status, "retry_wait");
      assert.equal(revoked?.failureCount, i + 1);
      await db.query(
        "UPDATE memoia.queue_tasks SET next_run_at=clock_timestamp() WHERE id=$1",
        [group.id],
      );
    }
    const pending = await db.query(
      "SELECT status,attempts,available_at FROM memoia.memory_operations WHERE id=$1",
      [group.staged[0]!.operationId],
    );
    assert.equal(pending.rows[0]?.status, "processing");
    assert.equal(Number(pending.rows[0]?.attempts), 0);
    assert.equal(pending.rows[0]?.available_at, null);
    globalThis.fetch = async (_url, init) => {
      const id = String(init?.body).includes("I drink tea (second).")
        ? "second"
        : "first";
      attempted.push(id);
      return toolResponse("finish_facts", { candidate: factCandidate(id) });
    };
    await consume(runtime, group.message);
    assert.deepEqual(attempted, ["first", "second"]);
    assert.equal((await operationState(group.id)).status, "completed");
  });
  await test("Fact append loads primary input with its checkpoint and resumes a reviewed candidate", async () => {
    const scope = await user();
    const group = await importGroup(scope, ["config"]);
    const appendId = group.staged[0]!.operationId;
    const claimed = await maintenanceTasks.claimInTx(db, group.id);
    assert.ok(claimed?.leaseId);
    const owner = claimed.leaseId;
    const withEmbeddings = {
      ...runtime,
      env: { ...runtime.env, MEMOIA_CONFIG: "{}" },
    };
    const statement = db.query.bind(db);
    let configReads = 0;
    let inputReads = 0;
    let modelCalls = 0;
    let embeddingCalls = 0;
    db.query = async <Row extends QueryResultRow>(
      sql: string,
      values?: unknown[],
      operation?: Parameters<typeof statement>[2],
    ) => {
      const result = await statement<Row>(sql, values, operation);
      if (sql.includes("SELECT profile_config FROM memoia.projects")) configReads++;
      if (sql.includes("SELECT message FROM inputs WHERE append_id=$2")) {
        inputReads++;
        const row = result.rows[0];
        assert.ok(row && "input_revision" in row && "messages" in row);
        assert.equal("request" in row, false);
        assert.equal(row.messages === null, row.reviewed !== null);
      }
      return result;
    };
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith("/embeddings")) {
        embeddingCalls++;
        return Response.json({
          data: [{ index: 0, embedding: Array(1536).fill(0.01) }],
        });
      }
      modelCalls++;
      const id = String(init?.body).includes("I drink tea (config-second).")
        ? "config-second"
        : "config";
      return toolResponse("finish_facts", { candidate: factCandidate(id) });
    };
    const prepare = () => {
      let configRead: ReturnType<typeof getConfig> | undefined;
      return prepareFactAppend(
        withEmbeddings,
        scope,
        group.id,
        owner,
        appendId,
        new SliceBudget(Date.now(), undefined),
        () => (configRead ??= getConfig(withEmbeddings, scope.projectId)),
      );
    };
    const checkpoint = async () => (
      await db.query(
        "SELECT request->'fact_prepared' AS prepared FROM memoia.memory_operations WHERE id=$1",
        [appendId],
      )
    ).rows[0]?.prepared;
    try {
      await prepare();
      const first = await checkpoint();
      assert.equal(first.facts.length, 1);
      assert.equal(first.vectors[0].length, 1536);
      assert.deepEqual(
        { configReads, inputReads, modelCalls, embeddingCalls },
        { configReads: 1, inputReads: 1, modelCalls: 1, embeddingCalls: 1 },
      );

      // Reproduce a restart after the review candidate was saved, before vectors were committed.
      await db.query(
        "UPDATE memoia.memory_operations SET request=request-'fact_prepared' WHERE id=$1",
        [appendId],
      );
      configReads = inputReads = modelCalls = embeddingCalls = 0;
      await prepare();
      assert.deepEqual(await checkpoint(), first);
      assert.deepEqual(
        { configReads, inputReads, modelCalls, embeddingCalls },
        { configReads: 1, inputReads: 1, modelCalls: 0, embeddingCalls: 1 },
      );

      const freshScope = await user();
      const batch = await importGroup(freshScope, ["config", "config-second"]);
      configReads = inputReads = modelCalls = embeddingCalls = 0;
      await consume(withEmbeddings, batch.message);
      assert.equal((await operationState(batch.id)).status, "completed");
      assert.deepEqual(
        { configReads, inputReads, modelCalls, embeddingCalls },
        { configReads: 1, inputReads: 2, modelCalls: 2, embeddingCalls: 2 },
      );
    } finally {
      globalThis.fetch = originalFetch;
      db.query = statement;
    }
  });
  for (const [phase, status] of [
    ["responses", 400],
    ["responses", 401],
    ["embeddings", 401],
  ] as const) {
    await test(`shared ${phase} HTTP ${status} preserves input and retries the same group`, async () => {
      const scope = await user();
      const fixtureRuntime =
        phase === "responses"
          ? runtime
          : {
              ...runtime,
              env: { ...runtime.env, MEMOIA_CONFIG: "{}" },
            };
      const group = await importGroup(scope, ["credential", "waiting"]);
      let reject = true;
      let modelCalls = 0;
      globalThis.fetch = async (url, init) => {
        if (reject && String(url).endsWith(`/${phase}`))
          return Response.json(
            {
              error:
                status === 400
                  ? {
                      message: "Unsupported effort",
                      code: "unsupported_value",
                      param: "reasoning.effort",
                    }
                  : { message: "Unauthorized" },
            },
            { status },
          );
        if (String(url).endsWith("/embeddings"))
          return Response.json({
            data: [{ index: 0, embedding: Array(1536).fill(0.01) }],
          });
        modelCalls++;
        const id = String(init?.body).includes("I drink tea (credential).")
          ? "credential"
          : "waiting";
        return toolResponse("finish_facts", { candidate: factCandidate(id) });
      };
      await consume(fixtureRuntime, group.message);
      const deferred = await maintenanceTasks.readInTx(db, group.id);
      assert.equal(deferred?.status, "retry_wait");
      assert.equal(
        deferred?.lastFailure?.resultCode,
        phase === "responses"
          ? "model_configuration_rejected"
          : "embedding_configuration_rejected",
      );
      const children = await db.query(
        "SELECT attempts,status,request FROM memoia.memory_operations WHERE fact_flush_id=$1",
        [group.id],
      );
      assert.equal(children.rowCount, 2);
      for (const child of children.rows) {
        assert.equal(Number(child.attempts), 0);
        assert.equal(child.status, "processing");
        assert.equal(child.request.messages.length, 1);
      }
      await db.query(
        "UPDATE memoia.queue_tasks SET next_run_at=clock_timestamp() WHERE id=$1",
        [group.id],
      );
      reject = false;
      await consume(fixtureRuntime, group.message);
      assert.equal((await operationState(group.id)).status, "completed");
      assert.equal(modelCalls, 2);
    });
  }
  await test("Fact commit rolls back when input expires after its Fact inserts", async (t) => {
    const scope = await user();
    const group = await importGroup(scope, ["expiring"]);
    const input = group.staged[0]!;
    const internal = (await operationState(input.operationId)).blob_id;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return toolResponse("finish_facts", {
        candidate: factCandidate("expiring"),
      });
    };
    let expired = false;
    const transaction = db.transaction.bind(db);
    t.mock.method(db, "transaction", ((run, options) =>
      transaction((tx) => {
        const query: Sql["query"] = async <
          T extends import("pg").QueryResultRow,
        >(
          sql: string,
          values?: unknown[],
        ) => {
          const result = await tx.query<T>(sql, values);
          if (
            !expired &&
            sql.trimStart().startsWith("INSERT INTO memoia.memory_facts") &&
            values?.includes(internal)
          ) {
            expired = true;
            await db.query(
              "UPDATE memoia.memory_operations SET input_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
              [input.operationId],
            );
            await purgeExpiredInputs(runtime);
          }
          return result;
        };
        return run({ query });
      }, options)) as typeof db.transaction);
    await consume(runtime, group.message);
    assert.equal(expired, true);
    const facts = await db.query(
      "SELECT 1 FROM memoia.memory_facts WHERE blob_id=$1",
      [internal],
    );
    assert.equal(facts.rowCount, 0);
    const messages = await db.query(
      "SELECT processed FROM memoia.memory_messages WHERE user_id=$1 AND project_id=$2 AND source_id='s'",
      [scope.userId, scope.projectId],
    );
    assert.equal(messages.rows[0]?.processed, false);
    const blob = await db.query(
      "SELECT fact_completed_at FROM memoia.memory_blobs WHERE id=$1",
      [internal],
    );
    assert.equal(blob.rows[0]?.fact_completed_at, null);
    const failed = await operationState(input.operationId);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error.code, "input_required");
    assert.equal(failed.request.messages, undefined);
    await consume(runtime, group.message);
    assert.equal((await operationState(group.id)).status, "failed");
    assert.equal(calls, 1);
  });
  for (const timing of ["before", "after"] as const) {
    await test(`message retraction ${timing} the Fact candidate write prevents stale replay`, async (t) => {
      const scope = await user();
      const staged = await stageImport(runtime, scope, {
        source_id: "s",
        idempotency_key: "stage-photo",
        messages: [
          {
            ...sourceMessage("photo"),
            visual_description: "Private image description.",
          },
        ],
      });
      assert.ok(staged.blob_id);
      const { operation_id } = await flushBlob(runtime, scope, "s", {
        idempotency_key: "seal",
        append_operation_ids: [staged.operation_id],
      });
      const message = {
        ...wake(scope, operation_id),
        kind: "fact_flush" as const,
      };
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return toolResponse("finish_facts", {
          candidate: factCandidate("photo"),
        });
      };
      let withdrawn = false;
      const withdraw = () => deleteMessages(runtime, scope, "s", {
        idempotency_key: "delete",
        message_ids: ["photo"],
      });
      const query = db.query.bind(db);
      t.mock.method(db, "query", async (sql: string, values?: unknown[]) => {
        if (!withdrawn && sql.includes("request=jsonb_set(o.request,ARRAY") &&
            values?.[4] === staged.operation_id && values?.[6] === "fact_review_candidate") {
          withdrawn = true;
          if (timing === "before") await withdraw();
          const result = await query(sql, values);
          assert.equal(result.rowCount, timing === "before" ? 0 : 1);
          if (timing === "after") await withdraw();
          return result;
        }
        return query(sql, values);
      });
      await consume(runtime, message);
      assert.equal(withdrawn, true);
      const interrupted = await operationState(staged.operation_id);
      assert.equal(interrupted.status, "processing");
      assert.deepEqual(interrupted.request.messages, []);
      assert.equal(interrupted.request.fact_review_candidate, undefined);
      await consume(runtime, message);
      assert.equal((await operationState(operation_id)).status, "completed");
      const completed = await operationState(staged.operation_id);
      assert.deepEqual(completed.result.fact_ids, []);
      assert.equal(completed.request.messages, undefined);
      assert.equal(calls, 1);
    });
  }
  await test("many appends share the session Blob and an append arriving during extraction waits for a later flush", async () => {
    const scope = await user();
    const group = await importGroup(scope, ["first", "second"]);
    const factUsage = () =>
      db.query(
        "SELECT usage->>'kind' AS kind,(usage->>'input_tokens')::int AS input,(usage->>'output_tokens')::int AS output FROM memoia.usage_events WHERE project_id=$1 AND user_id=$2",
        [scope.projectId, scope.userId],
      );
    const replay = await stageImport(runtime, scope, {
      source_id: "s",
      idempotency_key: "stage-first",
      messages: [sourceMessage("first")],
    });
    assert.equal(replay.operation_id, group.staged[0]!.operationId);
    assert.equal(replay.blob_id, "s");
    const repeated = await flushBlob(runtime, scope, "s", {
      idempotency_key: "seal",
      append_operation_ids: group.staged.map((a) => a.operationId).reverse(),
    });
    assert.equal(repeated.operation_id, group.id);
    assert.equal((await factUsage()).rows.length, 0);

    let tail: Awaited<ReturnType<typeof stageImport>> | undefined;
    const attempted: string[] = [];
    globalThis.fetch = async (_url, init) => {
      const payload = String(init?.body);
      const id = ["first", "second", "late"].find((m) =>
        payload.includes(`tea (${m})`),
      )!;
      attempted.push(id);
      if (!tail) {
        tail = await stageImport(runtime, scope, {
          source_id: "s",
          idempotency_key: "stage-late",
          messages: [sourceMessage("first"), sourceMessage("late")],
        });
        await assert.rejects(
          flushBlob(runtime, scope, "s", {
            idempotency_key: "seal-late",
            append_operation_ids: [tail.operation_id],
          }),
          { code: "fact_flush_in_progress" },
        );
      }
      return toolResponse("finish_facts", { candidate: factCandidate(id) });
    };
    await consume(runtime, group.message);
    assert.equal((await operationState(group.id)).result.fact_ids.length, 2);
    assert.deepEqual(attempted, ["first", "second"]);
    assert.deepEqual((await factUsage()).rows, [
      { kind: "fact_extraction", input: 7, output: 3 },
      { kind: "fact_extraction", input: 7, output: 3 },
    ]);
    assert.equal(tail!.blob_id, "s");
    assert.equal((await operationState(tail!.operation_id)).status, "staged");
    const incremental = await flushBlob(runtime, scope, "s", {
      idempotency_key: "seal-late",
      append_operation_ids: [tail!.operation_id],
    });
    await consume(runtime, {
      ...wake(scope, incremental.operation_id),
      kind: "fact_flush",
    });
    assert.deepEqual(attempted, ["first", "second", "late"]);
    assert.equal((await factUsage()).rows.length, 3);
    const {
      rows: [visible],
    } = await db.query(
      `SELECT count(DISTINCT b.id)::int AS blobs,count(f.id)::int AS facts
        FROM memoia.memory_blobs b LEFT JOIN memoia.memory_facts f ON f.blob_id=b.id
        WHERE b.user_id=$1 AND b.project_id=$2 AND b.kind='import'`,
      [scope.userId, scope.projectId],
    );
    assert.deepEqual(visible, { blobs: 1, facts: 3 });
  });
  await test("maintenance uses the last explicit effort from appends that actually publish Facts", async () => {
    const taskEffort = async (id: string) => (await db.query(
      "SELECT biz_params->>'reasoning_effort' AS effort FROM memoia.queue_tasks WHERE id=$1",
      [id],
    )).rows[0].effort;
    for (const scenario of [null, "medium", "high", "legacy"] as const) {
      const expected = scenario === "legacy" ? "medium" : scenario;
      const scope = await user();
      const append = (id: string, effort?: "medium" | "high") =>
        stageImport(runtime, scope, {
          source_id: "s", idempotency_key: `stage-${id}`,
          messages: [sourceMessage(id)],
          ...(effort ? { maintenance_reasoning_effort: effort } : {}),
        });
      const receipts = [
        await append("first", expected ? "medium" : undefined),
        await append("second", expected === "high" ? "high" : undefined),
        await append("third"),
        await append("noop", expected === "high" ? "medium" : "high"),
      ];
      globalThis.fetch = async (_url, init) => {
        const id = ["first", "second", "third", "noop"].find(
          (name) => String(init?.body).includes(`tea (${name})`),
        )!;
        const candidate = factCandidate(id);
        if (id === "noop") candidate.messages[0].facts = [];
        return toolResponse("finish_facts", { candidate });
      };
      const publish = async (key: string, ids: string[]) => {
        const op = await flushBlob(runtime, scope, "s", {
          idempotency_key: key, append_operation_ids: ids,
        });
        if (scenario === "medium" && key === "seal") {
          // A Fact task sealed by the old worker can still complete on the new worker.
          await db.query(
            "UPDATE memoia.memory_operations SET request=request || '{\"maintenance_reasoning_effort\":\"high\"}'::jsonb WHERE id=$1",
            [op.operation_id],
          );
        }
        await consume(runtime, { ...wake(scope, op.operation_id), kind: "fact_flush" });
        const result = await operationState(op.operation_id);
        assert.equal(result.status, "completed");
        return result;
      };
      const first = await publish("seal", receipts.map((r) => r.operation_id).reverse());
      assert.equal(first.result.fact_ids.length, 3);
      if (scenario === "legacy") {
        // An older worker saved the override on the completed Fact flush receipt.
        await db.query(
          "UPDATE memoia.memory_operations SET request=request || '{\"maintenance_reasoning_effort\":\"medium\"}'::jsonb WHERE id=$1",
          [first.id],
        );
        await db.query(
          `UPDATE memoia.memory_blobs b SET fact_changes=(
             SELECT jsonb_agg(change-'maintenance_reasoning_effort' ORDER BY position)
             FROM jsonb_array_elements(b.fact_changes) WITH ORDINALITY AS changes(change,position)
           ) FROM memoia.memory_operations o WHERE o.id=$1 AND b.id=o.blob_id`,
          [first.id],
        );
      }
      const later = await append("later");
      globalThis.fetch = async () => toolResponse("finish_facts", { candidate: factCandidate("later") });
      assert.equal((await publish("seal-later", [later.operation_id])).result.fact_ids.length, 1);
      const maintenance = await flush(runtime, scope, "derived");
      assert.equal(await taskEffort(maintenance.operation_id), expected);
    }
  });
  await test("deletion from an unsealed tail preserves the active range and its Blob status", async () => {
    const scope = await user();
    const group = await importGroup(scope, ["active"]);
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) {
        await stageImport(runtime, scope, {
          source_id: "s", idempotency_key: "late",
          messages: [sourceMessage("late")],
        });
        await deleteMessages(runtime, scope, "s", {
          idempotency_key: "remove-late", message_ids: ["late"],
        });
      }
      return toolResponse("finish_facts", { candidate: factCandidate("active") });
    };
    await consume(runtime, group.message);
    assert.equal(calls, 1);
    assert.equal((await operationState(group.id)).result.fact_ids.length, 1);
    await deleteMessages(runtime, scope, "s", {
      idempotency_key: "remove-active", message_ids: ["active"],
    });
    const lateReplay = await stageImport(runtime, scope, {
      source_id: "s", idempotency_key: "late",
      messages: [sourceMessage("late")],
    });
    const saved = await operationState(lateReplay.operation_id);
    assert.deepEqual(saved.request.messages, []);
    const blob = await db.query("SELECT status FROM memoia.memory_blobs WHERE id=$1", [saved.blob_id]);
    assert.equal(blob.rows[0]?.status, "retracted");
  });

  await test("explicit retry resumes the original Fact range without re-extracting prepared siblings", async () => {
    const scope = await user();
    const group = await importGroup(scope, ["ready", "retry"]);
    const retryId = group.staged[1]!.operationId;
    await db.query("UPDATE memoia.memory_operations SET attempts=3 WHERE id=$1", [retryId]);
    const attempted: string[] = [];
    let rejected = true;
    globalThis.fetch = async (_url, init) => {
      const id = String(init?.body).includes("tea (retry)") ? "retry" : "ready";
      attempted.push(id);
      if (id === "retry" && rejected)
        return Response.json({ error: { message: "overloaded" } }, { status: 503 });
      return toolResponse("finish_facts", { candidate: factCandidate(id) });
    };
    await consume(runtime, group.message);
    const failed = await getOperation(runtime, scope, { operationId: group.id });
    assert.equal(failed.status, "failed");
    assert.equal(failed.error?.retryable, true);
    assert.equal((await operationState(retryId)).request.messages[0].message_id, "retry");
    assert.ok((await operationState(group.staged[0]!.operationId)).request.fact_prepared);
    const resumed = await retryOperation(runtime, scope, group.id);
    assert.equal(resumed.operation_id, group.id);
    assert.equal(resumed.status, "processing");
    rejected = false;
    await consume(runtime, group.message);
    assert.equal((await operationState(group.id)).result.fact_ids.length, 2);
    assert.equal(attempted.filter((id) => id === "ready").length, 1);
  });

  await test("Fact flush preserves a permanent model rejection after clearing the input", async () => {
    const scope = await user();
    const group = await importGroup(scope, ["rejected-by-model"]);
    let modelCalls = 0;
    globalThis.fetch = async () => {
      modelCalls++;
      return Response.json(
        { error: { code: "context_length_exceeded", message: "Input exceeds the model window" } },
        { status: 413 },
      );
    };
    await consume(runtime, group.message);
    const append = await operationState(group.staged[0]!.operationId);
    assert.equal(append.input_expires_at, null);
    assert.equal(append.request.messages, undefined);
    assert.deepEqual(append.error, { code: "fact_model_input_rejected", retryable: false });
    const receipt = await getOperation(runtime, scope, { operationId: group.id });
    assert.equal(receipt.status, "failed");
    assert.deepEqual(receipt.error, append.error);
    const retry = await retryOperation(runtime, scope, group.id);
    assert.equal(retry.operation_id, group.id);
    assert.deepEqual(retry.error, append.error);
    assert.equal(modelCalls, 1);
  });

  await test("an expired failed range keeps input_required on its original receipt", async () => {
    const scope = await user();
    const group = await importGroup(scope, ["expired-retry"]);
    await db.query("UPDATE memoia.memory_operations SET attempts=3 WHERE id=$1", [
      group.staged[0]!.operationId,
    ]);
    globalThis.fetch = async () => Response.json({ error: { message: "overloaded" } }, { status: 503 });
    await consume(runtime, group.message);
    assert.equal((await getOperation(runtime, scope, { operationId: group.id })).error?.retryable, true);
    await db.query(
      "UPDATE memoia.memory_operations SET input_expires_at=clock_timestamp()-interval '1 second' WHERE fact_flush_id=$1",
      [group.id],
    );
    await purgeExpiredInputs(runtime);
    assert.deepEqual((await retryOperation(runtime, scope, group.id)).error, {
      code: "input_required", retryable: false,
    });
    const receipt = await getOperation(runtime, scope, { operationId: group.id });
    assert.equal(receipt.operation_id, group.id);
    assert.deepEqual(receipt.error, { code: "input_required", retryable: false });
  });

  await test("expiry can win before restart locks the original scope without resurrecting its payload", async (t) => {
    const scope = await user();
    const group = await importGroup(scope, ["race"]);
    const append = group.staged[0]!.operationId;
    await db.query("UPDATE memoia.memory_operations SET attempts=3 WHERE id=$1", [append]);
    globalThis.fetch = async () => Response.json({ error: { message: "overloaded" } }, { status: 503 });
    await consume(runtime, group.message);
    assert.equal((await operationState(group.id)).error.retryable, true);
    const transaction = db.transaction.bind(db);
    let cleared = false;
    t.mock.method(db, "transaction", ((run, options) => transaction((tx) => run({
      query: async <T extends import("pg").QueryResultRow>(sql: string, values?: unknown[]) => {
        const expire = async () => {
          cleared = true;
          await db.query(
            "UPDATE memoia.memory_operations SET input_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [append],
          );
          await purgeExpiredInputs(runtime);
        };
        if (!cleared && sql.includes("fact_flush_id=$1 ORDER BY id FOR UPDATE")) await expire();
        const result = await tx.query<T>(sql, values);
        // Before the fix, cleanup could win immediately after the unlocked deadline check.
        if (!cleared && sql.includes("AS expired") && sql.includes("AS rejected")) await expire();
        return result;
      },
    }), options)) as typeof db.transaction);
    const result = await retryOperation(runtime, scope, group.id);
    assert.equal(cleared, true);
    assert.deepEqual(result.error, { code: "input_required", retryable: false });
    assert.equal((await operationState(append)).status, "failed");
    assert.equal((await operationState(append)).input_expires_at, null);
  });

  await test("expired unsealed append is named without taking ownership of its healthy sibling", async () => {
    const scope = await user();
    const append = (id: string) => stageImport(runtime, scope, {
      source_id: "s", idempotency_key: id, messages: [sourceMessage(id)],
    });
    const old = await append("old");
    const current = await append("current");
    await db.query(
      "UPDATE memoia.memory_operations SET input_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [old.operation_id],
    );
    await purgeExpiredInputs(runtime);
    await assert.rejects(flushBlob(runtime, scope, "s", {
      idempotency_key: "combined",
      append_operation_ids: [old.operation_id, current.operation_id],
    }), { code: "expired_append_inputs", appendOperationIds: [old.operation_id] });
    assert.equal((await operationState(current.operation_id)).fact_flush_id, null);
    const valid = await flushBlob(runtime, scope, "s", {
      idempotency_key: "current-only",
      append_operation_ids: [current.operation_id],
    });
    globalThis.fetch = async () => toolResponse("finish_facts", { candidate: factCandidate("current") });
    await consume(runtime, { ...wake(scope, valid.operation_id), kind: "fact_flush" });
    assert.equal((await operationState(valid.operation_id)).result.fact_ids.length, 1);
  });

  await test("a full 32-append range publishes with one bulk Fact write", async (t) => {
    const scope = await user();
    const ids = Array.from({ length: 32 }, (_, index) => `long-${index.toString().padStart(2, "0")}`);
    const group = await importGroup(scope, ids);
    // A previous slice already prepared every append. Exercise only the PostgreSQL
    // settlement boundary and the batch budget in this regression.
    for (const [index, append] of group.staged.entries()) {
      await db.query(
        "UPDATE memoia.memory_operations SET request=jsonb_set(request,'{fact_prepared}',$2::jsonb) WHERE id=$1",
        [append.operationId, JSON.stringify({
          input_revision: "0",
          facts: [{
            id: crypto.randomUUID(), content: "The user drinks tea.", subject: "the user",
            reporter: "the user", certainty: "asserted", support_groups: [[ids[index]]],
            occurred_at: sourceMessage(ids[index]!).occurred_at, fact_time: null,
          }],
          vectors: [Array(1536).fill(0.01)],
        })],
      );
    }
    let writes = 0;
    const transaction = db.transaction.bind(db);
    t.mock.method(db, "transaction", ((run, options) =>
      transaction((tx) => run({ query: (sql, values) => {
        if (sql.trimStart().startsWith("INSERT INTO memoia.memory_facts")) writes++;
        return tx.query(sql, values);
      } }), options)) as typeof db.transaction);
    globalThis.fetch = async () => { throw Error("prepared range must not call the model"); };
    await consume(runtime, group.message);
    assert.equal(writes, 1);
    const receipt = await getOperation(runtime, scope, { operationId: group.id });
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.result.fact_ids.length, 32);
    await assert.rejects(flushBlob(runtime, scope, "s", {
      idempotency_key: "too-large",
      append_operation_ids: [...group.staged.map((r) => r.operationId), crypto.randomUUID()],
    }), { code: "invalid_input" });
  });

  await test("a repeated message is owned by the flush that actually includes an available copy", async () => {
    const scope = await user();
    const first = await stageImport(runtime, scope, {
      source_id: "s",
      idempotency_key: "first-copy",
      messages: [sourceMessage("one")],
    });
    const second = await stageImport(runtime, scope, {
      source_id: "s",
      idempotency_key: "second-copy",
      messages: [sourceMessage("one")],
    });
    const op = await flushBlob(runtime, scope, "s", {
      idempotency_key: "second-copy-flush",
      append_operation_ids: [second.operation_id],
    });
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return toolResponse("finish_facts", { candidate: factCandidate("one") });
    };
    await consume(runtime, {
      ...wake(scope, op.operation_id),
      kind: "fact_flush",
    });
    assert.equal(
      (await operationState(op.operation_id)).result.fact_ids.length,
      1,
    );
    const replay = await flushBlob(runtime, scope, "s", {
      idempotency_key: "first-copy-flush",
      append_operation_ids: [first.operation_id],
    });
    await consume(runtime, {
      ...wake(scope, replay.operation_id),
      kind: "fact_flush",
    });
    assert.deepEqual(
      (await operationState(replay.operation_id)).result.fact_ids,
      [],
    );
    assert.equal(calls, 1);
  });
  await test("cross-append evidence is scoped to one fixed flush and identical Facts publish once", async () => {
    const scope = await user();
    const group = await importGroup(scope, ["first", "second"]);
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      const index = calls++;
      const ownId = index < 2 ? "first" : "second";
      const other = ownId === "first" ? "second" : "first";
      if (index % 2 === 0)
        return toolResponse("read_messages", {
          ids: index === 0 ? [other] : null,
          query: index === 0 ? null : `I drink tea (${other}).`,
          offset: 0,
        });
      assert.ok(String(init?.body).includes(`I drink tea (${other}).`));
      const candidate = factCandidate(ownId);
      candidate.messages[0]!.facts[0]!.any_of[0]!.all_of = [ownId, other];
      return toolResponse("finish_facts", { candidate });
    };
    await consume(runtime, group.message);
    const outcome = await operationState(group.id);
    const checkpoints = await db.query(
      "SELECT status,error,request ? 'fact_prepared' AS prepared FROM memoia.memory_operations WHERE fact_flush_id=$1",
      [group.id],
    );
    assert.equal(
      outcome.status,
      "completed",
      JSON.stringify({ error: outcome.error, checkpoints: checkpoints.rows }),
    );
    assert.equal(outcome.result.fact_ids.length, 1);
    assert.equal(calls, 4);
    const {
      rows: [fact],
    } = await db.query(
      "SELECT support_groups FROM memoia.memory_facts WHERE id=$1",
      [outcome.result.fact_ids[0]],
    );
    assert.deepEqual([...fact.support_groups[0]].sort(), ["first", "second"]);
  });
  for (const invalidation of ["lease expiration", "input withdrawal"] as const) {
    await test(`Fact evidence read yields after ${invalidation}`, async (t) => {
      const scope = await user();
      const group = await importGroup(scope, ["first", "second"]);
      let modelCalls = 0;
      const evidenceRows: number[] = [];
      const statement = db.query.bind(db);
      t.mock.method(db, "query", (async (sql, values, operation) => {
        const result = await statement(sql, values, operation);
        if (sql.includes("LIMIT 11 OFFSET")) evidenceRows.push(result.rows.length);
        return result;
      }) as typeof db.query);
      globalThis.fetch = async () => {
        assert.equal(++modelCalls, 1);
        if (invalidation === "lease expiration") {
          await db.query(
            "UPDATE memoia.queue_tasks SET lease_expires_at=clock_timestamp() WHERE id=$1",
            [group.id],
          );
        } else {
          await deleteMessages(runtime, scope, "s", {
            idempotency_key: "withdraw-evidence",
            message_ids: ["second"],
          });
        }
        return toolResponse("read_messages", { ids: ["second"], query: null, offset: 0 });
      };
      try {
        await consume(runtime, group.message);
      } finally {
        globalThis.fetch = originalFetch;
      }
      assert.deepEqual(evidenceRows, [0]);
      assert.equal(modelCalls, 1);
      for (const append of group.staged) {
        const op = await operationState(append.operationId);
        assert.equal(op.status, "processing");
        assert.equal(op.request.fact_draft, undefined);
        assert.equal(op.request.fact_review_candidate, undefined);
      }
    });
  }
  await test("a single large session Blob has bounded derived flushes and keeps each fixed snapshot", async () => {
    const scope = await user();
    const staged = await stageImport(runtime, scope, {
      source_id: "s",
      idempotency_key: "large",
      messages: [sourceMessage("scale")],
    });
    const {
      rows: [receipt],
    } = await db.query(
      "SELECT blob_id FROM memoia.memory_operations WHERE id=$1",
      [staged.operation_id],
    );
    const { rows: facts } = await db.query(
      `INSERT INTO memoia.memory_facts (id,user_id,project_id,blob_id,content,support_groups,occurred_at)
       SELECT gen_random_uuid(),$1,$2,$3,repeat('x',4000),'[["scale"]]'::jsonb,clock_timestamp()
       FROM generate_series(1,90) RETURNING id`,
      [scope.userId, scope.projectId, receipt.blob_id],
    );
    const changes = facts.map((f) => ({
      fact_id: f.id,
      kind: "added",
      version: 1,
    }));
    await db.query(
      "UPDATE memoia.memory_blobs SET fact_changes=$2::jsonb,fact_completed_at=clock_timestamp() WHERE id=$1",
      [receipt.blob_id, JSON.stringify(changes.map((change, index) => ({
        ...change,
        maintenance_reasoning_effort: index === 0 ? "medium" : index === changes.length - 1 ? "high" : undefined,
      })))],
    );
    const first = await flush(runtime, scope, "derived-first");
    const second = await flush(runtime, scope, "derived-second");
    assert.equal(first.status, "processing");
    assert.equal(second.status, "processing");
    assert.deepEqual(first.flush.blob_ids, ["s"]);
    assert.deepEqual(second.flush.blob_ids, ["s"]);
    const before = (await operationState(first.operation_id)).request
      .legacy_changes;
    const after = (await operationState(second.operation_id)).request
      .legacy_changes;
    assert.ok(before.length > 0 && after.length > 0);
    assert.deepEqual([...before, ...after], changes);
    const { rows: efforts } = await db.query(
      "SELECT biz_params->>'reasoning_effort' AS effort FROM memoia.queue_tasks WHERE id=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],id)",
      [[first.operation_id, second.operation_id]],
    );
    assert.deepEqual(efforts.map((row) => row.effort), ["medium", "high"]);
  });
  await test("qualified deferred checks still reject wrong Blob ownership and Fact evidence", async () => {
    const scope = await user();
    const blob = await batch(scope, "added");
    const operation = crypto.randomUUID();
    await db.query(
      `INSERT INTO memoia.memory_operations(id,user_id,project_id,idempotency_key,kind,request_hash,request,source_id,blob_id,status)
       VALUES($1,$2,$3,'not-a-flush','correct',repeat('c',64),'{}','s',$4,'processing')`,
      [operation, scope.userId, projectId, blob],
    );
    await assert.rejects(db.query(
      "UPDATE memoia.memory_blobs SET flush_operation_id=$1 WHERE id=$2",
      [operation, blob],
    ), { code: "23514", message: "invalid flush batch owner or lifecycle" });
    await assert.rejects(db.query(
      `UPDATE memoia.memory_facts SET support_groups='[["unknown-message"]]' WHERE blob_id=$1`,
      [blob],
    ), { code: "23514", message: "support outside active source messages" });
    const valid = await flush(runtime, scope, "qualified-trigger-flush");
    assert.deepEqual(valid.flush.blob_ids, [blob]);
  });

  async function seedRetraction(
    scope: { userId: string; projectId: string },
    rows: { content: string; dated: boolean }[],
  ) {
    const blob = await batch(scope, "noop");
    const vector = JSON.stringify(Array(1536).fill(0.01));
    const time = {
      start: "2025-01-01", end: "2025-01-01", precision: "day",
      evidence: [{ message_id: "withdrawn", expression: "January 1, 2025" }],
    };
    await db.query(
      `INSERT INTO memoia.memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at)
       VALUES($1,$2,'s','survivor',repeat('a',64),'user',now()),($1,$2,'s','withdrawn',repeat('b',64),'user',now())`,
      [scope.userId, projectId],
    );
    await db.query(`UPDATE memoia.memory_blobs SET message_ids=message_ids || '["survivor","withdrawn"]'::jsonb WHERE id=$1`, [blob]);
    const ids: string[] = [];
    for (const { content, dated } of rows) {
      const id = crypto.randomUUID();
      await db.query(
        `INSERT INTO memoia.memory_facts(id,user_id,project_id,blob_id,content,support_groups,occurred_at,fact_time,search_text,embedding)
         VALUES($1,$2,$3,$4,$5,'[["survivor"],["withdrawn"]]',now(),$6,$7,$8)`,
        [id, scope.userId, projectId, blob, content, dated ? JSON.stringify(time) : null,
          dated ? content + " with date" : content, vector],
      );
      ids.push(id);
    }
    return ids;
  }
  const indexedRuntime = () => ({
    ...runtime,
    deadline: Date.now() + 60_000,
    env: {
      ...runtime.env,
      EMBEDDING_API_KEY: "local-only",
      EMBEDDING_BASE_URL: "https://embed.invalid/v1",
      MEMOIA_CONFIG: JSON.stringify({ embedding_provider: "jina" }),
    },
  });

  const fixtureVectors = (count = 1) => Response.json({
    data: Array.from({ length: count }, (_, index) => ({ index, embedding: Array(1536).fill(0.02) })),
  });

  await test("withdrawal commits new evidence and vectors together and replays the original receipt", async (t) => {
    const scope = await user();
    const [dated, undated] = await seedRetraction(scope, [
      { content: "Dated memory", dated: true }, { content: "Undated memory", dated: false },
    ]);
    const configured = indexedRuntime();
    const input = { idempotency_key: "sync-withdraw", message_ids: ["withdrawn"] };
    const facts = async () => (await db.query(
      "SELECT id,revision,support_groups,embedding::text,search_text FROM memoia.memory_facts WHERE id=ANY($1::uuid[]) ORDER BY id",
      [[dated, undated]],
    )).rows;
    const before = await facts();
    let calls = 0;
    const provider = t.mock.method(globalThis, "fetch", async () => {
      calls++;
      return new Response(null, { status: 503 });
    });
    await assert.rejects(deleteMessages(configured, scope, "s", input), { code: "embedding_unavailable" });
    assert.deepEqual(await facts(), before);
    await assert.rejects(getOperation(configured, scope, { key: input.idempotency_key }), { code: "operation_not_found" });
    assert.equal((await db.query(
      "SELECT count(*)::int AS n FROM memoia.memory_messages WHERE user_id=$1 AND project_id=$2 AND message_id='withdrawn'",
      [scope.userId, projectId],
    )).rows[0].n, 1);
    provider.mock.mockImplementation(async () => { calls++; return fixtureVectors(); });
    const receipt = await deleteMessages(configured, scope, "s", input);
    assert.equal(receipt.status, "completed");
    assert.deepEqual(await deleteMessages(configured, scope, "s", input), receipt);
    assert.equal(calls, 2);
    const after = await facts();
    assert.equal(after.find((fact) => fact.id === dated)!.embedding, JSON.stringify(Array(1536).fill(0.02)));
    assert.equal(after.find((fact) => fact.id === dated)!.search_text, "Dated memory");
    assert.equal(after.find((fact) => fact.id === undated)!.embedding, before.find((fact) => fact.id === undated)!.embedding);
    assert.ok(after.every((fact) => fact.support_groups[0][0] === "survivor"));
    await deleteMessages(configured, scope, "s", { idempotency_key: "delete-last-support", message_ids: ["survivor"] });
    assert.deepEqual(await facts(), []);
    assert.equal(calls, 2);
  });

  await test("a withdrawal committed after an Event statement began prevents stale publication", async (t) => {
    const scope = await user();
    const [factId] = await seedRetraction(scope, [{ content: "Went to a library", dated: true }]);
    await db.query(
      "UPDATE memoia.memory_blobs b SET fact_changes=$2 FROM memoia.memory_facts f WHERE f.id=$1 AND b.id=f.blob_id",
      [factId, JSON.stringify([{ kind: "added", fact_id: factId, version: 1 }])],
    );
    const configured = indexedRuntime();
    const op = await flush(configured, scope, "derive-event");
    let modelCalls = 0;
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
      if (String(input instanceof Request ? input.url : input).endsWith("/embeddings")) return fixtureVectors();
      return ++modelCalls === 1 ? toolResponse("stage_event", {
        changes: [{ action: "upsert", content: "Went to the library on 2025-01-01", fact_ids: ["f1"] }],
      }) : response();
    });
    const withdrawDb = new Database(process.env.MEMOIA_TEST_DATABASE_URL!);
    const transaction = withdrawDb.transaction.bind(withdrawDb);
    let held!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    t.mock.method(withdrawDb, "transaction", (async (fn, options) =>
      transaction(async (tx) => {
        const result = await fn(tx);
        held();
        await released;
        return result;
      }, options)) as typeof withdrawDb.transaction);
    const query = db.query.bind(db);
    let withdrawing: ReturnType<typeof deleteMessages> | undefined;
    t.mock.method(db, "query", (async (sql, values, operation) => {
      if (sql.includes("INSERT INTO memoia.user_events") && !withdrawing) {
        withdrawing = deleteMessages({ ...configured, db: withdrawDb }, scope, "s", {
          idempotency_key: "withdraw-date", message_ids: ["withdrawn"],
        });
        await Promise.race([holding, withdrawing]);
        const writing = query(sql, values, operation);
        // Confirm the Event statement is waiting on the same version row.
        try {
          for (let i = 0; i < 50; i++) {
            const waiting = (await query(
              "SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%current_facts AS%'",
            )).rowCount;
            if (waiting) break;
            if (i === 49) assert.fail("Event did not wait for the in-flight withdrawal");
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        } finally {
          release();
          await writing.catch(() => undefined);
        }
        return writing;
      }
      return query(sql, values, operation);
    }) as typeof db.query);
    try {
      await consume(configured, wake(scope, op.operation_id));
      assert.equal((await withdrawing)?.status, "completed");
      assert.equal((await maintenanceTasks.readInTx(db, op.operation_id))?.status, "retry_wait");
      assert.equal((await db.query(
        "SELECT id FROM memoia.user_events WHERE user_id=$1 AND project_id=$2", [scope.userId, projectId],
      )).rowCount, 0);
    } finally {
      release();
      await withdrawing?.catch(() => undefined);
      await withdrawDb.close();
    }
  });

  await test("Event vector failure leaves the Event unwritten and retries the saved Agent result", async (t) => {
    const scope = await user();
    await batch(scope, "added");
    const configured = indexedRuntime();
    const op = await flush(configured, scope, "derive-event");
    let modelCalls = 0, queryCalls = 0, documentCalls = 0;
    t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.endsWith("/embeddings")) {
        const { task } = await request.json() as { task: string };
        if (task === "retrieval.query") {
          queryCalls++;
          return new Response(null, { status: 401 });
        }
        return ++documentCalls === 1 ? new Response(null, { status: 503 }) : fixtureVectors();
      }
      switch (++modelCalls) {
        case 1: return toolResponse("search_memory", { query: "fact", limit: 3 });
        case 2: return toolResponse("stage_event", {
          changes: [{ action: "upsert", content: "A library visit", fact_ids: ["f1"] }],
        });
        default: return response();
      }
    });
    const message = wake(scope, op.operation_id);
    const read = async () => (await db.query(
      "SELECT version,embedding::text FROM memoia.user_events WHERE user_id=$1 AND project_id=$2", [scope.userId, projectId],
    )).rows;
    await consume(configured, message);
    const waiting = await maintenanceTasks.readInTx(db, op.operation_id);
    assert.equal(waiting?.status, "retry_wait");
    assert.equal(waiting?.lastFailure?.resultCode, "embedding_unavailable");
    assert.deepEqual(await read(), []);
    await db.query("UPDATE memoia.queue_tasks SET next_run_at=clock_timestamp() WHERE id=$1", [op.operation_id]);
    await consume(configured, message);
    assert.equal((await maintenanceTasks.readInTx(db, op.operation_id))?.status, "succeeded");
    assert.deepEqual(await read(), [{ version: "1", embedding: JSON.stringify(Array(1536).fill(0.02)) }]);
    assert.deepEqual({ modelCalls, queryCalls, documentCalls }, { modelCalls: 3, queryCalls: 1, documentCalls: 2 });
  });

  await test("manual Event edits never embed stale derived text after withdrawal", async (t) => {
    const scope = await user();
    const [factId] = await seedRetraction(scope, [{ content: "Old memory", dated: false }]);
    const eventId = crypto.randomUUID(), unknownEventId = crypto.randomUUID();
    const otherBlob = await batch(scope, "added");
    const directFact = (await db.query("SELECT id FROM memoia.memory_facts WHERE blob_id=$1", [otherBlob])).rows[0].id;
    await db.query("INSERT INTO memoia.user_events(id,user_id,project_id,event_data) VALUES($1,$2,$3,$4)",
      [eventId, scope.userId, scope.projectId, { content: "Old date", fact_ids: [factId], _impact_fact_ids: [factId] }]);
    await db.query("INSERT INTO memoia.user_events(id,user_id,project_id,event_data) VALUES($1,$2,$3,$4)",
      [unknownEventId, scope.userId, scope.projectId, { content: "Indirect old date", fact_ids: [directFact], _impact_fact_ids: null }]);
    const configured = indexedRuntime();
    const provider = t.mock.method(globalThis, "fetch", async () => fixtureVectors());
    await deleteMessages(configured, scope, "s", { idempotency_key: "withdraw", message_ids: ["withdrawn", "survivor"] });
    await updateEvent(configured, scope, eventId, { interpretation: "Edited interpretation" });
    await assert.rejects(updateEvent(configured, scope, eventId, { title: "New title" }), { code: "write_conflict" });
    await assert.rejects(updateEvent(configured, scope, unknownEventId, { title: "New title" }), { code: "write_conflict" });
    assert.equal(provider.mock.callCount(), 0);
  });

  await test("large support groups stay in PostgreSQL and do not exhaust the Agent input", async () => {
    const scope = await user();
    const [factId] = await seedRetraction(scope, [{ content: "A long-running activity", dated: true }]);
    const ids = Array.from({ length: 49 }, (_, i) => String(i).padStart(3, "0").padEnd(128, "m"));
    const groups = Array.from({ length: 19 }, (_, i) =>
      Array.from({ length: 35 }, (_, j) => ids[(i + j) % ids.length]));
    const { rows: [fact] } = await db.query("SELECT blob_id FROM memoia.memory_facts WHERE id=$1", [factId]);
    await db.query(
      `INSERT INTO memoia.memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at)
       SELECT $1,$2,'s',id,repeat('a',64),'user',now() FROM unnest($3::text[]) AS ids(id)`,
      [scope.userId, projectId, ids],
    );
    await db.query("UPDATE memoia.memory_blobs SET message_ids=message_ids || $2::jsonb WHERE id=$1", [fact.blob_id, JSON.stringify(ids)]);
    await db.query("UPDATE memoia.memory_facts SET support_groups=$2::jsonb WHERE id=$1", [factId, JSON.stringify([["withdrawn"], ...groups])]);
    const configured = runtime;
    await deleteMessages(configured, scope, "s", { idempotency_key: "withdraw-wide", message_ids: ["withdrawn"] });
    const op = await flush(configured, scope, "derive");
    const claim = {
      ...scope, id: op.operation_id, owner: crypto.randomUUID(), blobIds: [fact.blob_id],
      changes: [{ kind: "evidence", fact_id: factId }],
    };
    const context = new MaintenanceContext(configured, claim, () => {});
    await context.prepare();
    const changes = await context.readChanges();
    const read = await context.read("facts", [factId], null, null);
    assert.equal((changes.items[0] as any).current_fact.content, "A long-running activity");
    assert.equal(read.items[0].content, "A long-running activity");
    assert.equal("support_groups" in read.items[0], false);
    const persisted = await db.query("SELECT support_groups FROM memoia.memory_facts WHERE id=$1", [factId]);
    assert.deepEqual(persisted.rows[0].support_groups, groups);
  });

  await test("a large retraction keeps bounded maintenance ranges", async () => {
    const scope = await user();
    const ids = await seedRetraction(scope, Array.from({ length: 101 }, (_, i) => ({
      content: `Memory ${i} ${"detail ".repeat(400)}`, dated: true,
    })));
    const configured = runtime;
    const receipt = await deleteMessages(configured, scope, "s", { idempotency_key: "large-withdraw", message_ids: ["withdrawn"] });
    assert.equal(receipt.status, "completed");
    const assigned: string[] = [];
    while (assigned.length < ids.length) {
      const op = await flush(configured, scope, `bounded-${assigned.length}`);
      assert.equal(op.status, "processing");
      const persisted = await operationState(op.operation_id);
      const changes = persisted.request.legacy_changes.filter((change: any) => change.kind === "evidence");
      assert.ok(changes.length > 0 && changes.length <= 100);
      assigned.push(...changes.map((change: any) => change.fact_id));
    }
    assert.deepEqual(assigned.sort(), [...ids].sort());
    assert.equal((await flush(configured, scope, "finished")).status, "completed");
  });

  await test("completed Agent checkpoint resumes commit without replaying the model", async () => {
    const scope = await user();
    const blob = await batch(scope, "added");
    const op = await flush(runtime, scope, "agent-completed-resume");
    const complete = maintenanceTasks.completeInTx.bind(maintenanceTasks);
    maintenanceTasks.completeInTx = async () => { throw new DatabaseUnavailableError(); };
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
      maintenanceTasks.completeInTx = complete;
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
    const complete = maintenanceTasks.completeInTx.bind(maintenanceTasks);
    maintenanceTasks.completeInTx = async () => { throw new DatabaseUnavailableError(); };
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
      maintenanceTasks.completeInTx = complete;
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
          "UPDATE memoia.queue_tasks SET started_at=clock_timestamp()-interval '12 minutes' WHERE id=$1 RETURNING started_at",
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
  await test("a failed fixed-batch read retries the claimed maintenance task", async () => {
    const scope = await user();
    const blob = await batch(scope, "added");
    const op = await flush(runtime, scope, "batch-read-failure");
    const message = wake(scope, op.operation_id);
    const originalQuery = db.query.bind(db);
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return response();
    };
    db.query = async (sql, values, operation) => {
      if (sql.startsWith("SELECT fact_changes FROM memoia.memory_blobs")) {
        const task = await maintenanceTasks.readInTx({ query: originalQuery }, op.operation_id);
        assert.equal(task?.status, "running");
        throw new DatabaseUnavailableError();
      }
      return originalQuery(sql, values, operation);
    };
    try {
      await consume(runtime, message);
    } finally {
      db.query = originalQuery;
    }
    assert.equal(calls, 0);
    const waiting = await maintenanceTasks.readInTx(db, op.operation_id);
    assert.equal(waiting?.status, "retry_wait");
    await db.query(
      "UPDATE memoia.queue_tasks SET next_run_at=clock_timestamp() WHERE id=$1",
      [op.operation_id],
    );
    await consume(runtime, message);
    const completed = await getOperation(runtime, scope, { operationId: op.operation_id });
    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.result.blob_ids, [blob]);
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
        if (sql.includes("FROM memoia.memory_facts WHERE") && sql.includes("ILIKE")) {
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
  await test("publication resumes after lost Event and Profile responses without repeating writes or model calls", async (t) => {
    const scope = await user();
    const blob = await batch(scope, "added");
    const op = await flush(runtime, scope, "partial-publication");
    const factId = (
      await db.query("SELECT id FROM memoia.memory_facts WHERE blob_id=$1", [
        blob,
      ])
    ).rows[0].id;
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1)
        return toolResponse("stage_event", {
          changes: [
            {
              action: "upsert",
              content: "Visited the library",
              fact_ids: ["f1"],
            },
          ],
        });
      if (calls === 2)
        return toolResponse("stage_profile", {
          changes: [
            {
              action: "upsert",
              content: "Enjoys reading",
              topic: "interests_preferences",
              sub_topic: "reading",
              fact_ids: ["f1"],
            },
          ],
        });
      assert.equal(
        calls,
        3,
        "resume the completed checkpoint without another model call",
      );
      return response();
    };
    const query = db.query.bind(db);
    let eventWrites = 0,
      profileWrites = 0;
    t.mock.method(db, "query", async (statement: string, values?: unknown[]) => {
      const result = await query(statement, values);
      if (statement.includes("INSERT INTO memoia.user_events") && ++eventWrites === 1)
        throw new DatabaseUnavailableError();
      if (statement.includes("INSERT INTO memoia.user_profiles") && ++profileWrites === 1)
        throw new DatabaseUnavailableError();
      return result;
    });
    const readback = async () => {
      const events = (
        await db.query(
          "SELECT e.id,e.version,e.event_data,ef.fact_id FROM memoia.user_events e JOIN memoia.memory_event_facts ef ON ef.event_id=e.id AND ef.user_id=e.user_id AND ef.project_id=e.project_id WHERE e.user_id=$1 AND e.project_id=$2",
          [scope.userId, scope.projectId],
        )
      ).rows;
      const profiles = (
        await db.query(
          "SELECT id,version,content FROM memoia.user_profiles WHERE user_id=$1 AND project_id=$2",
          [scope.userId, scope.projectId],
        )
      ).rows;
      return { events, profiles };
    };
    const makeDue = () =>
      db.query(
        "UPDATE memoia.queue_tasks SET next_run_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [op.operation_id],
      );
    await consume(runtime, wake(scope, op.operation_id));
    const partial = await readback();
    assert.equal(partial.events.length, 1);
    assert.equal(partial.events[0].fact_id, factId);
    assert.deepEqual(partial.events[0].event_data.fact_ids, [factId]);
    assert.equal(partial.events[0].event_data.content, "Visited the library");
    assert.equal(partial.profiles.length, 0);
    assert.equal((await operationState(op.operation_id)).status, "processing");
    await makeDue();
    await consume(runtime, wake(scope, op.operation_id));
    const applied = await readback();
    assert.deepEqual(applied.events, partial.events);
    assert.equal(applied.profiles.length, 1);
    assert.equal(applied.profiles[0].content, "Enjoys reading");
    assert.equal((await operationState(op.operation_id)).status, "processing");
    await makeDue();
    await consume(runtime, wake(scope, op.operation_id));
    const done = await operationState(op.operation_id);
    assert.equal(done.status, "completed");
    assert.deepEqual(done.result.profile_ids, [applied.profiles[0].id]);
    assert.deepEqual(done.result.event_ids, [applied.events[0].id]);
    assert.deepEqual(await readback(), applied);
    assert.equal(calls, 3);
    assert.equal(eventWrites, 1);
    assert.equal(profileWrites, 1);
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS count FROM memoia.memory_profile_revisions WHERE operation_id=$1",
          [op.operation_id],
        )
      ).rows[0].count,
      1,
    );
  });

  await test("lost successful final CAS response keeps the original task succeeded", async () => {
    const scope = await user();
    const blob = await batch(scope, "added");
    const op = await flush(runtime, scope, "lost-commit-response");
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return response();
    };
    const originalComplete =
      maintenanceTasks.completeInTx.bind(maintenanceTasks);
    let lost = false;
    maintenanceTasks.completeInTx = async (...args) => {
      const result = await originalComplete(...args);
      if (result && !lost) {
        lost = true;
        throw new DatabaseUnavailableError();
      }
      return result;
    };
    try {
      await consume(runtime, wake(scope, op.operation_id));
    } finally {
      maintenanceTasks.completeInTx = originalComplete;
    }
    assert.ok(lost);
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
    assert.equal(state.rowCount, 0);
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
  await test("Legato CAS allows one running task per user even with different operation IDs", async () => {
    const scope = await user();
    await batch(scope, "added");
    const first = await flush(runtime, scope, "claim-a");
    await batch(scope, "added");
    const second = await flush(runtime, scope, "claim-b");
    const ids = [first.operation_id, second.operation_id];
    const claims = await Promise.all(ids.map((id) => claimTask(db, id, "maintenance_flush")));
    const winner = claims.find((claimed) => claimed !== null);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.ok(winner?.leaseId);
    assert.ok(await maintenanceTasks.completeInTx(db, winner.id, winner.leaseId, { resultCode: "COMPLETED" }));
    const next = await claimTask(db, ids.find((id) => id !== winner.id)!, "maintenance_flush");
    assert.ok(next?.leaseId);
    assert.ok(await maintenanceTasks.completeInTx(db, next.id, next.leaseId, { resultCode: "COMPLETED" }));
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
      const openTransactions = await db.query(
        `SELECT pid FROM pg_stat_activity
         WHERE datname=current_database() AND pid<>pg_backend_pid()
           AND backend_type='client backend' AND xact_start IS NOT NULL`,
      );
      assert.equal(
        openTransactions.rowCount,
        0,
        "provider waits release every transaction",
      );
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
    const blob = await batch(scope, "added");
    const factId = (
      await db.query("SELECT id FROM memoia.memory_facts WHERE blob_id=$1", [
        blob,
      ])
    ).rows[0].id;
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
      changes: [{ kind: "added", fact_id: factId, version: 1 }],
    };
    const ctx = new MaintenanceContext(runtime, claim, async () => {});
    await ctx.prepare();
    await ctx.readChanges();
    const staged = await ctx.stage("events", [
      { action: "upsert", content: "A new story", fact_ids: [factId] },
    ]);
    assert.equal(staged.staged, true);
    const successor = crypto.randomUUID();
    await db.query(
      "UPDATE memoia.queue_tasks SET lease_id=$2,run_attempts=run_attempts+1 WHERE id=$1",
      [op.operation_id, successor],
    );
    await assert.rejects(
      ctx.commit(),
      (error: unknown) =>
        error instanceof SourceError &&
        error.code === "maintenance_read_conflict",
    );
    assert.equal(
      (
        await db.query(
          "SELECT 1 FROM memoia.user_events WHERE user_id=$1 AND project_id=$2 AND id=$3",
          [scope.userId, scope.projectId, staged.ids[0]],
        )
      ).rowCount,
      0,
    );
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
