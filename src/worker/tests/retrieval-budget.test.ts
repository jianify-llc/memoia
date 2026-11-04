import { test } from "node:test";
import assert from "node:assert/strict";
import { queryEvents, queryFacts, queryProfiles } from "../src/retrieval";
import { countTokens } from "../src/models";
import type { Runtime } from "../src/runtime";

const scope = { userId: "user", projectId: "project" };
const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const ids = Array.from({ length: 50 }, (_, i) => id(i + 1));
const factId = id(100);
const date = "2026-01-01T00:00:00Z";
const fact = {
  id: factId,
  blob_id: id(101),
  source_id: "source",
  content: "proof",
  support_groups: [["m1"]],
  revision: 1,
  fact_time: { start: date, end: date },
  created_at: date,
  updated_at: date,
  occurred_at: date,
};

test("event pages skip filtered and oversized entries, preserve evidence, and stop at limit", async () => {
  const loaded: string[][] = [];
  const query = async (sql: string, values: any[] = []) => {
    assert.deepEqual(values.slice(0, 2), [scope.userId, scope.projectId]);
    if (sql.startsWith("SELECT e.id"))
      return { rows: ids.map((id) => ({ id })) };
    if (sql.startsWith("SELECT e.*")) {
      const page = values.at(-1) as string[];
      loaded.push(page);
      return {
        rows: page
          .map((id) => ({
            id,
            event_data: { title: id === ids[20] ? "x".repeat(5000) : "small" },
            created_at: date,
            updated_at: date,
          }))
          .reverse(),
      };
    }
    if (sql.startsWith("SELECT event_id,fact_id"))
      return {
        rows: (values[2] as string[])
          .filter((id) => ids.indexOf(id) >= 20)
          .map((event_id) => ({ event_id, fact_id: factId })),
      };
    if (sql.startsWith("SELECT DISTINCT x.value")) return { rows: [] };
    if (sql.startsWith("SELECT f.*,b.source_id")) return { rows: [fact] };
    if (sql.includes("FROM memoia.memory_messages"))
      return {
        rows: [{ message_id: "m1", occurred_at: date, time_zone: null }],
      };
    throw new Error(sql);
  };
  const runtime = {
    db: { query, transaction: async (fn: any) => fn({ query }) },
  } as unknown as Runtime;
  const result = await queryEvents(runtime, scope, {
    fact_ids: [factId],
    limit: 1,
    max_token_size: 600,
  });
  assert.deepEqual(
    result.events.map((e) => e.id),
    [ids[21]],
  );
  assert.equal(result.events[0].event_data.title, "small");
  assert.equal(
    result.events[0].event_data.evidence[0].source_messages[0].message_id,
    "m1",
  );
  assert.deepEqual(
    loaded.map((page) => page.length),
    [20, 20],
  );
  assert.ok(countTokens(JSON.stringify(result)) <= 600);
});

test("fact and profile queries hydrate only the first ranked page when limit is met", async () => {
  for (const kind of ["facts", "profiles"] as const) {
    const loaded: string[][] = [];
    const query = async (sql: string, values: any[] = []) => {
      assert.deepEqual(values.slice(0, 2), [scope.userId, scope.projectId]);
      if (sql.startsWith(`SELECT ${kind === "facts" ? "f" : "p"}.id`))
        return { rows: ids.map((id) => ({ id })) };
      if (sql.startsWith(`SELECT ${kind === "facts" ? "f" : "p"}.*`)) {
        const page = values.at(-1) as string[];
        loaded.push(page);
        return {
          rows: page
            .map((id) =>
              kind === "facts"
                ? { ...fact, id }
                : {
                    id,
                    content: "profile",
                    attributes: { fact_ids: [factId] },
                    created_at: date,
                    updated_at: date,
                  },
            )
            .reverse(),
        };
      }
      if (sql.startsWith("SELECT DISTINCT x.value"))
        return { rows: [{ id: factId }] };
      if (kind === "profiles" && sql.startsWith("SELECT f.*,b.source_id"))
        return { rows: [fact] };
      if (sql.includes("FROM memoia.memory_messages"))
        return {
          rows: [{ message_id: "m1", occurred_at: date, time_zone: null }],
        };
      throw new Error(sql);
    };
    const runtime = {
      db: { query, transaction: async (fn: any) => fn({ query }) },
    } as unknown as Runtime;
    const result =
      kind === "facts"
        ? await queryFacts(runtime, scope, { limit: 1, max_token_size: 600 })
        : await queryProfiles(runtime, scope, {
            limit: 1,
            max_token_size: 600,
          });
    const entries = result[kind];
    assert.equal(entries[0].id, ids[0]);
    if (kind === "facts")
      assert.equal(entries[0].evidence.source_messages[0].message_id, "m1");
    else assert.deepEqual(entries[0].fact_ids, []);
    assert.deepEqual(
      loaded.map((page) => page.length),
      [20],
    );
  }
});
