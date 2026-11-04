import test from "node:test";
import assert from "node:assert/strict";
import { embeddings, recordUsage } from "../src/models";
import type { Runtime } from "../src/runtime";

function runtime(
  config: Record<string, unknown>,
  bindings: Record<string, string> = {},
): Runtime {
  const db = {
    query: async () => ({ rows: [{ profile_config: "" }] }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ query: async () => ({ rows: [] }) }),
  };
  return {
    db: db as unknown as Runtime["db"],
    env: {
      OPENAI_API_KEY: "llm-key",
      OPENAI_BASE_URL: "https://llm.invalid/v1",
      MEMOIA_CONFIG: JSON.stringify(config),
      ...bindings,
    },
    deadline: Date.now() + 30_000,
  };
}
function requestInfo(input: RequestInfo | URL, init?: RequestInit) {
  const request = input instanceof Request ? input : new Request(input, init);
  return request;
}
test("Jina uses independent key and base, bounded batches and task by phase", async () => {
  const prior = globalThis.fetch;
  const requests: Array<{ url: string; auth: string | null; body: any }> = [];
  globalThis.fetch = async (input, init) => {
    const req = requestInfo(input, init);
    const body = (await req.json()) as any;
    requests.push({
      url: req.url,
      auth: req.headers.get("authorization"),
      body,
    });
    return Response.json({
      data: body.input.map((_: string, index: number) => ({
        index,
        embedding: [index, 1],
      })),
    });
  };
  try {
    const rt = runtime(
      {
        embedding_provider: "jina",
        embedding_model: "jina-embeddings-v3",
        embedding_dim: 2,
      },
      {
        EMBEDDING_API_KEY: "jina-key",
        EMBEDDING_BASE_URL: "https://jina.invalid/v1",
      },
    );
    assert.equal(
      (await embeddings(rt, "p", Array(65).fill("hello"))).length,
      65,
    );
    await embeddings(rt, "p", ["search"], "query");
    assert.deepEqual(
      requests.map((r) => r.body.input.length),
      [64, 1, 1],
    );
    assert.deepEqual(
      requests.map((r) => r.body.task),
      ["retrieval.passage", "retrieval.passage", "retrieval.query"],
    );
    assert.equal(requests[0].url, "https://jina.invalid/v1/embeddings");
    assert.equal(requests[0].auth, "Bearer jina-key");
    assert.equal(requests[0].body.truncate, true);
    assert.equal(requests[0].body.dimensions, 2);
  } finally {
    globalThis.fetch = prior;
  }
});
test("Ollama uses the native API without inventing indexed results or task", async () => {
  const prior = globalThis.fetch;
  let captured: { url: string; auth: string | null; body: any } | undefined;
  globalThis.fetch = async (input, init) => {
    const req = requestInfo(input, init);
    const body = (await req.json()) as any;
    captured = { url: req.url, auth: req.headers.get("authorization"), body };
    return Response.json({
      embeddings: [
        [1, 2],
        [3, 4],
      ],
    });
  };
  try {
    const rt = runtime(
      {
        embedding_provider: "ollama",
        embedding_model: "embed",
        embedding_dim: 2,
      },
      {
        EMBEDDING_API_KEY: "ollama-key",
        EMBEDDING_BASE_URL: "https://ollama.invalid",
      },
    );
    assert.deepEqual(await embeddings(rt, "p", ["a", "b"], "query"), [
      [1, 2],
      [3, 4],
    ]);
    assert.equal(captured?.url, "https://ollama.invalid/api/embed");
    assert.equal(captured?.auth, "Bearer ollama-key");
    assert.equal(captured?.body.task, undefined);
    assert.equal(captured?.body.truncate, true);
    assert.equal(captured?.body.dimensions, 2);
  } finally {
    globalThis.fetch = prior;
  }
});
test("OpenAI query uses embedding-specific settings, no retries, and restores index order", async () => {
  const prior = globalThis.fetch;
  let calls = 0;
  let auth = "";
  let url = "";
  let model: unknown;
  let dimensions: unknown;
  let fail = false;
  globalThis.fetch = async (input, init) => {
    const req = requestInfo(input, init);
    calls++;
    auth = req.headers.get("authorization") ?? "";
    url = req.url;
    const body = (await req.json()) as Record<string, unknown>;
    model = body.model;
    dimensions = body.dimensions;
    return fail
      ? Response.json({ error: { message: "private" } }, { status: 503 })
      : Response.json({
          data: [
            { index: 1, embedding: [3, 4] },
            { index: 0, embedding: [1, 2] },
          ],
        });
  };
  try {
    const rt = runtime(
      { embedding_dim: 2 },
      {
        EMBEDDING_API_KEY: "embedding-key",
        EMBEDDING_BASE_URL: "https://embedding.invalid/v1",
      },
    );
    assert.deepEqual(await embeddings(rt, "p", ["a", "b"], "query"), [
      [1, 2],
      [3, 4],
    ]);
    assert.equal(auth, "Bearer embedding-key");
    assert.equal(url, "https://embedding.invalid/v1/embeddings");
    assert.equal(model, "text-embedding-3-large");
    assert.equal(dimensions, 2);
    fail = true;
    await assert.rejects(
      embeddings(rt, "p", ["a"], "query"),
      (e: any) => e.code === "embedding_unavailable" && e.retryable,
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = prior;
  }
});
test("complete input budget and malformed embeddings fail before acceptance", async () => {
  const prior = globalThis.fetch;
  let calls = 0;
  let data: unknown = [];
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ data });
  };
  try {
    const rt = runtime(
      {
        embedding_provider: "jina",
        embedding_model: "jina-embeddings-v3",
        embedding_dim: 2,
        embedding_max_token_size: 1,
      },
      { EMBEDDING_API_KEY: "key" },
    );
    await assert.rejects(
      embeddings(rt, "p", ["this text is too long"], "query"),
      (e: any) => e.code === "embedding_input_too_long",
    );
    assert.equal(calls, 0);
    for (const rows of [
      [],
      [
        { index: 0, embedding: [1, 2] },
        { index: 0, embedding: [3, 4] },
      ],
      [
        { index: 0, embedding: [1] },
        { index: 1, embedding: [1, 2] },
      ],
      [
        { index: 0, embedding: [1, "bad"] },
        { index: 1, embedding: [1, 2] },
      ],
    ]) {
      data = rows;
      await assert.rejects(
        embeddings(rt, "p", ["a", "b"], "query"),
        (e: any) =>
          e.code === "embedding_configuration_rejected" && !e.retryable,
      );
    }
  } finally {
    globalThis.fetch = prior;
  }
});

