import test from "node:test";
import assert from "node:assert/strict";
import { readServiceConfig } from "../src/config";
import { getConfig, provider, supportsPromptCache } from "../src/models";
import { createRuntime, type Runtime } from "../src/runtime";

test("service settings preserve nullable legacy values and configured model identity", async () => {
  const settings = {
    best_llm_model: "gpt-6-luna",
    llm_reasoning_effort: "high",
    llm_prompt_cache_options: null,
    llm_openai_default_header: null,
    llm_openai_default_query: null,
    use_timezone: null,
    overwrite_user_profiles: [],
    additional_user_profiles: null,
    event_tags: [{ name: "activity", description: null }],
    embedding_model: "text-embedding-3-large",
    embedding_dim: 1536,
    source_input_retention_seconds: 3600,
  };
  assert.deepEqual(readServiceConfig(JSON.stringify(settings)), settings);
  assert.equal(readServiceConfig().source_input_retention_seconds, 604800);
  const resolved = await getConfig(
    {
      env: { MEMOIA_CONFIG: JSON.stringify(settings) },
      db: { query: async () => ({ rows: [{ profile_config: null }] }) },
    } as unknown as Runtime,
    "p",
  );
  assert.equal(resolved.embedding_model, "text-embedding-3-large");
  assert.equal(resolved.embedding_dim, 1536);
  assert.deepEqual(resolved.profile_topics, []);
  assert.equal(resolved.use_timezone, "UTC");
});

test("service settings reject unsupported keys, wrong types and invalid budgets without values", () => {
  const privateValue = "private-header-and-prompt-content";
  const cases = [
    "{",
    "null",
    "[]",
    JSON.stringify({ llm_reasoning_effrot: privateValue }),
    JSON.stringify({ thinking_llm_model: privateValue }),
    JSON.stringify({ best_llm_model: 123 }),
    JSON.stringify({ llm_reasoning_effort: privateValue }),
    JSON.stringify({ llm_prompt_cache_options: "true" }),
    JSON.stringify({ source_input_retention_seconds: 0 }),
    JSON.stringify({ source_max_input_tokens: -1 }),
    JSON.stringify({ source_output_reserve_tokens: 0.5 }),
    JSON.stringify({ embedding_dim: 0 }),
    JSON.stringify({ embedding_provider: "unknown" }),
    JSON.stringify({ use_timezone: "Invalid/Timezone" }),
    JSON.stringify({
      llm_openai_default_header: { Authorization: { value: privateValue } },
    }),
    JSON.stringify({ additional_user_profiles: [{ topic: 1 }] }),
    JSON.stringify({
      additional_user_profiles: [{ topic: "work", description: 1 }],
    }),
    JSON.stringify({
      event_tags: [{ tag: privateValue, value: privateValue }],
    }),
  ];
  for (const raw of cases)
    assert.throws(
      () => readServiceConfig(raw),
      (error: any) => {
        assert.equal(error.code, "service_configuration_invalid");
        assert.equal(error.status, 503);
        assert.equal(error.retryable, false);
        assert.ok(!error.message.includes(privateValue));
        assert.ok(!JSON.stringify(error).includes(privateValue));
        return true;
      },
    );
});

test("invalid service settings stop runtime, model and cache entry points before work", async () => {
  let reads = 0;
  const env = {
    DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
    OPENAI_API_KEY: "local-only",
    MEMOIA_CONFIG: '{"best_llm_model":123}',
  };
  const runtime = {
    env,
    deadline: Date.now() + 60000,
    db: {
      query: async () => {
        reads++;
        throw new Error("unexpected SQL");
      },
    },
  } as unknown as Runtime;
  const invalid = (error: any) =>
    error.code === "service_configuration_invalid";
  assert.throws(() => createRuntime(env), invalid);
  await assert.rejects(getConfig(runtime, "p"), invalid);
  assert.throws(() => provider(runtime), invalid);
  assert.throws(() => supportsPromptCache(runtime, "gpt-6-luna"), invalid);
  assert.equal(reads, 0);
});
