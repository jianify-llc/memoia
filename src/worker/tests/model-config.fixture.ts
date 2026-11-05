import { test } from "node:test";
import assert from "node:assert/strict";
import { createCloudflareRuntime } from "../src/cloudflare-runtime";
import { getConfig } from "../src/models";
import { MaintenanceContext } from "../src/maintenance";
import { runMaintenance } from "../src/maintenance-agent";

test("maintenance final SDK request carries configured header, query and normalized topic", async () => {
  let relayFetch: (request: Request) => Promise<Response>;
  const runtime = createCloudflareRuntime({
    DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
    OPENAI_API_KEY: "local-test",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENAI_TRANSPORT: "vpc",
    OPENAI_RELAY: {
      fetch: async (request) => relayFetch(new Request(request)),
    },
    MEMOIA_CONFIG: JSON.stringify({
      llm_openai_default_header: { "X-Provider-Custom": "local-value" },
      llm_openai_default_query: { deployment: "test-deployment" },
    }),
  });
  const { db } = runtime;
  const project = {
    overwrite_user_profiles: [
      { topic: " Work Life ", sub_topics: [" Side Projects "] },
    ],
  };
  db.query = async () =>
    ({
      rows: [{ profile_config: JSON.stringify(project) }],
      rowCount: 1,
    }) as never;
  db.transaction = async () => undefined as never;
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
  context.config = await getConfig(runtime, "p");
  context.readChanges = async () => ({
    items: [],
    next_cursor: null,
    remaining_review: context.remaining(),
  });
  const prior = globalThis.fetch;
  let calls = 0,
    correctHeader = false,
    correctQuery = false,
    correctTopic = false;
  globalThis.fetch = async () => {
    throw new Error("Unexpected public fetch");
  };
  relayFetch = async (request) => {
    calls++;
    assert.equal(new URL(request.url).origin, "http://openai-relay.internal");
    correctHeader = request.headers.get("x-provider-custom") === "local-value";
    correctQuery =
      new URL(request.url).searchParams.get("deployment") === "test-deployment";
    const body = (await request.json()) as { input: unknown };
    const serialized = JSON.stringify(body.input);
    correctTopic =
      serialized.includes("work_life") && serialized.includes("side_projects");
    return Response.json({
      id: "resp_local",
      object: "response",
      created_at: 1,
      status: "completed",
      error: null,
      incomplete_details: null,
      model: "gpt-6-luna",
      output: [
        {
          type: "message",
          id: "msg_local",
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
    assert.ok(runtime.modelFetch);
    await assert.rejects(
      runtime.modelFetch("https://api.openai.com/v1/embeddings/extra", {
        method: "POST",
      }),
      /OpenAI relay request is not allowed/,
    );
    assert.throws(
      () =>
        createCloudflareRuntime({
          OPENAI_API_KEY: "local-test",
          OPENAI_TRANSPORT: "vpc",
        }),
      /OpenAI relay binding is invalid/,
    );
    assert.throws(
      () =>
        createCloudflareRuntime({
          OPENAI_API_KEY: "local-test",
          OPENAI_BASE_URL: "https://other.example/v1",
          OPENAI_TRANSPORT: "vpc",
          OPENAI_RELAY: { fetch: globalThis.fetch },
        }),
      /OpenAI relay requires the OpenAI API base URL/,
    );
    await runMaintenance(context);
    assert.equal(calls, 1);
    assert.equal(correctHeader, true);
    assert.equal(correctQuery, true);
    assert.equal(correctTopic, true);
    const stage = await context.stage("profiles", [
      {
        action: "upsert",
        content: "A profile",
        topic: "work_life",
        sub_topic: "side_projects",
        fact_ids: [crypto.randomUUID()],
      },
    ]);
    assert.equal(stage.staged, false);
    assert.equal(stage.error?.code, "maintenance_support_unread");
  } finally {
    globalThis.fetch = prior;
    await db.close();
  }
});