test("usage logging contains only numeric cache counters and explicit tier metadata", async () => {
  const prior = console.info;
  const lines: string[] = [];
  console.info = (value?: unknown) => {
    lines.push(String(value));
  };
  try {
    const usage = {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
      input_tokens_details: {
        cached_tokens: 4,
        cache_write_tokens: 3,
        cache_write_tokens_details: {
          ttl_30m_tokens: 2,
          ttl_12h_tokens: 1,
          private: "never-log",
        },
      },
    };
    await recordUsage(runtime({}), "p", usage, "test", {
      model: "model-name",
      service_tier: "flex",
      requested_service_tier: "default",
    });
    const value = JSON.parse(lines[0]);
    assert.equal(value.cached_tokens, 4);
    assert.equal(value.cache_write_tokens, 3);
    assert.equal(value.cache_write_30m_tokens, 2);
    assert.equal(value.cache_write_12h_tokens, 1);
    assert.equal(value.model, "model-name");
    assert.equal(value.service_tier, "flex");
    assert.equal(value.requested_service_tier, "default");
    assert.equal(lines[0].includes("never-log"), false);
  } finally {
    console.info = prior;
  }
});

test("provider rejections keep configuration failures separate from temporary failures", async () => {
  const prior = globalThis.fetch;
  let status = 401,
    calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("private provider response", { status });
  };
  try {
    const rt = runtime(
      {
        embedding_provider: "jina",
        embedding_model: "jina-embeddings-v3",
        embedding_dim: 2,
      },
      { EMBEDDING_API_KEY: "key" },
    );
    await assert.rejects(
      embeddings(rt, "p", ["query"], "query"),
      (e: any) =>
        e.code === "embedding_configuration_rejected" &&
        !e.retryable &&
        !e.message.includes("private"),
    );
    status = 503;
    await assert.rejects(
      embeddings(rt, "p", ["query"], "query"),
      (e: any) =>
        e.code === "embedding_unavailable" &&
        e.retryable &&
        !e.message.includes("private"),
    );
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = prior;
  }
});
