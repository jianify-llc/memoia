import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Database } from "../src/db";
import {
  queryFacts,
  queryEvents,
  queryProfiles,
  search,
  context,
} from "../src/retrieval";
import { countTokens } from "../src/models";
import { forgetUser, getHistory, importSource } from "../src/facts";
import { flush, consume } from "../src/maintenance";
import worker from "../src/index";

const db = new Database(process.env.MEMOIA_TEST_DATABASE_URL!);
const projectId = `parity_${randomUUID()}`,
  otherProject = `parity_${randomUUID()}`;
const userId = randomUUID(),
  otherUser = randomUUID();
const runtime = {
  db,
  env: {
    OPENAI_API_KEY: "local",
    MAINTENANCE_ENABLED: "true",
    MEMOIA_CONFIG: '{"enable_event_embedding":false}',
  },
  deadline: Date.now() + 120000,
};
const scope = { userId, projectId };
async function createRows(user: string, project: string) {
  const fact = randomUUID(),
    blob = randomUUID(),
    event = randomUUID(),
    profile = randomUUID();
  await db.query(
    "INSERT INTO memoia.memory_sources(user_id,project_id,source_id) VALUES($1,$2,'s')",
    [user, project],
  );
  await db.query(
    "INSERT INTO memoia.memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at) VALUES($1,$2,'s','m',repeat('a',64),'user',now())",
    [user, project],
  );
  await db.query(
    "INSERT INTO memoia.memory_blobs(id,user_id,project_id,source_id,message_ids,status) VALUES($3,$1,$2,'s','[\"m\"]','active')",
    [user, project, blob],
  );
  await db.query(
    "INSERT INTO memoia.memory_facts(id,user_id,project_id,blob_id,content,support_groups,occurred_at) VALUES($3,$1,$2,$4,'hiking','[[\"m\"]]',now())",
    [user, project, fact, blob],
  );
  await db.query(
    "INSERT INTO memoia.user_events(id,user_id,project_id,event_data) VALUES($3,$1,$2,$4::jsonb)",
    [user, project, event, JSON.stringify({ title: "hiking" })],
  );
  await db.query(
    "INSERT INTO memoia.user_profiles(id,user_id,project_id,content,attributes) VALUES($3,$1,$2,'hiking',$4::jsonb)",
    [
      user,
      project,
      profile,
      JSON.stringify({
        topic: "hobby",
        sub_topic: "outdoor",
        fact_ids: [fact],
      }),
    ],
  );
  return { fact, blob, event, profile };
}
try {
  for (const project of [projectId, otherProject])
    await db.query(
      "INSERT INTO memoia.projects(id,project_id,project_secret,status) VALUES($1,$2,'local','active')",
      [randomUUID(), project],
    );
  for (const [user, project] of [
    [userId, projectId],
    [otherUser, projectId],
    [userId, otherProject],
  ])
    await db.query("INSERT INTO memoia.users(id,project_id) VALUES($1,$2)", [
      user,
      project,
    ]);
  const own = await createRows(userId, projectId);
  await createRows(otherUser, projectId);
  await createRows(userId, otherProject);
  await test("real PostgreSQL scopes facts, events and profiles by user/project and excludes IDs before limiting", async () => {
    const inputs = [
      { kind: "facts", id: own.fact, run: queryFacts },
      { kind: "events", id: own.event, run: queryEvents },
      { kind: "profiles", id: own.profile, run: queryProfiles },
    ] as const;
    for (const { kind, id, run } of inputs) {
      const result = await run(runtime, scope, { limit: 1 });
      assert.deepEqual(
        result[kind].map((row: { id: string }) => row.id),
        [id],
        kind,
      );
      const excluded = await run(runtime, scope, {
        limit: 1,
        exclude_ids: [id],
      });
      assert.deepEqual(
        excluded[kind],
        [],
        `${kind}: exclusion must not return other scopes`,
      );
    }
  });
  await test("search and context default budgets retain a complete entry above the old limits", async () => {
    const large = "hiking ".repeat(2400).trim();
    assert.ok(countTokens(large) > 2000 && countTokens(large) < 3000);
    await db.query(
      "UPDATE memoia.memory_facts SET content=$2::text,search_text=$2::text WHERE id=$1",
      [own.fact, large],
    );
    try {
      const found = await search(runtime, scope, {
        query: "hiking",
        include_events: false,
      });
      const result = found.facts.find((f) => f.id === own.fact);
      assert.ok(
        countTokens(JSON.stringify(found)) > 4000,
        "search full bundle exceeds old limit",
      );
      assert.ok(result?.content === large, "search preserves entire fact");
      const contextual = await context(runtime, scope, {});
      assert.ok(
        contextual.entries.some((entry) => entry.includes(large)),
        "context preserves entire fact",
      );
      const small = await context(runtime, scope, { max_token_size: 500 });
      assert.ok(small.entries.every((entry) => !entry.includes(large)));
    } finally {
      await db.query(
        "UPDATE memoia.memory_facts SET content='hiking',search_text=NULL WHERE id=$1",
        [own.fact],
      );
    }
  });
  await test("history removes only entries whose supporting fact is no longer valid", async () => {
    const invalid = {
      id: randomUUID(),
      content: "removed",
      topic: "hobby",
      sub_topic: "one",
      fact_ids: [own.fact],
      _impact_fact_ids: [own.fact],
    };
    const independent = {
      id: randomUUID(),
      content: "unaffected",
      topic: "hobby",
      sub_topic: "two",
      fact_ids: [],
      _impact_fact_ids: [],
    };
    await db.query(
      "INSERT INTO memoia.memory_profile_revisions(id,user_id,project_id,profiles,added,removed) VALUES($1,$2,$3,$4::jsonb,$4::jsonb,$4::jsonb)",
      [randomUUID(), userId, projectId, JSON.stringify([invalid, independent])],
    );
    assert.equal(
      ((await getHistory(runtime, scope))[0].profiles as unknown[]).length,
      2,
    );
    await db.query("DELETE FROM memoia.memory_facts WHERE id=$1", [own.fact]);
    const history = (await getHistory(runtime, scope))[0];
    for (const field of ["profiles", "added", "removed"] as const)
      assert.deepEqual(
        (history[field] as any[]).map((row) => row.content),
        ["unaffected"],
      );
  });
  await test("forget during an in-flight extraction fences late model output", async () => {
    const concurrent = { userId: randomUUID(), projectId };
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      started();
      await gate;
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
                      message_id: "m",
                      facts: [
                        {
                          content: "private fact",
                          subject: "user",
                          reporter: "user",
                          certainty: "asserted",
                          fact_time: null,
                          any_of: [{ all_of: ["m"] }],
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
    try {
      const pending = importSource(runtime, concurrent, {
        idempotency_key: "race",
        source_id: "race",
        messages: [
          {
            message_id: "m",
            role: "user",
            content: "private fact",
            occurred_at: "2024-01-01T00:00:00Z",
          },
        ],
      });
      const result = pending.then(
        () => "completed",
        () => "rejected",
      );
      await entered;
      await forgetUser(runtime, concurrent);
      release();
      assert.equal(await result, "rejected");
      for (const table of [
        "memory_facts",
        "memory_blobs",
        "user_profiles",
        "user_events",
      ])
        assert.equal(
          (
            await db.query(
              `SELECT 1 FROM memoia.${table} WHERE user_id=$1 AND project_id=$2`,
              [concurrent.userId, projectId],
            )
          ).rowCount,
          0,
          table,
        );
      assert.equal(
        (
          await db.query(
            "SELECT 1 FROM memoia.memory_user_tombstones WHERE user_id=$1 AND project_id=$2",
            [concurrent.userId, projectId],
          )
        ).rowCount,
        1,
      );
    } finally {
      release();
      globalThis.fetch = previousFetch;
    }
  });
  await test("forget during an in-flight maintenance model fences its late plan", async () => {
    const current = { userId: randomUUID(), projectId };
    await db.query("INSERT INTO memoia.users(id,project_id) VALUES($1,$2)", [
      current.userId,
      projectId,
    ]);
    const rows = await createRows(current.userId, projectId);
    await db.query(
      "UPDATE memoia.memory_blobs SET fact_completed_at=now(),fact_changes=$2::jsonb WHERE id=$1",
      [
        rows.blob,
        JSON.stringify([{ kind: "added", fact_id: rows.fact, version: 1 }]),
      ],
    );
    const op = await flush(runtime, current, "inflight");
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      started();
      await gate;
      return Response.json({
        id: "resp_local",
        object: "response",
        created_at: 1,
        status: "completed",
        error: null,
        incomplete_details: null,
        model: "local",
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
    };
    try {
      const pending = consume(runtime, {
        kind: "flush",
        user_id: current.userId,
        project_id: projectId,
        operation_id: op.operation_id,
      });
      const settled = pending.then(
        () => "resolved",
        () => "rejected",
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          entered,
          new Promise((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("model not reached")),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
      await forgetUser(runtime, current);
      release();
      await settled;
      for (const table of [
        "memory_facts",
        "memory_blobs",
        "user_profiles",
        "user_events",
      ])
        assert.equal(
          (
            await db.query(
              `SELECT 1 FROM memoia.${table} WHERE user_id=$1 AND project_id=$2`,
              [current.userId, projectId],
            )
          ).rowCount,
          0,
          table,
        );
      assert.equal(
        (
          await db.query(
            "SELECT 1 FROM memoia.memory_user_tombstones WHERE user_id=$1 AND project_id=$2",
            [current.userId, projectId],
          )
        ).rowCount,
        1,
      );
    } finally {
      release();
      globalThis.fetch = previousFetch;
    }
  });
  await test("forgotten identity cannot be recreated by delayed flush or later import", async () => {
    const op = await flush(runtime, scope, "before-forget");
    await forgetUser(runtime, scope);
    await assert.rejects(
      consume(runtime, {
        kind: "flush",
        user_id: userId,
        project_id: projectId,
        operation_id: op.operation_id,
      }),
    );
    await assert.rejects(
      importSource(runtime, scope, {
        idempotency_key: "late",
        source_id: "late",
        messages: [
          {
            message_id: "m",
            role: "user",
            content: "private",
            occurred_at: "2024-01-01T00:00:00Z",
          },
        ],
      }),
      (e: any) => e.code === "user_forgotten",
    );
    let acks = 0,
      retries = 0;
    const queueEnv = {
      ...runtime.env,
      DATABASE_URL: process.env.MEMOIA_TEST_DATABASE_URL!,
    };
    const wakeup = {
      kind: "flush" as const,
      user_id: userId,
      project_id: projectId,
      operation_id: op.operation_id,
    };
    const deliver = async (body: typeof wakeup) =>
      worker.queue(
        {
          messages: [{ body, ack: () => acks++, retry: () => retries++ }],
        } as unknown as MessageBatch<typeof wakeup>,
        queueEnv,
      );
    await deliver(wakeup);
    assert.equal(acks, 1, "confirmed tombstone acknowledges the stale wakeup");
    assert.equal(retries, 0);
    await deliver({ ...wakeup, user_id: randomUUID() });
    assert.equal(
      acks,
      1,
      "missing identity alone is not proof of permanent forgetting",
    );
    assert.equal(retries, 1);
    for (const table of [
      "users",
      "memory_facts",
      "memory_blobs",
      "user_profiles",
      "user_events",
    ]) {
      const rows = await db.query(
        `SELECT 1 FROM memoia.${table} WHERE ${table === "users" ? "id" : "user_id"}=$1 AND project_id=$2`,
        [userId, projectId],
      );
      assert.equal(rows.rowCount, 0, table);
    }
    assert.equal(
      (
        await db.query(
          "SELECT 1 FROM memoia.users WHERE id=$1 AND project_id=$2",
          [userId, otherProject],
        )
      ).rowCount,
      1,
    );
  });
} finally {
  for (const project of [projectId, otherProject])
    await db.query("DELETE FROM memoia.projects WHERE project_id=$1", [
      project,
    ]);
  await db.close();
}
