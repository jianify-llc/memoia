import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Database } from "../src/db";
import { search } from "../src/retrieval";

const id = (n: number) =>
  `00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`;

test("search ranks and bounds associated candidates before loading evidence", async () => {
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
  const tracked = (tx: any) => ({
    query: async (sql: string, values: unknown[] = []) => {
      const result = await tx.query(sql, values);
      reads.push({ sql, values, count: result.rows.length });
      return result;
    },
  });
  const runtime = {
    db: {
      query: db.query.bind(db),
      transaction: (fn: any, options: any) =>
        db.transaction((tx) => fn(tracked(tx)), options),
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
    await db.query(
      "INSERT INTO memoia.memory_sources(user_id,project_id,source_id) VALUES($1,$2,'s')",
      [userId, projectId],
    );
    await db.query(
      "INSERT INTO memoia.memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at) VALUES($1,$2,'s','m',repeat('a',64),'user',now())",
      [userId, projectId],
    );
    await db.query(
      "INSERT INTO memoia.memory_blobs(id,user_id,project_id,source_id,message_ids,status) VALUES($3,$1,$2,'s','[\"m\"]','active')",
      [userId, projectId, blob],
    );
    await db.query(
      "INSERT INTO memoia.memory_facts(id,user_id,project_id,blob_id,content,support_groups,occurred_at) SELECT x,$1,$2,$3,'hiking','[[\"m\"]]',now() FROM unnest($4::uuid[]) x",
      [userId, projectId, blob, [strong, weak]],
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
    assert.equal(result.events.length, 10);
    assert.equal(result.profiles.length, 10);
    assert.equal(result.events[0].id, late);
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
    assert.deepEqual(events.values.slice(0, 2), [userId, projectId]);
    assert.deepEqual(profiles.values.slice(0, 2), [userId, projectId]);
    const edges = reads.find((x) =>
      x.sql.startsWith("SELECT event_id,fact_id"),
    )!;
    assert.equal((edges.values[2] as string[]).length, 50);
  } finally {
    await db.query("DELETE FROM memoia.projects WHERE project_id=$1", [
      projectId,
    ]);
    await db.close();
  }
});
