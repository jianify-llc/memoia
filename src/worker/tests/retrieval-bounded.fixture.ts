import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Database } from "../src/db";
import { getSource } from "../src/facts";
import { context, getEvents, search } from "../src/retrieval";

const id = (n: number) =>
  `00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;

test("search ranks and bounds associated candidates before loading evidence", async (t) => {
  const db = new Database(process.env.MEMOIA_TEST_DATABASE_URL!);
  const projectId = `bounded_${randomUUID()}`,
    userId = randomUUID(),
    blob = randomUUID();
  const strong = id(1),
    weak = id(2),
    late = id(2000),
    excludedEvent = id(100),
    excludedProfile = id(101);
  const reads: Array<{ sql: string; values: unknown[]; count: number }> = [];
  let profileReadPending = false;
  let eventReadOverlapped = false;
  let activeReads = 0;
  let peakReads = 0;
  const tracked = (tx: any) => ({
    query: async (sql: string, values: unknown[] = []) => {
      const profileRead = sql.startsWith("SELECT p.* FROM memoia.user_profiles p");
      if (profileRead) profileReadPending = true;
      if (sql.startsWith("SELECT e.* FROM memoia.user_events e JOIN ("))
        eventReadOverlapped = profileReadPending;
      peakReads = Math.max(peakReads, ++activeReads);
      try {
        const result = await tx.query(sql, values);
        reads.push({ sql, values, count: result.rows.length });
        return result;
      } finally {
        activeReads--;
        if (profileRead) profileReadPending = false;
      }
    },
  });
  const runtime = {
    db: {
      ...tracked(db),
      transaction: () => assert.fail("retrieval must use standalone SQL"),
    },
    env: { MEMOIA_CONFIG: '{"enable_event_embedding":false}' },
  } as any;
  try {
    await db.query(
      "INSERT INTO memoia.projects(id,project_id,project_secret,status) VALUES($1,$2,'local','active')",
      [randomUUID(), projectId],
    );
    await db.query("INSERT INTO memoia.users(id,project_id) VALUES($1,$2)", [
      userId,
      projectId,
    ]);
    const otherBlob = randomUUID();
    await db.query(
      "INSERT INTO memoia.memory_sources(user_id,project_id,source_id) VALUES($1,$2,'s'),($1,$2,'other')",
      [userId, projectId],
    );
    await db.query(
      "INSERT INTO memoia.memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at) VALUES($1,$2,'s','m',repeat('a',64),'user','2026-01-01'),($1,$2,'other','m',repeat('a',64),'user','2026-02-01')",
      [userId, projectId],
    );
    await db.query(
      "INSERT INTO memoia.memory_blobs(id,user_id,project_id,source_id,message_ids,status) VALUES($3,$1,$2,'s','[\"m\"]','active'),($4,$1,$2,'other','[\"m\"]','active')",
      [userId, projectId, blob, otherBlob],
    );
    await db.query(
      "INSERT INTO memoia.memory_facts(id,user_id,project_id,blob_id,content,support_groups,occurred_at) VALUES($3,$1,$2,$4,'hiking','[[\"m\"]]',now()),($5,$1,$2,$6,'hiking','[[\"m\"]]',now())",
      [userId, projectId, strong, blob, weak, otherBlob],
    );
    await db.query(
      "INSERT INTO memoia.user_events(id,user_id,project_id,event_data) SELECT ('00000000-0000-0000-0000-' || lpad(to_hex(n),12,'0'))::uuid,$1,$2,'{\"title\":\"event\",\"memoia_v2\":true}'::jsonb FROM generate_series(100,1099) n",
      [userId, projectId],
    );
    await db.query(
      'INSERT INTO memoia.user_events(id,user_id,project_id,event_data) VALUES($3,$1,$2,\'{"title":"strong","memoia_v2":true}\')',
      [userId, projectId, late],
    );
    await db.query(
      "INSERT INTO memoia.memory_event_facts(user_id,project_id,event_id,fact_id) SELECT $1::uuid,$2::varchar,id,CASE WHEN id=$3::uuid THEN $4::uuid ELSE $5::uuid END FROM memoia.user_events WHERE user_id=$1::uuid AND project_id=$2::varchar",
      [userId, projectId, late, strong, weak],
    );
    await db.query(
      "INSERT INTO memoia.user_profiles(id,user_id,project_id,content,attributes) SELECT ('00000000-0000-0000-0000-' || lpad(to_hex(n+3000),12,'0'))::uuid,$1,$2,'profile',jsonb_build_object('topic',CASE WHEN n=0 THEN 'excluded' ELSE 'ok' END,'fact_ids',jsonb_build_array($3::text)) FROM generate_series(0,99) n",
      [userId, projectId, weak],
    );
    await db.query(
      "INSERT INTO memoia.user_profiles(id,user_id,project_id,content,attributes) VALUES($3,$1,$2,'strong',jsonb_build_object('topic','ok','fact_ids',jsonb_build_array($4::text))),($5,$1,$2,'excluded',jsonb_build_object('topic','ok','fact_ids',jsonb_build_array($4::text)))",
      [userId, projectId, id(4000), strong, excludedProfile],
    );
    const result = await search(
      runtime,
      { userId, projectId },
      {
        query: "hiking",
        limit: 10,
        max_token_size: 8192,
        exclude_event_ids: [excludedEvent],
        exclude_profile_ids: [excludedProfile],
        exclude_profile_topics: ["excluded"],
      },
    );
    assert.equal(result.facts.length, 2);
    assert.deepEqual(result.facts.map((entry) => entry.evidence.source_messages[0].recorded_at.slice(0, 10)), ["2026-01-01", "2026-02-01"]);
    const evidenceReads = reads.filter(({ sql }) => sql.includes("JOIN memoia.memory_messages"));
    assert.ok(evidenceReads.some(({ count }) => count === 2), "one evidence read covers both Sources");
    assert.equal(result.events.length, 10);
    assert.equal(result.profiles.length, 10);
    assert.equal(result.events[0].id, late);
    assert.equal(result.events[0].source_id, "s");
    assert.equal(
      result.events.find((event) => event.id !== late)?.source_id,
      "other",
    );
    assert.equal(result.profiles[0].id, id(4000));
    assert.ok(result.events.every((x) => x.id !== excludedEvent));
    assert.ok(
      result.profiles.every(
        (x) => x.id !== excludedProfile && x.topic !== "excluded",
      ),
    );
    const events = reads.find((x) =>
      x.sql.includes("SELECT e.* FROM memoia.user_events e JOIN ("),
    )!;
    const profiles = reads.find(
      (x) =>
        x.sql.includes("SELECT p.* FROM memoia.user_profiles p") &&
        x.sql.includes("matched.score"),
    )!;
    assert.equal(events.count, 50);
    assert.equal(profiles.count, 50);
    assert.equal(eventReadOverlapped, true);
    assert.ok(peakReads <= 3, `search issued ${peakReads} concurrent database reads`);
    assert.deepEqual(events.values.slice(0, 2), [userId, projectId]);
    assert.deepEqual(profiles.values.slice(0, 2), [userId, projectId]);
    const edges = reads.find((x) =>
      x.sql.startsWith("SELECT event_id,fact_id"),
    )!;
    assert.equal((edges.values[2] as string[]).length, 50);
    const factReads = reads.filter(({ sql }) =>
      sql.startsWith("SELECT f.*,b.source_id,b.external_id"),
    );
    assert.equal(factReads.length, 3);

    const source = await getSource(runtime, { userId, projectId }, "other");
    assert.deepEqual(source.evidence[0]?.source_messages, [
      { message_id: "m", recorded_at: "2026-02-01T00:00:00.000000Z", time_zone: null },
    ]);

    const coordinates = Array(1536).fill(0.01);
    const vector = JSON.stringify(coordinates);
    const legacy = randomUUID();
    await db.query(
      "INSERT INTO memoia.memory_event_facts(user_id,project_id,event_id,fact_id) VALUES($1,$2,$3,$4)",
      [userId, projectId, late, weak],
    );
    await db.query("UPDATE memoia.memory_facts SET embedding=$1 WHERE id=$2 AND project_id=$3", [vector, strong, projectId]);
    await db.query(
      "INSERT INTO memoia.user_events(id,user_id,project_id,event_data,embedding) VALUES($1,$2,$3,$4,$5)",
      [legacy, userId, projectId, { event_tip: "A legacy outing" }, vector],
    );
    const embeddingCall = t.mock.method(globalThis, "fetch", async () => Response.json({
      data: [{ index: 0, embedding: coordinates }],
    }));
    const vectorRuntime = {
      ...runtime,
      env: { OPENAI_API_KEY: "fixture-only" },
      deadline: Date.now() + 30_000,
      db: {
        query: db.query.bind(db),
        vectorSchema: db.vectorSchema.bind(db),
        transaction: () => assert.fail("semantic retrieval must use standalone SQL"),
      },
    };
    const scope = { userId, projectId };
    const query = "no lexical matches for this query";
    const semantic = await search(vectorRuntime, scope, { query });
    assert.equal(semantic.facts[0]?.id, strong);
    assert.ok(semantic.events.some((event) => event.id === legacy));
    assert.equal(
      semantic.events.find((event) => event.id === late)?.source_id,
      null,
    );
    const recalled = await context(vectorRuntime, scope, { query });
    assert.ok(recalled.entries.some((entry) => entry.includes("hiking")));
    assert.ok(recalled.entries.includes("A legacy outing"));
    assert.equal(embeddingCall.mock.callCount(), 2);
    const recent = await getEvents(vectorRuntime, scope, 1, 7);
    assert.equal(recent.events[0]?.id, legacy);
    assert.equal(recent.events[0]?.event_data.event_tip, "A legacy outing");
    assert.equal("fact_ids" in recent.events[0]!.event_data, false);
  } finally {
    await db.query("DELETE FROM memoia.projects WHERE project_id=$1", [
      projectId,
    ]);
    await db.close();
  }
});
