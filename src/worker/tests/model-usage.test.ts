import test from "node:test";
import assert from "node:assert/strict";
import {
  completion,
  provider,
  errorUsage,
  recordUsage,
  embeddings,
} from "../src/models";
import type { Runtime } from "../src/runtime";

function fixture() {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    return {
      rows: sql.startsWith("SELECT profile_config")
        ? [{ profile_config: "" }]
        : [],
      rowCount: 1,
    };
  };
  const db = {
    query,
    transaction: async (
      fn: (tx: { query: typeof query }) => Promise<unknown>,
    ) => fn({ query }),
  };
  const runtime: Runtime = {
    db: db as unknown as Runtime["db"],
    env: { OPENAI_API_KEY: "local-only", MEMOIA_CONFIG: '{"embedding_dim":2}' },
    deadline: Date.now() + 30000,
  };
  return { runtime, calls };
}
const body = {
  error: { message: "private-provider-text", code: "upstream_error" },
  usage: {
    input_tokens: 17,
    output_tokens: 3,
    total_tokens: 20,
    input_tokens_details: {
      cached_tokens: 4,
      cache_write_tokens: 5,
      cache_write_tokens_details: {
        ttl_30m_tokens: 2,
        ttl_12h_tokens: 3,
        secret: "never-log",
      },
    },
  },
};
const failingFetch: typeof fetch = async () =>
  Response.json(body, { status: 503 });
function counters(calls: Array<{ sql: string; values: unknown[] }>) {
  return calls
    .filter((c) => c.sql.includes("INSERT INTO memoia.usage_counters"))
    .map((c) => [c.values[1], c.values[2]]);
}

test("real SDK 503 preserves top-level numeric usage for Fact completion and billing", async () => {
  const { runtime, calls } = fixture();
  const oldFetch = globalThis.fetch,
    oldInfo = console.info;
  const logs: string[] = [];
  globalThis.fetch = failingFetch;
  console.info = (value?: unknown) => {
    logs.push(String(value));
  };
  try {
    await assert.rejects(
      completion(runtime, {
        projectId: "p",
        prompt: "input",
        system: "instruction",
        schema: { type: "object" },
      }),
      (e: any) =>
        e.code === "model_unavailable" &&
        e.retryable &&
        !e.message.includes("private"),
    );
    assert.deepEqual(counters(calls), [
      ["llm_input_tokens", 17],
      ["llm_output_tokens", 3],
    ]);
    const debit = calls.find((c) => c.sql.includes("UPDATE memoia.billings"));
    assert.deepEqual(debit?.values, ["p", 20]);
    const usage = JSON.parse(logs[0]);
    assert.equal(usage.input_tokens, 17);
    assert.equal(usage.output_tokens, 3);
    assert.equal(usage.total_tokens, 20);
    assert.equal(usage.cache_write_30m_tokens, 2);
    assert.equal(usage.cache_write_12h_tokens, 3);
    assert.equal(logs.join("").includes("private-provider-text"), false);
    assert.equal(logs.join("").includes("never-log"), false);
  } finally {
    globalThis.fetch = oldFetch;
    console.info = oldInfo;
  }
});
test("shared maintenance SDK client and OpenAI embedding expose only numeric error usage", async () => {
  const { runtime } = fixture();
  let apiError: unknown;
  try {
    await provider(runtime, failingFetch).responses.create({
      model: "test",
      input: "query",
    });
  } catch (error) {
    apiError = error;
  }
  assert.ok(apiError);
  const usage = errorUsage(apiError) as Record<string, unknown>;
  assert.equal(usage.input_tokens, 17);
  assert.equal(usage.output_tokens, 3);
  assert.equal(usage.total_tokens, 20);
  assert.equal(JSON.stringify(usage).includes("private-provider-text"), false);
  assert.equal(JSON.stringify(usage).includes("never-log"), false);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = failingFetch;
  try {
    let embeddingError: unknown;
    try {
      await embeddings(runtime, "p", ["query"], "query");
    } catch (error) {
      embeddingError = error;
    }
    assert.equal(
      (errorUsage(embeddingError) as Record<string, unknown>).total_tokens,
      20,
    );
  } finally {
    globalThis.fetch = oldFetch;
  }
});
test("incomplete, inconsistent and invalid counts never become known or billed", async () => {
  for (const usage of [
    { input_tokens: 17, output_tokens: 3 },
    { input_tokens: 17, output_tokens: 3, total_tokens: 21 },
    { input_tokens: -1, output_tokens: 3, total_tokens: 2 },
    { input_tokens: 17, output_tokens: 3, total_tokens: "20" },
  ]) {
    const { runtime, calls } = fixture();
    await recordUsage(runtime, "p", usage, "test");
    assert.deepEqual(counters(calls), [["llm_usage_unknown", 1]]);
    assert.equal(
      calls.some((c) => c.sql.includes("UPDATE memoia.billings")),
      false,
    );
  }
});

test("external billing uses ADMIN_TOKEN and never replays model or counters on rejection", async () => {
  const oldFetch = globalThis.fetch,
    oldWarn = console.warn,
    oldInfo = console.info;
  try {
    for (const mode of [
      "ok",
      "business-error",
      "http-error",
      "wrong-status",
      "invalid-json",
    ] as const) {
      const { runtime, calls } = fixture();
      runtime.env.ADMIN_URL = "https://billing.invalid";
      runtime.env.ADMIN_TOKEN = "synthetic-local-token";
      let modelCalls = 0,
        billingCalls = 0,
        authCorrect = false;
      const warnings: string[] = [];
      console.warn = (value?: unknown) => {
        warnings.push(String(value));
      };
      console.info = () => {};
      globalThis.fetch = async (input, init) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (new URL(req.url).host === "billing.invalid") {
          billingCalls++;
          authCorrect =
            req.headers.get("authorization") === "Bearer synthetic-local-token";
          assert.equal(req.method, "PUT");
          assert.deepEqual(await req.json(), { usage: 20 });
          if (mode === "business-error")
            return Response.json({
              errno: 17,
              message: "private admin response",
            });
          if (mode === "http-error")
            return Response.json({ errno: 0 }, { status: 503 });
          if (mode === "wrong-status")
            return Response.json({ errno: 0 }, { status: 201 });
          if (mode === "invalid-json")
            return new Response("private admin response", { status: 200 });
          return Response.json({ errno: 0, data: null });
        }
        modelCalls++;
        return Response.json({
          status: "completed",
          model: "fake",
          output: [
            {
              type: "message",
              status: "completed",
              content: [{ type: "output_text", text: '{"facts":[]}' }],
            },
          ],
          usage: { input_tokens: 17, output_tokens: 3, total_tokens: 20 },
        });
      };
      assert.deepEqual(
        await completion(runtime, {
          projectId: "p",
          prompt: "input",
          system: "instruction",
          schema: { type: "object" },
        }),
        { facts: [] },
      );
      assert.equal(authCorrect, true);
      assert.equal(modelCalls, 1);
      assert.equal(billingCalls, 1);
      assert.deepEqual(counters(calls), [
        ["llm_input_tokens", 17],
        ["llm_output_tokens", 3],
      ]);
      assert.equal(
        calls.some((c) => c.sql.includes("UPDATE memoia.billings")),
        false,
      );
      assert.equal(warnings.length, mode === "ok" ? 0 : 1);
      assert.equal(warnings.join("").includes("synthetic-local-token"), false);
      assert.equal(warnings.join("").includes("private admin response"), false);
    }
  } finally {
    globalThis.fetch = oldFetch;
    console.warn = oldWarn;
    console.info = oldInfo;
  }
});
