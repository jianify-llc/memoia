import { test } from "node:test";
import assert from "node:assert/strict";
import { Database } from "../src/db";
import { MaintenanceContext } from "../src/maintenance";
import { runMaintenance } from "../src/maintenance-agent";

test("maintenance counts top-level numeric usage from actual SDK error responses", async () => {
  const db = new Database("postgresql://unused:unused@127.0.0.1:1/unused");
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    return { rows: [], rowCount: 1 };
  };
  db.transaction = async (fn: any) => fn({ query });
  const runtime = {
    db,
    env: { OPENAI_API_KEY: "local-only" },
    deadline: Date.now() + 60000,
  };
  const claim = {
    userId: crypto.randomUUID(),
    projectId: "p",
    id: crypto.randomUUID(),
    owner: crypto.randomUUID(),
    generation: "1",
    attempts: 1,
    blobIds: [],
    changes: [],
  };
  const context = new MaintenanceContext(runtime, claim, async () => {});
  context.config = {
    llm_model: "gpt-6-luna",
    reasoning_effort: "high",
    language: "en",
    embedding_provider: "openai",
    embedding_model: "text-embedding-3-small",
    embedding_dim: 1536,
    embedding_batch_size: 64,
    embedding_max_token_size: 8192,
    enable_event_embedding: false,
    profile_topics: [],
    event_tag_definitions: [],
    source_max_input_tokens: 16384,
    source_context_window_tokens: 131072,
    source_output_reserve_tokens: 32768,
  };
  context.readChanges = async () => ({
    items: [],
    next_cursor: null,
    remaining_review: context.remaining(),
  });
  const oldFetch = globalThis.fetch,
    oldInfo = console.info;
  const logs: string[] = [];
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return Response.json(
      {
        error: { message: "sensitive-response", code: "upstream_error" },
        usage: { input_tokens: 17, output_tokens: 3, total_tokens: 20 },
      },
      { status: 503 },
    );
  };
  console.info = (value?: unknown) => {
    logs.push(String(value));
  };
  try {
    await assert.rejects(
      runMaintenance(context),
      (error: any) => error.code === "model_unavailable",
    );
    assert.equal(requests, 4);
    const counters = calls
      .filter((c) => c.sql.includes("INSERT INTO memoia.usage_counters"))
      .map((c) => [c.values[1], c.values[2]]);
    assert.deepEqual(
      counters,
      Array.from({ length: requests }, () => [
        ["llm_input_tokens", 17],
        ["llm_output_tokens", 3],
      ]).flat(),
    );
    assert.equal(
      calls.filter((c) => c.sql.includes("UPDATE memoia.billings")).length,
      requests,
    );
    const recorded = logs
      .map((s) => JSON.parse(s))
      .filter((v) => v.event === "model_usage");
    assert.equal(recorded.length, requests);
    assert.ok(recorded.every((v) => v.total_tokens === 20));
    assert.equal(logs.join("").includes("sensitive-response"), false);
  } finally {
    globalThis.fetch = oldFetch;
    console.info = oldInfo;
    await db.close();
  }
});

test("malformed maintenance usage stops before tools, fallback or commit", async () => {
  const oldFetch = globalThis.fetch;
  try {
    for (const status of [200, 503])
      for (const usage of [
        { input_tokens: 10, output_tokens: 5, total_tokens: 1 },
        { input_tokens: -1, output_tokens: 5, total_tokens: 4 },
        { input_tokens: "10", output_tokens: 5, total_tokens: 15 },
        { output_tokens: 32769 },
      ]) {
        const db = new Database(
          "postgresql://unused:unused@127.0.0.1:1/unused",
        );
        let sqlCalls = 0,
          requests = 0;
        db.transaction = async (fn: any) =>
          fn({
            query: async () => {
              sqlCalls++;
              return { rows: [], rowCount: 1 };
            },
          });
        const context = new MaintenanceContext(
          {
            db,
            env: { OPENAI_API_KEY: "local-only" },
            deadline: Date.now() + 60000,
          },
          {
            userId: crypto.randomUUID(),
            projectId: "p",
            id: crypto.randomUUID(),
            owner: crypto.randomUUID(),
            blobIds: [],
            changes: [],
          },
          async () => {},
        );
        context.config = {
          llm_model: "gpt-6-luna",
          reasoning_effort: "high",
          language: "en",
          embedding_provider: "openai",
          embedding_model: "text-embedding-3-small",
          embedding_dim: 1536,
          embedding_batch_size: 64,
          embedding_max_token_size: 8192,
          enable_event_embedding: false,
          profile_topics: [],
          event_tag_definitions: [],
          source_max_input_tokens: 16384,
          source_context_window_tokens: 131072,
          source_output_reserve_tokens: 32768,
        };
        context.readChanges = async () => ({
          items: [],
          next_cursor: null,
          remaining_review: context.remaining(),
        });
        globalThis.fetch = async () => {
          requests++;
          return Response.json(
            status === 200
              ? {
                  id: "resp_local",
                  object: "response",
                  status: "completed",
                  model: "gpt-6-luna",
                  output: [],
                  usage,
                }
              : { error: { code: "server_error" }, usage },
            { status },
          );
        };
        try {
          await assert.rejects(
            runMaintenance(context),
            (error: any) =>
              error.code ===
              (usage.output_tokens > 32768
                ? "maintenance_completion_length"
                : "maintenance_usage_invalid"),
          );
          assert.equal(
            requests,
            1,
            "malformed usage cannot trigger standard fallback or SDK retry",
          );
          assert.equal(
            sqlCalls,
            usage.output_tokens > 32768 ? 1 : 0,
            "invalid usage must not debit or proceed to tools",
          );
        } finally {
          await db.close();
        }
      }
  } finally {
    globalThis.fetch = oldFetch;
  }
});
