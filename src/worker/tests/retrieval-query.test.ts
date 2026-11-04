import { test } from "node:test";
import assert from "node:assert/strict";
import { queryFacts } from "../src/retrieval";
import type { Runtime } from "../src/runtime";

const userId = "00000000-0000-0000-0000-000000000001";
const factId = "00000000-0000-0000-0000-000000000002";
const blobId = "00000000-0000-0000-0000-000000000003";
test("fact query scopes both ranking and evidence to one project and honors exclusion before ranking", async () => {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.startsWith("SET TRANSACTION")) return { rows: [] };
    if (sql.startsWith("SELECT f.id")) return { rows: [{ id: factId }] };
    if (sql.startsWith("SELECT f.*"))
      return {
        rows: [
          {
            id: factId,
            blob_id: blobId,
            source_id: "source",
            content: "fact",
            support_groups: [["m1"]],
            topic: null,
            sub_topic: null,
            subject: "user",
            reporter: "user",
            certainty: "asserted",
            revision: "1",
            fact_time: null,
            occurred_at: "2026-01-01T00:00:00Z",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      };
    if (sql.includes("FROM memoia.memory_messages"))
      return {
        rows: [
          {
            message_id: "m1",
            occurred_at: "2026-01-01T00:00:00Z",
            time_zone: null,
          },
        ],
      };
    throw new Error(sql);
  };
  const runtime = {
    db: { query, transaction: async (fn: any) => fn({ query }) },
  } as unknown as Runtime;
  const result = await queryFacts(
    runtime,
    { userId, projectId: "alpha" },
    { exclude_ids: ["00000000-0000-0000-0000-000000000004"], limit: 10 },
  );
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].evidence.source_messages[0].message_id, "m1");
  const rank = calls.find((c) => c.sql.startsWith("SELECT f.id"))!;
  assert.match(rank.sql, /NOT \(f\.id=ANY/);
  assert.deepEqual(rank.values.slice(0, 2), [userId, "alpha"]);
  const evidence = calls.find((c) =>
    c.sql.includes("FROM memoia.memory_messages"),
  )!;
  assert.deepEqual(evidence.values.slice(0, 3), [userId, "alpha", "source"]);
  assert.match(evidence.sql, /AND NOT deleted/);
});

test("search without events never reads legacy stories or event associations", async () => {
  const { search } = await import("../src/retrieval");
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.startsWith("SET TRANSACTION")) return { rows: [] };
    if (sql.startsWith("SELECT profile_config"))
      return { rows: [{ profile_config: null }] };
    if (sql.startsWith("SELECT f.id")) return { rows: [{ id: factId }] };
    if (sql.startsWith("SELECT f.*,b.source_id"))
      return {
        rows: [
          {
            id: factId,
            blob_id: blobId,
            source_id: "source",
            content: "fact",
            support_groups: [["m1"]],
            topic: null,
            sub_topic: null,
            subject: "user",
            reporter: "user",
            certainty: "asserted",
            revision: "1",
            fact_time: null,
            occurred_at: "2026-01-01T00:00:00Z",
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      };
    if (sql.includes("FROM memoia.memory_messages"))
      return {
        rows: [
          {
            message_id: "m1",
            occurred_at: "2026-01-01T00:00:00Z",
            time_zone: null,
          },
        ],
      };
    if (sql.includes("FROM memoia.user_profiles p")) return { rows: [] };
    throw new Error(sql);
  };
  const runtime = {
    env: { MEMOIA_CONFIG: '{"enable_event_embedding":false}' },
    db: { query, transaction: async (fn: any) => fn({ query }) },
  } as unknown as Runtime;
  const result = await search(
    runtime,
    { userId, projectId: "alpha" },
    { query: "fact", include_events: false },
  );
  assert.equal(result.facts.length, 1);
  assert.deepEqual(result.events, []);
  assert.equal(
    calls.some((c) => c.sql.includes("memoia.user_events")),
    false,
  );
  assert.equal(
    calls.some((c) => c.sql.includes("memoia.memory_event_facts")),
    false,
  );
});

test("pending fact changes are not presented as current profile proof", async () => {
  const { queryProfiles } = await import("../src/retrieval");
  const profileId = "00000000-0000-0000-0000-000000000005";
  const query = async (sql: string) => {
    if (sql.startsWith("SET TRANSACTION")) return { rows: [] };
    if (sql.startsWith("SELECT p.id")) return { rows: [{ id: profileId }] };
    if (sql.startsWith("SELECT p.*"))
      return {
        rows: [
          {
            id: profileId,
            content: "old profile",
            attributes: { topic: "t", sub_topic: "s", fact_ids: [factId] },
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ],
      };
    if (sql.startsWith("SELECT DISTINCT x.value"))
      return { rows: [{ id: factId }] };
    if (sql.startsWith("SELECT f.*,b.source_id"))
      return { rows: [{ id: factId, source_id: "source" }] };
    throw new Error(sql);
  };
  const runtime = {
    db: { query, transaction: async (fn: any) => fn({ query }) },
  } as unknown as Runtime;
  const result = await queryProfiles(
    runtime,
    { userId, projectId: "alpha" },
    {},
  );
  assert.equal(result.profiles[0].content, "old profile");
  assert.deepEqual(result.profiles[0].fact_ids, []);
  assert.deepEqual(result.profiles[0].source_ids, []);
});
