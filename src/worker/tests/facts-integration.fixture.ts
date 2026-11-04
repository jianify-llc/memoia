import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Database } from "../src/db";
import { parseImportMetadata, prepareImportBody } from "../src/canonical";
import {
  deleteMessages,
  updateFact,
  deleteFact,
  importSource,
  getSource,
  getHistory,
  forgetUser,
  purgeExpiredInputs,
  retryOperation,
} from "../src/facts";

test("large processed imports batch identity checks and preserve tombstones", async () => {
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
      if (property === "transaction")
        return (fn: (tx: any) => Promise<unknown>, options: any) =>
          target.transaction(
            (tx) =>
              fn({
                query(sql: string, values: unknown[]) {
                  if (/^SELECT .* FROM memoia\.memory_messages WHERE/.test(sql))
                    reads.push(sql);
                  return tx.query(sql, values);
                },
              }),
            options,
          );
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const runtime = {
    db: trackedDb,
    env: { OPENAI_API_KEY: "unused" },
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
    const result = await importSource(runtime, scope, request);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.result.fact_ids, []);
    assert.equal(reads.length, 2);
    assert.ok(reads.every((sql) => sql.includes("message_id=ANY(")));
    assert.equal(
      (await importSource(runtime, scope, request)).operation_id,
      result.operation_id,
    );
    await assert.rejects(
      importSource(runtime, scope, {
        ...request,
        idempotency_key: "changed",
        messages: [{ ...message("m1"), content: "different" }],
      }),
      (e: any) => e.code === "message_conflict",
    );
    await assert.rejects(
      importSource(runtime, scope, {
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
    await importSource(runtime, scope, {
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
      importSource(runtime, scope, {
        ...request,
        idempotency_key: "other-timezone",
        messages: [{ ...message("m1"), time_zone: "Europe/London" }],
      }),
      (e: any) => e.code === "message_conflict",
    );
    await deleteMessages(runtime, scope, sourceId, {
      idempotency_key: "delete-late",
      message_ids: ["late"],
    });
    assert.equal(
      (
        await importSource(runtime, scope, {
          ...request,
          idempotency_key: "late-import",
          messages: [message("late")],
        })
      ).status,
      "completed",
    );
    const late = (
      await db.query(
        "SELECT deleted,content_hash FROM memoia.memory_messages WHERE user_id=$1 AND project_id=$2 AND source_id=$3 AND message_id='late'",
        [scope.userId, projectId, sourceId],
      )
    ).rows[0];
    assert.equal(late.deleted, true);
    assert.equal(late.content_hash, null);
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
    await assert.rejects(importSource(runtime, scope, request));
    const read = async () =>
      (
        await db.query(
          "SELECT id,blob_id,input_expires_at,request,extract(epoch FROM (input_expires_at-clock_timestamp())) AS remaining FROM memoia.memory_operations WHERE user_id=$1 AND project_id=$2 AND idempotency_key=$3",
          [scope.userId, projectId, request.idempotency_key],
        )
      ).rows[0];
    const first = await read();
    assert.ok(Number(first.remaining) > 0 && Number(first.remaining) <= 30);
    await assert.rejects(importSource(runtime, scope, request));
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
    const oldBlob = randomUUID(),
      recentBlob = randomUUID();
    await db.query(
      "INSERT INTO memoia.general_blobs(id,user_id,project_id,blob_type,blob_data,created_at) VALUES ($1,$3,$4,'chat','{}'::jsonb,clock_timestamp()-interval '60 seconds'),($2,$3,$4,'chat','{}'::jsonb,clock_timestamp())",
      [oldBlob, recentBlob, scope.userId, projectId],
    );
    await purgeExpiredInputs(runtime);
    const purged = await read();
    assert.equal(purged.input_expires_at, null);
    assert.deepEqual(purged.request, {
      source_id: request.source_id,
      idempotency_key: request.idempotency_key,
    });
    assert.deepEqual(
      (
        await db.query(
          "SELECT id FROM memoia.general_blobs WHERE id=ANY($1::uuid[])",
          [[oldBlob, recentBlob]],
        )
      ).rows.map((row) => row.id),
      [recentBlob],
    );
    await assert.rejects(importSource(runtime, scope, request));
    const restored = await read();
    assert.equal(restored.id, first.id);
    assert.ok(
      Number(restored.remaining) > 0 && Number(restored.remaining) <= 30,
    );
    assert.equal(restored.request.messages[0].content, "hello");

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
    const originalCorrection = await readCorrection();
    assert.ok(
      Number(originalCorrection.remaining) > 0 &&
        Number(originalCorrection.remaining) <= 30,
    );
    await assert.rejects(
      retryOperation(correctionRuntime, scope, originalCorrection.id),
      (e: any) => e.code === "embedding_unavailable",
    );
    assert.equal(
      (await readCorrection()).input_expires_at.getTime(),
      originalCorrection.input_expires_at.getTime(),
    );
    await db.query(
      "UPDATE memoia.memory_operations SET input_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [originalCorrection.id],
    );
    await purgeExpiredInputs(correctionRuntime);
    assert.equal((await readCorrection()).request.content, undefined);
    await assert.rejects(
      retryOperation(correctionRuntime, scope, originalCorrection.id),
      (e: any) => e.code === "input_required",
    );
    const replenished = await updateFact(
      correctionRuntime,
      scope,
      factId,
      proposal,
    );
    assert.equal(replenished.operation_id, originalCorrection.id);
    assert.equal(replenished.status, "failed");
    const supplied = await readCorrection();
    assert.ok(
      Number(supplied.remaining) > 0 && Number(supplied.remaining) <= 30,
    );
    globalThis.fetch = async () =>
      Response.json({
        data: [{ index: 0, embedding: Array(1536).fill(0.01) }],
      });
    assert.equal(
      (await retryOperation(correctionRuntime, scope, originalCorrection.id))
        .status,
      "completed",
    );
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
    const imported = await importSource(runtime, scope, request);
    assert.equal(imported.status, "completed");
    assert.deepEqual(imported.result.fact_ids, []);
    assert.equal(
      (await importSource(runtime, scope, request)).operation_id,
      imported.operation_id,
    );
    const legacyBlob = randomUUID(),
      legacyBuffer = randomUUID();
    await db.query(
      "INSERT INTO memoia.general_blobs(id,user_id,project_id,blob_type,blob_data) VALUES ($1,$2,$3,'chat','{}'::jsonb)",
      [legacyBlob, userId, projectId],
    );
    await db.query(
      "INSERT INTO memoia.buffer_zones(id,user_id,project_id,blob_id,blob_type,token_size,status) VALUES ($1,$2,$3,$4,'chat',1,'processing')",
      [legacyBuffer, userId, projectId, legacyBlob],
    );
    assert.equal(
      (
        await importSource(
          runtime,
          scope,
          { ...request, idempotency_key: "legacy-cleanup" },
          false,
          { buffer_ids: [legacyBuffer], blob_ids: [legacyBlob] },
        )
      ).status,
      "completed",
    );
    assert.equal(
      (
        await db.query("SELECT id FROM memoia.general_blobs WHERE id=$1", [
          legacyBlob,
        ])
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await db.query("SELECT id FROM memoia.buffer_zones WHERE id=$1", [
          legacyBuffer,
        ])
      ).rowCount,
      0,
    );
    await assert.rejects(
      importSource(runtime, scope, {
        ...request,
        messages: [{ ...request.messages[0], content: "changed" }],
      }),
      (e: any) => e.code === "idempotency_conflict",
    );
    await assert.rejects(
      importSource(runtime, scope, {
        ...request,
        idempotency_key: "another-key",
        messages: [{ ...request.messages[0], content: "changed" }],
      }),
      (e: any) => e.code === "message_conflict",
    );
    const retract = await deleteMessages(runtime, scope, sourceId, {
      idempotency_key: "retract-a",
      message_ids: ["a"],
    });
    assert.equal(retract.status, "completed");
    const after = await getSource(runtime, scope, sourceId);
    assert.deepEqual(after.evidence[0].support_groups, [["b"]]);
    assert.equal(after.evidence[0].fact_time, null);
    assert.equal(after.evidence[0].revision, 2);
    assert.deepEqual((await getHistory(runtime, scope))[0].profiles, []);
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
    assert.equal(
      (
        await deleteFact(runtime, scope, fact, {
          idempotency_key: "delete-fact",
          expected_revision: 3,
          reason: "forget",
        })
      ).status,
      "completed",
    );
    await forgetUser(runtime, scope);
    await assert.rejects(
      importSource(runtime, scope, {
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

test("saved image extraction survives embedding failure and completed receipts erase temporary input", async () => {
  const db = new Database(process.env.MEMOIA_TEST_DATABASE_URL!);
  const projectId = `facts_${randomUUID()}`,
    userId = randomUUID(),
    scope = { userId, projectId };
  const runtime = {
    db,
    env: {
      OPENAI_API_KEY: "local-test-only",
      EMBEDDING_API_KEY: "local-test-only",
      EMBEDDING_BASE_URL: "https://embed.invalid/v1",
      MEMOIA_CONFIG: JSON.stringify({
        embedding_provider: "jina",
        embedding_model: "jina-embeddings-v3",
        embedding_dim: 1536,
      }),
    },
    deadline: Date.now() + 60000,
  };
  const originalFetch = globalThis.fetch;
  let completions = 0,
    embedded = 0;
  globalThis.fetch = async (request: string | URL | Request) => {
    const url =
      typeof request === "string"
        ? request
        : request instanceof URL
          ? request.toString()
          : request.url;
    if (url.endsWith("/responses")) {
      completions++;
      return Response.json({
        status: "completed",
        output: [
          {
            type: "message",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  messages: [
                    {
                      message_id: "a",
                      facts: [
                        {
                          content: "A blue bicycle.",
                          subject: "bicycle",
                          reporter: "user",
                          certainty: "asserted",
                          fact_time: null,
                          any_of: [{ all_of: ["a"] }],
                        },
                      ],
                    },
                  ],
                }),
              },
            ],
          },
        ],
      });
    }
    if (url.endsWith("/embeddings")) {
      embedded++;
      return embedded === 1 || embedded === 3 || embedded === 5
        ? new Response("", { status: 503 })
        : Response.json({
            data: [{ index: 0, embedding: Array(1536).fill(0.01) }],
          });
    }
    throw new Error("Unexpected provider request");
  };
  try {
    await db.query(
      "INSERT INTO memoia.projects(id,project_id,project_secret,status) VALUES ($1,$2,$3,$4)",
      [randomUUID(), projectId, "local", "active"],
    );
    const url = "https://images.example.org/temporary.png?secret=test";
    const imageRaw = String.raw`{"idempotency_key":"image","source_id":"image-source","messages":[{"message_id":"a","role":"user","content":"","occurred_at":"2024-05-01T12:00:00Z","images":[{"url":"https://images.example.org/temporary.png?secret=test","mimeType":"image/png","width":9007199254740993123456789,"height":1,"byteSize":1}]}]}`;
    const request = prepareImportBody(imageRaw, JSON.parse(imageRaw));
    for (const privateUrl of [
      "http://127.0.0.1/a",
      "http://10.0.0.1/a",
      "http://[::1]/a",
      "http://localhost./a",
      "https://user:pass@example.com/a",
    ]) {
      await assert.rejects(
        importSource(runtime, scope, {
          ...request,
          messages: [
            {
              ...request.messages[0],
              images: [{ ...request.messages[0].images[0], url: privateUrl }],
            },
          ],
        }),
        (e: any) => e.code === "invalid_input",
      );
    }
    await assert.rejects(
      importSource(runtime, scope, request),
      (e: any) => e.code === "embedding_unavailable",
    );
    const failed = (
      await db.query(
        "SELECT * FROM memoia.memory_operations WHERE user_id=$1 AND project_id=$2",
        [userId, projectId],
      )
    ).rows[0];
    assert.equal(failed.status, "failed");
    const imageHash = (
      await db.query(
        "SELECT content_hash FROM memoia.memory_messages WHERE user_id=$1 AND project_id=$2 AND source_id='image-source' AND message_id='a'",
        [userId, projectId],
      )
    ).rows[0].content_hash;
    assert.equal(
      imageHash,
      "38f3ce91a99a7c5b4f84840a059046d16a950cd2dd547e5669e86f8a0db17325",
    );
    assert.ok(failed.request.fact_review_candidate);
    assert.equal(JSON.stringify(failed.request).includes(url), false);
    const result = await importSource(runtime, scope, request);
    assert.equal(result.status, "completed");
    assert.equal(completions, 1);
    assert.equal(embedded, 2);
    const completed = (
      await db.query(
        "SELECT request,input_expires_at FROM memoia.memory_operations WHERE id=$1",
        [result.operation_id],
      )
    ).rows[0];
    assert.deepEqual(completed.request, {
      source_id: "image-source",
      idempotency_key: "image",
    });
    assert.equal(completed.input_expires_at, null);
    const expiredRequest = {
      ...request,
      idempotency_key: "expired",
      source_id: "expired-source",
    };
    await assert.rejects(
      importSource(runtime, scope, expiredRequest),
      (e: any) => e.code === "embedding_unavailable",
    );
    await db.query(
      "UPDATE memoia.memory_operations SET input_expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1 AND project_id=$2 AND idempotency_key='expired'",
      [userId, projectId],
    );
    await purgeExpiredInputs(runtime);
    const expired = (
      await db.query(
        "SELECT request,input_expires_at FROM memoia.memory_operations WHERE user_id=$1 AND project_id=$2 AND idempotency_key='expired'",
        [userId, projectId],
      )
    ).rows[0];
    assert.deepEqual(expired.request, {
      source_id: "expired-source",
      idempotency_key: "expired",
    });
    assert.equal(expired.input_expires_at, null);
    assert.equal(
      (await importSource(runtime, scope, expiredRequest)).status,
      "completed",
    );
    assert.equal(completions, 3);
    const raw = String.raw`{"metadata":{"fraction":1.0,"exponent":1e20,"integer":9007199254740993123456789}}`;
    const textRequest = {
      idempotency_key: "numeric-retry",
      source_id: "numeric-source",
      metadata: parseImportMetadata(raw),
      messages: [
        {
          message_id: "a",
          role: "user" as const,
          content: "A blue bicycle.",
          occurred_at: "2024-05-01T12:00:00Z",
        },
      ],
    };
    await assert.rejects(
      importSource(runtime, scope, textRequest),
      (e: any) => e.code === "embedding_unavailable",
    );
    const pending = (
      await db.query(
        "SELECT id,request->'metadata'->>'integer' AS number FROM memoia.memory_operations WHERE user_id=$1 AND project_id=$2 AND idempotency_key='numeric-retry'",
        [userId, projectId],
      )
    ).rows[0];
    assert.equal(pending.number, "9007199254740993123456789");
    assert.equal(
      (await retryOperation(runtime, scope, pending.id)).status,
      "completed",
    );
    assert.equal(completions, 4);
  } finally {
    globalThis.fetch = originalFetch;
    await db.query("DELETE FROM memoia.projects WHERE project_id=$1", [
      projectId,
    ]);
    await db.close();
  }
});

test("a Python-created receipt remains readable for the original numeric metadata payload", async () => {
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
  const request = JSON.parse(raw);
  request.metadata = parseImportMetadata(raw);
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
    assert.equal(
      (await importSource(runtime, scope, request)).operation_id,
      opId,
    );
  } finally {
    await db.query("DELETE FROM memoia.projects WHERE project_id=$1", [
      projectId,
    ]);
    await db.close();
  }
});
