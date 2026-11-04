import test from "node:test";
import assert from "node:assert/strict";
import { completion, getConfig } from "../src/models";
import type { Runtime } from "../src/runtime";
function runtime(
  base: Record<string, unknown> = {},
  project: Record<string, unknown> = {},
): Runtime {
  const query = async () => ({
    rows: [{ profile_config: JSON.stringify(project) }],
    rowCount: 1,
  });
  const db = {
    query,
    transaction: async (
      fn: (tx: { query: typeof query }) => Promise<unknown>,
    ) => fn({ query }),
  };
  return {
    db: db as unknown as Runtime["db"],
    env: {
      OPENAI_API_KEY: "local-test",
      OPENAI_BASE_URL: "https://model.invalid/v1",
      MEMOIA_CONFIG: JSON.stringify(base),
    },
    deadline: Date.now() + 60000,
  };
}
test("service and project topics use Python normalization and subtopic shape", async () => {
  const service = {
    overwrite_user_profiles: [
      {
        topic: "  Work Life  ",
        sub_topics: [
          "  Home Office ",
          {
            name: " Side Projects ",
            description: "personal work",
            update_description: "update rule",
          },
        ],
      },
    ],
  };
  const base = await getConfig(runtime(service), "p");
  assert.deepEqual(base.profile_topics, [
    {
      topic: "work_life",
      description: null,
      sub_topics: [
        { name: "home_office", description: null, update_description: null },
        {
          name: "side_projects",
          description: "personal work",
          update_description: "update rule",
        },
      ],
    },
  ]);
  const project = {
    overwrite_user_profiles: [],
    additional_user_profiles: [
      {
        topic: " New Category ",
        description: "project",
        sub_topics: [" Reading List "],
      },
    ],
  };
  const merged = await getConfig(runtime(service, project), "p");
  assert.deepEqual(merged.profile_topics, [
    ...base.profile_topics,
    {
      topic: "new_category",
      description: "project",
      sub_topics: [
        { name: "reading_list", description: null, update_description: null },
      ],
    },
  ]);
  const override = await getConfig(
    runtime(service, {
      overwrite_user_profiles: [
        { topic: " 用户  偏好 ", sub_topics: [" 家庭 生活 "] },
      ],
      additional_user_profiles: [{ topic: "ignored" }],
    }),
    "p",
  );
  assert.deepEqual(override.profile_topics, [
    {
      topic: "用户__偏好",
      description: null,
      sub_topics: [
        { name: "家庭_生活", description: null, update_description: null },
      ],
    },
  ]);
  assert.deepEqual(
    (await getConfig(runtime({ overwrite_user_profiles: [] }), "p"))
      .profile_topics,
    [],
  );
});
test("English and Chinese defaults follow project language and remain isolated", async () => {
  const en = await getConfig(
    runtime({ language: "zh" }, { language: "en" }),
    "p",
  );
  const zh = await getConfig(
    runtime({ language: "en" }, { language: "zh" }),
    "p",
  );
  assert.equal(en.profile_topics[0].topic, zh.profile_topics[0].topic);
  assert.match(en.profile_topics[0].description!, /user/i);
  assert.match(zh.profile_topics[0].description!, /用户/);
  assert.equal(
    (
      await getConfig(
        runtime({ language: "en" }, { language: "unsupported" }),
        "p",
      )
    ).language,
    "en",
  );
  const withAddon = await getConfig(
    runtime({ additional_user_profiles: [{ topic: " Service Addon " }] }),
    "p",
  );
  assert.equal(withAddon.profile_topics.at(-1)?.topic, "service_addon");
  assert.equal(
    (await getConfig(runtime(), "p")).profile_topics.some(
      (t) => t.topic === "service_addon",
    ),
    false,
  );
});
test("Fact final SDK HTTP applies configured default headers and query", async () => {
  const rt = runtime({
    llm_openai_default_header: { "X-Provider-Custom": "local-value" },
    llm_openai_default_query: { deployment: "test-deployment" },
  });
  const prior = globalThis.fetch;
  let calls = 0,
    correctHeader = false,
    correctQuery = false;
  globalThis.fetch = async (input, init) => {
    calls++;
    const request = input instanceof Request ? input : new Request(input, init);
    correctHeader = request.headers.get("x-provider-custom") === "local-value";
    correctQuery =
      new URL(request.url).searchParams.get("deployment") === "test-deployment";
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
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  };
  try {
    assert.deepEqual(
      await completion(rt, {
        projectId: "p",
        prompt: "private",
        system: "instruction",
        schema: { type: "object" },
      }),
      { facts: [] },
    );
    assert.equal(calls, 1);
    assert.equal(correctHeader, true);
    assert.equal(correctQuery, true);
  } finally {
    globalThis.fetch = prior;
  }
});
