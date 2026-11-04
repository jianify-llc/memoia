import { test } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../src/db";
import { forgetUser, importSource } from "../src/facts";
import { pythonHash } from "../src/canonical";

test("10,000 existing Facts: small imports retrieve only batch messages, then scoped deletion completes", async () => {
  const db = new Database(process.env.MEMOIA_TEST_DATABASE_URL!);
  const project = `scale_${crypto.randomUUID()}`,
    user = crypto.randomUUID(),
    other = crypto.randomUUID();
  const scope = { userId: user, projectId: project };
  const occurred = "2024-05-01T12:00:00Z";
  const digest = await pythonHash({
    role: "user",
    content: "old record",
    occurred_at: "2024-05-01T12:00:00+00:00",
  });
  const reads: Array<{ sql: string; values: unknown[]; rows: number }> = [];
  function tracked<T extends object>(target: T): T {
    return new Proxy(target, {
      get(object, key) {
        if (key === "query")
          return async (sql: string, values: unknown[] = []) => {
            const result = await (object as any).query(sql, values);
            if (/^\s*select\b/i.test(sql))
              reads.push({ sql, values, rows: result.rows.length });
            return result;
          };
        if (key === "transaction")
          return (callback: (tx: any) => Promise<unknown>) =>
            db.transaction((tx) => callback(tracked(tx)));
        const value = Reflect.get(object, key, object);
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
  }
  const runtime = {
    db: tracked(db),
    env: {
      OPENAI_API_KEY: "local-test-only",
      OPENAI_BASE_URL: "https://provider.invalid/v1",
      MEMOIA_CONFIG: '{"enable_event_embedding":false}',
    },
    deadline: Date.now() + 300_000,
  };
  const fetchOriginal = globalThis.fetch,
    infoOriginal = console.info;
  let activeMessage = "",
    modelCalls = 0;
  globalThis.fetch = async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    assert.equal(new URL(url).pathname, "/v1/responses");
    modelCalls++;
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
                    message_id: activeMessage,
                    facts: [
                      {
                        content: `New Fact ${activeMessage}`,
                        subject: "user",
                        reporter: "user",
                        certainty: "asserted",
                        fact_time: null,
                        any_of: [{ all_of: [activeMessage] }],
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
  };
  console.info = (...args) => {
    if (!String(args[0]).includes('"event":"model_usage"'))
      infoOriginal(...args);
  };
  try {
    await db.transaction(async (tx) => {
      await tx.query(
        "INSERT INTO memoia.projects(id,project_id,project_secret,status) VALUES($1,$2,'local','active')",
        [crypto.randomUUID(), project],
      );
      await tx.query(
        "INSERT INTO memoia.users(id,project_id) VALUES($1,$3),($2,$3)",
        [user, other, project],
      );
      await tx.query(
        "INSERT INTO memoia.memory_sources(user_id,project_id,source_id) VALUES($1,$3,'long-source'),($2,$3,'other-source')",
        [user, other, project],
      );
      await tx.query(
        "INSERT INTO memoia.memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at,processed) SELECT $1,$2,'long-source','m'||n,$3,'user',$4,true FROM generate_series(1,10000) n",
        [user, project, digest, occurred],
      );
      await tx.query(
        "INSERT INTO memoia.memory_blobs(id,user_id,project_id,source_id,message_ids,status) SELECT gen_random_uuid(),$1,$2,'long-source',jsonb_agg('m'||n),'active' FROM generate_series(1,10000)n GROUP BY (n-1)/200",
        [user, project],
      );
      await tx.query(
        "INSERT INTO memoia.memory_facts(id,user_id,project_id,blob_id,content,subject,reporter,certainty,support_groups,occurred_at,search_text) SELECT gen_random_uuid(),$1::uuid,$2::varchar,b.id,'Fact '||m.id,'user','user','asserted',jsonb_build_array(jsonb_build_array(m.id)),$3,'Fact '||m.id FROM memoia.memory_blobs b CROSS JOIN LATERAL jsonb_array_elements_text(b.message_ids)m(id) WHERE b.user_id=$1::uuid AND b.project_id=$2::varchar",
        [user, project, occurred],
      );
      await tx.query(
        "INSERT INTO memoia.memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at,processed) VALUES($1,$2,'other-source','other-message',$3,'user',$4,true)",
        [other, project, digest, occurred],
      );
      const otherBlob = crypto.randomUUID();
      await tx.query(
        "INSERT INTO memoia.memory_blobs(id,user_id,project_id,source_id,message_ids,status) VALUES($1,$2,$3,'other-source','[\"other-message\"]'::jsonb,'active')",
        [otherBlob, other, project],
      );
      await tx.query(
        "INSERT INTO memoia.memory_facts(id,user_id,project_id,blob_id,content,subject,reporter,certainty,support_groups,occurred_at,search_text) VALUES($1,$2,$3,$4,'other Fact','user','user','asserted','[[\"other-message\"]]'::jsonb,$5,'other Fact')",
        [crypto.randomUUID(), other, project, otherBlob, occurred],
      );
    });
    const seed = (
      await db.query(
        "SELECT count(*)::int AS n FROM memoia.memory_facts WHERE user_id=$1 AND project_id=$2",
        [user, project],
      )
    ).rows[0].n;
    assert.equal(seed, 10000);
    const noop = await importSource(runtime, scope, {
      idempotency_key: "noop",
      source_id: "long-source",
      messages: [
        {
          message_id: "m1",
          role: "user",
          content: "old record",
          occurred_at: occurred,
        },
      ],
    });
    assert.equal(noop.status, "completed");
    assert.deepEqual(noop.result.fact_ids, []);
    assert.equal(modelCalls, 0);
    const noOpReads = reads.splice(0);
    assert.ok(noOpReads.length <= 20, `noop used ${noOpReads.length} SELECTs`);
    const perBatchSelects: number[] = [];
    for (let n = 1; n <= 201; n++) {
      const before = reads.length;
      activeMessage = `new-${n}`;
      const result = await importSource(runtime, scope, {
        idempotency_key: `append-${n}`,
        source_id: "long-source",
        messages: [
          {
            message_id: activeMessage,
            role: "user",
            content: `New record ${n}`,
            occurred_at: occurred,
          },
        ],
      });
      assert.equal(result.status, "completed");
      assert.equal(result.result.fact_ids.length, 1);
      perBatchSelects.push(reads.length - before);
    }
    assert.ok(
      perBatchSelects.every((n) => n <= 25),
      `unexpected SELECT count per batch: ${Math.max(...perBatchSelects)}`,
    );
    assert.equal(modelCalls, 201);
    const appendReads = reads.splice(0);
    for (const phaseReads of [noOpReads, appendReads]) {
      assert.equal(
        phaseReads.filter((r) => /\bfrom\s+memoia\.memory_facts\b/i.test(r.sql))
          .length,
        0,
        "import must not select historical Facts",
      );
      const messageReads = phaseReads.filter((r) =>
        /\bfrom\s+memoia\.memory_messages\b/i.test(r.sql),
      );
      assert.ok(messageReads.length > 0);
      assert.ok(
        messageReads.every((r) => r.rows <= 1),
        "single-message batches must not retrieve older messages",
      );
      assert.ok(
        messageReads.every((r) =>
          /message_id\s*=\s*(?:\$4|any\()/i.test(r.sql),
        ),
        "message reads must be limited to supplied identities",
      );
    }
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int AS n FROM memoia.memory_facts WHERE user_id=$1 AND project_id=$2",
          [user, project],
        )
      ).rows[0].n,
      10201,
    );
    const started = Date.now();
    await forgetUser(runtime, scope);
    const elapsed = Date.now() - started;
    for (const table of [
      "memory_facts",
      "memory_messages",
      "memory_blobs",
      "memory_operations",
      "memory_sources",
    ]) {
      const result = await db.query(
        `SELECT count(*)::int AS n FROM memoia.${table} WHERE user_id=$1 AND project_id=$2`,
        [user, project],
      );
      assert.equal(result.rows[0].n, 0, `${table} must be removed`);
    }
    const otherState = await db.query(
      "SELECT u.id,f.content FROM memoia.users u JOIN memoia.memory_facts f ON f.user_id=u.id AND f.project_id=u.project_id WHERE u.id=$1 AND u.project_id=$2",
      [other, project],
    );
    assert.equal(otherState.rowCount, 1);
    assert.equal(otherState.rows[0].content, "other Fact");
    assert.ok(elapsed < 30000, `scoped deletion took ${elapsed} ms`);
    infoOriginal(
      JSON.stringify({
        event: "local_source_scale",
        seed_facts: seed,
        appended_batches: 201,
        model_calls: modelCalls,
        noop_selects: noOpReads.length,
        append_selects: appendReads.length,
        max_selects_per_batch: Math.max(...perBatchSelects),
        selected_historical_facts: 0,
        elapsed_ms: elapsed,
      }),
    );
  } finally {
    globalThis.fetch = fetchOriginal;
    console.info = infoOriginal;
    await db.query("DELETE FROM memoia.projects WHERE project_id=$1", [
      project,
    ]);
    await db.close();
  }
});
