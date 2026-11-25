import test from "node:test";
import assert from "node:assert/strict";
import {
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
        : sql.startsWith("SELECT 1 FROM memoia.users")
          ? [{ exists: 1 }]
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
    env: { OPENAI_API_KEY: "local-only" },
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
    .flatMap((c) =>
      (c.values[1] as string[]).map((name, index) => [
        name,
        (c.values[2] as number[])[index],
      ]),
    );
}

test("numeric SDK error usage is recorded and billed without provider text", async () => {
  const { runtime, calls } = fixture();
  const oldInfo = console.info;
  const logs: string[] = [];
  console.info = (value?: unknown) => {
    logs.push(String(value));
  };
  try {
    const client = provider(runtime, failingFetch);
    let rejection: unknown;
    try {
      await client.responses.create({ model: "test", input: "query" });
    } catch (error) {
      rejection = error;
    }
    assert.ok(rejection);
    await recordUsage(runtime, "p", errorUsage(rejection), "fact_extraction");
    assert.deepEqual(counters(calls), [
      ["llm_input_tokens", 17],
      ["llm_output_tokens", 3],
    ]);
    assert.deepEqual(
      calls.find((call) => call.sql.includes("UPDATE memoia.billings"))?.values,
      ["p", 20],
    );
    const usage = JSON.parse(logs[0]);
    assert.equal(usage.total_tokens, 20);
    assert.equal(usage.cache_write_30m_tokens, 2);
    assert.equal(usage.cache_write_12h_tokens, 3);
    assert.equal(logs.join("").includes("private-provider-text"), false);
    assert.equal(logs.join("").includes("never-log"), false);
  } finally {
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
      let billingCalls = 0,
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
        throw new Error("Unexpected request outside external billing");
      };
      await recordUsage(runtime, "p", body.usage, "fact_extraction");
      assert.equal(authCorrect, true);
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

test("document embedding meters a failed physical response before retrying", async () => {
  const { runtime, calls } = fixture();
  let requests = 0;
  runtime.modelFetch = async () =>
    ++requests === 1
      ? Response.json(
          { error: { code: "temporary" }, usage: { prompt_tokens: 7 } },
          { status: 503, headers: { "retry-after-ms": "1" } },
        )
      : Response.json({
          data: [{ index: 0, embedding: Array(1536).fill(0.1) }],
          model: "text-embedding-3-large",
          usage: { prompt_tokens: 9 },
        });
  await embeddings(runtime, "p", ["document"], "document", crypto.randomUUID());
  assert.equal(requests, 2);
  const events = calls.filter((c) =>
    c.sql.includes("INSERT INTO memoia.usage_events"),
  );
  assert.deepEqual(
    events.map((c) => JSON.parse(String(c.values[3])).input_tokens),
    [7, 9],
  );
  assert.notEqual(events[0].values[4], events[1].values[4]);
});

test("query embeddings return while known usage waits for the database", async () => {
  const { runtime } = fixture();
  runtime.retrievalUsageWrites = [];
  runtime.modelFetch = async () =>
    Response.json({
      data: [{ index: 0, embedding: Array(1536).fill(0.1) }],
      model: "text-embedding-3-small",
      usage: { prompt_tokens: 7 },
    });
  const statement = runtime.db.query.bind(runtime.db);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime.db.query = async (...args) => {
    if (args[0].includes("INSERT INTO memoia.usage_events")) await pending;
    return statement(...args);
  };
  try {
    const output = embeddings(
      runtime,
      "p",
      ["query"],
      "query",
      crypto.randomUUID(),
    );
    assert.equal(runtime.retrievalUsageWrites.length, 1);
    assert.deepEqual(await output, [Array(1536).fill(0.1)]);
  } finally {
    release();
    await Promise.all(runtime.retrievalUsageWrites);
  }
});
