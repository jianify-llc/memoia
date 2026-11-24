import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Database, DatabaseUnavailableError } from "../src/db";
import { parseImportMetadata } from "../src/canonical";
import {
  deleteMessages,
  updateFact,
  deleteFact,
  stageImport,
  getOperation,
  getSource,
  getHistory,
  forgetUser,
  purgeExpiredInputs,
  retryOperation,
} from "../src/facts";

test("large processed imports batch identity checks and record deletion in the receipt", async () => {
  const db = new Database(process.env.MEMOIA_TEST_DATABASE_URL!);
  const projectId = `batch_${randomUUID()}`;
  const scope = { userId: randomUUID(), projectId };
  const sourceId = "source";
  const occurred = "2024-05-01T12:00:00Z";
  const digest = createHash("sha256")
    .update(
      '{"content":"hello","occurred_at":"2024-05-01T12:00:00+00:00","role":"user"}',
    )
    .digest("hex");
  const reads: string[] = [];
  const trackedDb = new Proxy(db, {
    get(target, property) {
      if (property === "query")
        return (sql: string, values: unknown[]) => {
          if (/^SELECT .* FROM memoia\.memory_messages WHERE/.test(sql)) reads.push(sql);
          return target.query(sql, values);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let maintenanceWakeups = 0;
  const runtime = {
    db: trackedDb,
    env: { OPENAI_API_KEY: "unused", MAINTENANCE_ENABLED: "true" },
    maintenanceWakeup: { send: async () => { maintenanceWakeups++; } },
    deadline: Date.now() + 60000,
  };
  const message = (id: string) => ({
    message_id: id,
    role: "user" as const,
    content: "hello",
    occurred_at: occurred,
  });
  try {
    await db.query(
      "INSERT INTO memoia.projects(id,project_id,project_secret,status) VALUES ($1,$2,'local','active')",
      [randomUUID(), projectId],
    );
    await db.query("INSERT INTO memoia.users(id,project_id) VALUES ($1,$2)", [
      scope.userId,
      projectId,
    ]);
    await db.query(
      "INSERT INTO memoia.memory_sources(user_id,project_id,source_id) VALUES ($1,$2,$3)",
      [scope.userId, projectId, sourceId],
    );
    await db.query(
      "INSERT INTO memoia.memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at,processed) SELECT $1,$2,$3,'m'||n,$4,'user',$5,true FROM generate_series(1,1000) n",
      [scope.userId, projectId, sourceId, digest, occurred],
    );
    const request = {
      idempotency_key: "batch",
      source_id: sourceId,
      messages: Array.from({ length: 1000 }, (_, i) => message(`m${i + 1}`)),
    };
    const result = await stageImport(runtime, scope, request);
    assert.equal(result.status, "staged");
    assert.equal(reads.length, 1);
    assert.ok(reads.every((sql) => sql.includes("message_id=ANY(")));
    assert.equal(
      (await stageImport(runtime, scope, request)).operation_id,
      result.operation_id,
    );
    await assert.rejects(
      stageImport(runtime, scope, {
        ...request,
        idempotency_key: "changed",
        messages: [{ ...message("m1"), content: "different" }],
      }),
      (e: any) => e.code === "message_conflict",
    );
    await assert.rejects(
      stageImport(runtime, scope, {
        ...request,
        idempotency_key: "last-conflict",
        messages: [
          message("new-first"),
          { ...message("m1000"), content: "different" },
        ],
      }),
      (e: any) => e.code === "message_conflict",
    );
    assert.equal(
      (
        await db.query(
          "SELECT 1 FROM memoia.memory_messages WHERE user_id=$1 AND project_id=$2 AND source_id=$3 AND message_id='new-first'",
          [scope.userId, projectId, sourceId],
        )
      ).rowCount,
      0,
    );
    await stageImport(runtime, scope, {
      ...request,
      idempotency_key: "timezone",
      messages: [{ ...message("m1"), time_zone: "Asia/Shanghai" }],
    });
    assert.equal(
      (
        await db.query(
          "SELECT time_zone FROM memoia.memory_messages WHERE user_id=$1 AND project_id=$2 AND source_id=$3 AND message_id='m1'",
          [scope.userId, projectId, sourceId],
        )
      ).rows[0].time_zone,
      "Asia/Shanghai",
    );
    await assert.rejects(
      stageImport(runtime, scope, {
        ...request,
        idempotency_key: "other-timezone",
        messages: [{ ...message("m1"), time_zone: "Europe/London" }],
      }),
      (e: any) => e.code === "message_conflict",
    );
    const pending = await stageImport(runtime, scope, {
      ...request, idempotency_key: "stage-late", messages: [message("late")],
    });
    const deleted = await deleteMessages(runtime, scope, sourceId, {
      idempotency_key: "delete-late",
      message_ids: ["late"],
    });
    assert.equal(deleted.status, "completed");
    assert.equal(maintenanceWakeups, 0);
    const { rows: [state] } = await db.query(
      `SELECT o.request->'messages' AS messages, b.fact_completed_at
       FROM memoia.memory_operations o JOIN memoia.memory_operations d
         ON d.id=$2 AND d.user_id=o.user_id AND d.project_id=o.project_id
       JOIN memoia.memory_blobs b ON b.id=d.blob_id WHERE o.id=$1`,
      [pending.operation_id, deleted.operation_id],
    );
    assert.deepEqual(state.messages, []);
    assert.equal(state.fact_completed_at, null);
    const source = await getSource(runtime, scope, sourceId, {
      limit: 100, messageOffset: 0,
    });
    assert.deepEqual(source.deleted_message_ids, ["late"]);
    assert.equal((await db.query(
      "SELECT 1 FROM memoia.memory_messages WHERE user_id=$1 AND project_id=$2 AND source_id=$3 AND message_id='late'",
      [scope.userId, projectId, sourceId],
    )).rowCount, 0);
  } finally {
    await db.query("DELETE FROM memoia.projects WHERE project_id=$1", [
      projectId,
    ]);
    await db.close();
  }
});

test("configured input retention preserves live retries and purges expired input", async () => {
  const db = new Database(process.env.MEMOIA_TEST_DATABASE_URL!);
  const projectId = `retention_${randomUUID()}`;
  const scope = { userId: randomUUID(), projectId };
  const runtime = {
    db,
    env: {
      OPENAI_API_KEY: "local-test-only",
      MEMOIA_CONFIG: JSON.stringify({
        source_input_retention_seconds: 30,
        enable_event_embedding: false,
      }),
    },
    deadline: Date.now() + 60000,
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 503 });
  const request = {
    source_id: "source",
    idempotency_key: "retention",
    messages: [
      {
        message_id: "m",
        role: "user" as const,
        content: "hello",
        occurred_at: "2024-05-01T12:00:00Z",
      },
    ],
  };
  try {
    await db.query(
      "INSERT INTO memoia.projects(id,project_id,project_secret,status) VALUES ($1,$2,'local','active')",
      [randomUUID(), projectId],
    );
    await stageImport(runtime, scope, request);
    const read = async () =>
      (
        await db.query(
          "SELECT id,blob_id,input_expires_at,request,extract(epoch FROM (input_expires_at-clock_timestamp())) AS remaining FROM memoia.memory_operations WHERE user_id=$1 AND project_id=$2 AND idempotency_key=$3",
          [scope.userId, projectId, request.idempotency_key],
        )
      ).rows[0];
    const first = await read();
    assert.ok(Number(first.remaining) > 0 && Number(first.remaining) <= 30);
    await stageImport(runtime, scope, request);
    const retried = await read();
    assert.equal(retried.id, first.id);
    assert.equal(
      retried.input_expires_at.getTime(),
      first.input_expires_at.getTime(),
    );
    await db.query(
      "UPDATE memoia.memory_operations SET input_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [first.id],
    );
    await purgeExpiredInputs(runtime);
    const purged = await read();
    assert.equal(purged.input_expires_at, null);
    assert.deepEqual(purged.request, {
      source_id: request.source_id,
      idempotency_key: request.idempotency_key,
    });
    await stageImport(runtime, scope, request);
    const replayed = await read();
    assert.equal(replayed.id, first.id);
    assert.equal(replayed.input_expires_at, null);
    assert.deepEqual(replayed.request, purged.request);

    const factId = randomUUID();
    await db.query(
      "INSERT INTO memoia.memory_facts(id,user_id,project_id,blob_id,content,subject,reporter,certainty,support_groups,occurred_at) VALUES($1,$2,$3,$4,'before','user','user','asserted','[[\"m\"]]','2024-05-01T12:00:00Z')",
      [factId, scope.userId, projectId, first.blob_id],
    );
    const correctionRuntime = {
      ...runtime,
      env: {
        ...runtime.env,
        EMBEDDING_API_KEY: "local-only",
        EMBEDDING_BASE_URL: "https://embedding.invalid/v1",
        MEMOIA_CONFIG: JSON.stringify({
          source_input_retention_seconds: 30,
          embedding_provider: "jina",
          embedding_model: "jina-embeddings-v3",
        }),
      },
    };
    const proposal = {
      idempotency_key: "correction-retention",
      expected_revision: 1,
      reason: "fix",
      content: "after",
      subject: "user",
      reporter: "user",
      certainty: "asserted" as const,
      support_groups: [["m"]],
      fact_time: null,
    };
    await assert.rejects(
      updateFact(correctionRuntime, scope, factId, proposal),
      (e: any) => e.code === "embedding_unavailable",
    );
    const readCorrection = async () =>
      (
        await db.query(
          "SELECT id,status,request,input_expires_at,extract(epoch FROM(input_expires_at-clock_timestamp())) AS remaining FROM memoia.memory_operations WHERE user_id=$1 AND project_id=$2 AND idempotency_key=$3",
          [scope.userId, projectId, proposal.idempotency_key],
        )
      ).rows[0];
    assert.equal(await readCorrection(), undefined, "a failed edit must leave no receipt");
    assert.equal((await db.query(
      "SELECT count(*)::int AS n FROM memoia.memory_blobs WHERE user_id=$1 AND project_id=$2 AND kind='correct'",
      [scope.userId, projectId],
    )).rows[0].n, 0);
    globalThis.fetch = async () =>
      Response.json({
        data: [{ index: 0, embedding: Array(1536).fill(0.01) }],
      });
    const edited = await updateFact(correctionRuntime, scope, factId, proposal);
    assert.equal(edited.status, "completed");
    assert.deepEqual(await updateFact(correctionRuntime, scope, factId, proposal), edited);
    const confirmed = await readCorrection();
    assert.equal(confirmed.input_expires_at, null);
    assert.equal(confirmed.request.content, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    await db.query("DELETE FROM memoia.projects WHERE project_id=$1", [
      projectId,
    ]);
    await db.close();
  }
});

test("fixed imports, evidence retraction, corrections and forgetting commit atomically", async () => {
  const db = new Database(process.env.MEMOIA_TEST_DATABASE_URL!);
  const projectId = `facts_${randomUUID()}`,
    userId = randomUUID(),
    sourceId = "source",
    scope = { userId, projectId };
  const runtime = {
    db,
    env: {
      OPENAI_API_KEY: "unused",
      MEMOIA_CONFIG: JSON.stringify({ enable_event_embedding: false }),
    },
    deadline: Date.now() + 60000,
  };
  try {
    await db.query(
      "INSERT INTO memoia.projects(id,project_id,project_secret,status) VALUES ($1,$2,$3,$4)",
      [randomUUID(), projectId, "local", "active"],
    );
    await db.query("INSERT INTO memoia.users(id,project_id) VALUES ($1,$2)", [
      userId,
      projectId,
    ]);
    await db.query(
      "INSERT INTO memoia.memory_sources(user_id,project_id,source_id) VALUES ($1,$2,$3)",
      [userId, projectId, sourceId],
    );
    const occurred = "2024-05-01T12:00:00Z";
    const digest = createHash("sha256")
      .update(
        '{"content":"May 2024","occurred_at":"2024-05-01T12:00:00+00:00","role":"user"}',
      )
      .digest("hex");
    for (const id of ["a", "b"])
      await db.query(
        "INSERT INTO memoia.memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at,processed) VALUES ($1,$2,$3,$4,$5,$6,$7,true)",
        [userId, projectId, sourceId, id, digest, "user", occurred],
      );
    const blob = randomUUID(),
      fact = randomUUID();
    await db.query(
      "INSERT INTO memoia.memory_blobs(id,user_id,project_id,source_id,message_ids,status) VALUES ($1,$2,$3,$4,$5::jsonb,'active')",
      [blob, userId, projectId, sourceId, JSON.stringify(["a", "b"])],
    );
    const time = {
      start: "2024-05-01",
      end: "2024-05-31",
      precision: "month",
      evidence: [{ message_id: "a", expression: "May 2024" }],
    };
    await db.query(
      "INSERT INTO memoia.memory_facts(id,user_id,project_id,blob_id,content,subject,reporter,certainty,support_groups,occurred_at,fact_time,search_text) VALUES ($1,$2,$3,$4,'moved','user','user','asserted',$5::jsonb,$6,$7::jsonb,$8)",
      [
        fact,
        userId,
        projectId,
        blob,
        JSON.stringify([["a"], ["b"]]),
        occurred,
        JSON.stringify(time),
        "moved\n[Event time: 2024-05; precision: month]",
      ],
    );
    const historical = {
      id: randomUUID(),
      content: "sensitive",
      topic: "t",
      sub_topic: "s",
      fact_ids: [fact],
      source_ids: [sourceId],
      _impact_fact_ids: [fact],
    };
    await db.query(
      "INSERT INTO memoia.memory_profile_revisions(id,user_id,project_id,source_id,profiles,added,removed) VALUES ($1,$2,$3,$4,$5::jsonb,$5::jsonb,$6::jsonb)",
      [
        randomUUID(),
        userId,
        projectId,
        sourceId,
        JSON.stringify([historical]),
        JSON.stringify([]),
      ],
    );
    const request = {
      idempotency_key: "import-noop",
      source_id: sourceId,
      messages: [
        {
          message_id: "a",
          role: "user" as const,
          content: "May 2024",
          occurred_at: occurred,
        },
      ],
    };
    const imported = await stageImport(runtime, scope, request);
    assert.equal(imported.status, "staged");
    assert.equal(
      (await stageImport(runtime, scope, request)).operation_id,
      imported.operation_id,
    );
    await assert.rejects(
      stageImport(runtime, scope, {
        ...request,
        messages: [{ ...request.messages[0], content: "changed" }],
      }),
      (e: any) => e.code === "idempotency_conflict",
    );
    await assert.rejects(
      stageImport(runtime, scope, {
        ...request,
        idempotency_key: "another-key",
        messages: [{ ...request.messages[0], content: "changed" }],
      }),
      (e: any) => e.code === "message_conflict",
    );
    const deleteInput = { idempotency_key: "retract-a", message_ids: ["a"] };
    const lostResponseDb = new Proxy(db, {
      get(target, property) {
        if (property === "transaction") return (async (fn, options) => {
          await target.transaction(fn, options);
          throw new DatabaseUnavailableError();
        }) as Database["transaction"];
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await assert.rejects(
      deleteMessages({ ...runtime, db: lostResponseDb }, scope, sourceId, deleteInput),
      DatabaseUnavailableError,
    );
    const retract = await getOperation(runtime, scope, { key: deleteInput.idempotency_key });
    assert.equal(retract.status, "completed");
    await assert.rejects(retryOperation(runtime, scope, retract.operation_id), {
      code: "operation_kind_unsupported",
    });
    assert.deepEqual(await deleteMessages(runtime, scope, sourceId, deleteInput), retract);
    await assert.rejects(
      deleteMessages(runtime, scope, sourceId, { ...deleteInput, message_ids: ["b"] }),
      { code: "idempotency_conflict" },
    );
    const after = await getSource(runtime, scope, sourceId);
    assert.deepEqual(after.evidence[0].support_groups, [["b"]]);
    assert.equal(after.evidence[0].fact_time, null);
    assert.equal(after.evidence[0].revision, 2);
    assert.deepEqual((await getHistory(runtime, scope))[0].profiles, []);
    // Represents a profile history write that saw the Fact before withdrawal.
    const lateHistory = randomUUID();
    await db.query(
      "INSERT INTO memoia.memory_profile_revisions(id,user_id,project_id,source_id,profiles,added,removed) VALUES ($1,$2,$3,$4,$5::jsonb,'[]'::jsonb,'[]'::jsonb)",
      [lateHistory, userId, projectId, sourceId, JSON.stringify([
        { ...historical, _fact_revisions: { [fact]: 1 } },
        { ...historical, content: "current supported history", _fact_revisions: { [fact]: 2 } },
      ])],
    );
    const readable = (await getHistory(runtime, scope)).find((entry) => entry.revision_id === lateHistory);
    assert.deepEqual(readable?.profiles, [{
      id: historical.id, content: "current supported history", topic: historical.topic,
      sub_topic: historical.sub_topic, fact_ids: [fact], source_ids: [sourceId],
    }]);
    await assert.rejects(
      updateFact(runtime, scope, fact, {
        idempotency_key: "bad-evidence",
        expected_revision: 2,
        reason: "test",
        content: "wrong",
        subject: "user",
        reporter: "user",
        certainty: "asserted",
        support_groups: [["a"]],
        fact_time: null,
      }),
      (e: any) => e.code === "invalid_fact_evidence",
    );
    const unchanged = await updateFact(runtime, scope, fact, {
      idempotency_key: "unchanged",
      expected_revision: 2,
      reason: "check",
      content: "moved",
      subject: "user",
      reporter: "user",
      certainty: "asserted",
      support_groups: [["b"]],
      fact_time: null,
    });
    assert.equal(
      unchanged.result.memory_version,
      retract.result.memory_version,
    );
    const correction = await updateFact(runtime, scope, fact, {
      idempotency_key: "edit",
      expected_revision: 2,
      reason: "correct",
      content: "corrected",
      subject: "user",
      reporter: "user",
      certainty: "asserted",
      support_groups: [["b"]],
      fact_time: null,
    });
    assert.equal(correction.status, "completed");
    const audit = (
      await db.query(
        "SELECT request,input_expires_at FROM memoia.memory_operations WHERE id=$1",
        [correction.operation_id],
      )
    ).rows[0];
    assert.equal(audit.request.content, undefined);
    assert.equal(audit.request.reason, "correct");
    assert.equal(audit.input_expires_at, null);
    await assert.rejects(
      updateFact(runtime, scope, fact, {
        idempotency_key: "stale",
        expected_revision: 2,
        reason: "stale",
        content: "wrong",
        subject: "user",
        reporter: "user",
        certainty: "asserted",
        support_groups: [["b"]],
        fact_time: null,
      }),
      (e: any) => e.code === "fact_revision_conflict",
    );
    const messageReads: string[] = [];
    const trackedDb = new Proxy(db, {
      get(target, property) {
        if (property === "query") return (sql: string, values?: unknown[]) => {
          if (/^SELECT.*memoia\.memory_messages/s.test(sql)) messageReads.push(sql);
          return target.query(sql, values);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const deleteProposal = { idempotency_key: "delete-fact", expected_revision: 3, reason: "forget" };
    const deleted = await deleteFact({ ...runtime, db: trackedDb }, scope, fact, deleteProposal);
    assert.equal(deleted.status, "completed");
    assert.deepEqual(messageReads, []);
    assert.deepEqual(await getOperation(runtime, scope, { key: deleteProposal.idempotency_key }), deleted);
    assert.deepEqual(await deleteFact(runtime, scope, fact, deleteProposal), deleted);
    await forgetUser(runtime, scope);
    await assert.rejects(
      stageImport(runtime, scope, {
        ...request,
        idempotency_key: "after-forget",
      }),
      (e: any) => e.code === "user_forgotten",
    );
  } finally {
    await db.query("DELETE FROM memoia.projects WHERE project_id=$1", [
      projectId,
    ]);
    await db.close();
  }
});

test("a retract waiting for append acceptance clears that exact staged input", async () => {
  const db = new Database(process.env.MEMOIA_TEST_DATABASE_URL!);
  const projectId = `retract_append_${randomUUID()}`;
  const scope = { userId: randomUUID(), projectId };
  const env = { OPENAI_API_KEY: "unused" };
  const runtime = { db, env, deadline: Date.now() + 60_000 };
  let release!: () => void;
  const commit = new Promise<void>((resolve) => { release = resolve; });
  let signal!: (pid: number) => void;
  const written = new Promise<number>((resolve) => { signal = resolve; });
  const request = {
    source_id: "dialog",
    idempotency_key: "old",
    messages: [{
      message_id: "x",
      role: "user" as const,
      content: "withdrawn original",
      occurred_at: "2024-05-01T12:00:00Z",
    }],
  };
  let append: ReturnType<typeof stageImport> | undefined;
  let retract: ReturnType<typeof deleteMessages> | undefined;
  try {
    await db.query(
      "INSERT INTO memoia.projects (id,project_id,project_secret,status) VALUES ($1,$2,'local','active')",
      [randomUUID(), projectId],
    );
    await stageImport(runtime, scope, { ...request, idempotency_key: "seed" });
    const pausedDb = new Proxy(db, {
      get(target, property) {
        if (property !== "query") {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string, args?: unknown[]) => {
          if (!sql.startsWith("WITH messages AS (")) return target.query(sql, args);
          return target.transaction(async (tx) => {
            const result = await tx.query(sql, args);
            signal((await tx.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
            await commit;
            return result;
          });
        };
      },
    });
    append = stageImport({ ...runtime, db: pausedDb }, scope, request);
    const pid = await Promise.race([written, append.then(() => {
      throw new Error("Expected to pause append before commit");
    })]);
    retract = deleteMessages(runtime, scope, "dialog", {
      idempotency_key: "retract",
      message_ids: ["x"],
    });
    void retract.catch(() => {});
    let blocked = false;
    for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
      blocked = (await db.query(
        "SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'DELETE FROM memoia.memory_messages%'",
        [pid],
      )).rowCount === 1;
      if (!blocked) await delay(10);
    }
    assert.equal(blocked, true);
    release();
    const [old] = await Promise.all([append, retract]);
    const added = await stageImport(runtime, scope, {
      ...request,
      idempotency_key: "new",
      messages: [{ ...request.messages[0]!, content: "new submission" }],
    });
    const { rows } = await db.query(
      "SELECT id,request->'messages' AS messages FROM memoia.memory_operations WHERE id=ANY($1::uuid[])",
      [[old.operation_id, added.operation_id]],
    );
    assert.deepEqual(rows.find((row) => row.id === old.operation_id)?.messages, []);
    assert.equal(rows.find((row) => row.id === added.operation_id)?.messages[0].content, "new submission");
  } finally {
    release();
    await Promise.allSettled([append, retract]);
    await db.query("DELETE FROM memoia.projects WHERE project_id=$1", [projectId]);
    await db.close();
  }
});

test("old receipts remain readable and only staged imports accept new input", async () => {
  const db = new Database(process.env.MEMOIA_TEST_DATABASE_URL!);
  const projectId = `facts_${randomUUID()}`,
    userId = randomUUID(),
    scope = { userId, projectId },
    blobId = randomUUID(),
    opId = randomUUID();
  const runtime = {
    db,
    env: { OPENAI_API_KEY: "unused" },
    deadline: Date.now() + 60000,
  };
  const raw = String.raw`{"idempotency_key":"golden","source_id":"source","messages":[{"message_id":"a","role":"user","content":"hello","occurred_at":"2024-05-01T12:00:00Z"}],"metadata":{"tiny":1e-7,"whole":1.0,"large":1e20,"negative_zero":-0.0,"hugeint":9007199254740993123456789,"nested":[1e-6,1e-5,1e15,1e16,1.2345678901234567],"\ue000":1,"\ud800\udc00":2,"__proto__":{"x":1.0}}}`;
  const request = { ...JSON.parse(raw), metadata: parseImportMetadata(raw) };
  try {
    await db.query(
      "INSERT INTO memoia.projects(id,project_id,project_secret,status) VALUES ($1,$2,$3,$4)",
      [randomUUID(), projectId, "local", "active"],
    );
    await db.query("INSERT INTO memoia.users(id,project_id) VALUES ($1,$2)", [
      userId,
      projectId,
    ]);
    await db.query(
      "INSERT INTO memoia.memory_sources(user_id,project_id,source_id) VALUES ($1,$2,'source')",
      [userId, projectId],
    );
    await db.query(
      "INSERT INTO memoia.memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at) VALUES ($1,$2,'source','a',repeat('a',64),'user','2024-05-01T12:00:00Z')",
      [userId, projectId],
    );
    await db.query(
      "INSERT INTO memoia.memory_blobs(id,user_id,project_id,source_id,message_ids,status) VALUES ($1,$2,$3,'source','[\"a\"]'::jsonb,'active')",
      [blobId, userId, projectId],
    );
    const output = {
      event_ids: [],
      profile_ids: [],
      fact_ids: [],
      memory_version: 1,
    };
    await db.query(
      "INSERT INTO memoia.memory_operations(id,user_id,project_id,idempotency_key,kind,request_hash,request,source_id,blob_id,status,result) VALUES ($1,$2,$3,'golden','import',$4,$5::jsonb,'source',$6,'completed',$7::jsonb)",
      [
        opId,
        userId,
        projectId,
        "627de596ebf511b3ec9c911d2eb694a500f6c3123bcb6a00aed047a98b44a750",
        JSON.stringify({ idempotency_key: "golden", source_id: "source" }),
        blobId,
        JSON.stringify(output),
      ],
    );
    const receipt = await getOperation(runtime, scope, { operationId: opId });
    assert.equal(receipt.status, "completed");
    assert.deepEqual(receipt.result, output);
    await assert.rejects(retryOperation(runtime, scope, opId),
      (err: any) => err.code === "operation_kind_unsupported");
    await assert.rejects(stageImport(runtime, scope, request),
      (err: any) => err.code === "idempotency_conflict");
    const input = { ...request, source_id: "new-source", idempotency_key: "append" };
    const staged = await stageImport(runtime, scope, input);
    assert.equal((await stageImport(runtime, scope, input)).operation_id, staged.operation_id);
    const { rows: [saved] } = await db.query(
      "SELECT request->'metadata'->>'hugeint' AS integer FROM memoia.memory_operations WHERE id=$1",
      [staged.operation_id],
    );
    assert.equal(saved.integer, "9007199254740993123456789");
  } finally {
    await db.query("DELETE FROM memoia.projects WHERE project_id=$1", [
      projectId,
    ]);
    await db.close();
  }
});
