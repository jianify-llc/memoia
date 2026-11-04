import { test } from "node:test";
import assert from "node:assert/strict";
import { Database, LeaseLostError } from "../src/db";
import { SourceError } from "../src/errors";
import { MaintenanceContext } from "../src/maintenance";
import {
  MaintenanceModel,
  References,
  runMaintenance,
} from "../src/maintenance-agent";
import OpenAI from "openai";
import { SliceBudget, TaskYield } from "@jianify/legato";

test("reference order survives a continuation and rejects ambiguous snapshots", () => {
  const refs = new References();
  assert.equal(refs.encode("facts", "fact-b"), "f1");
  assert.equal(refs.encode("facts", "fact-a"), "f2");
  assert.equal(refs.encode("events", "event-a"), "e1");
  const restored = References.restore(
    JSON.parse(JSON.stringify(refs.snapshot())),
  );
  assert.equal(restored.decode("facts", "f1"), "fact-b");
  assert.equal(restored.encode("facts", "fact-a"), "f2");
  assert.equal(restored.encode("facts", "fact-c"), "f3");
  assert.equal(restored.decode("events", "e1"), "event-a");
  assert.throws(() =>
    References.restore({ facts: ["x", "x"], profiles: [], events: [] }),
  );
});

test("maintenance checkpoint restores the complete decision state", () => {
  const claim = { changes: [{ kind: "added" }] };
  const context = new MaintenanceContext(
    {} as never,
    claim as never,
    async () => {},
  );
  context.reads.facts.set("f", "1");
  context.staged.profiles.set("p", { action: "upsert", content: "derived" });
  context.required.profiles.add("p");
  context.derivedReads.events.add("e");
  context.seen.add(0);
  context.unresolved.set("u", "error");
  const restored = new MaintenanceContext(
    {} as never,
    claim as never,
    async () => {},
  );
  restored.restore(JSON.parse(JSON.stringify(context.snapshot())));
  assert.deepEqual(restored.snapshot(), context.snapshot());
  const invalid = context.snapshot();
  invalid.reads.facts.push(["f", "2"]);
  assert.throws(() => restored.restore(invalid));
});

test("native continuation requires exactly one result for every tool call", async () => {
  const context = { active: async () => {}, config: { llm_model: "mock" } };
  const model = new MaintenanceModel(
    new OpenAI({ apiKey: "mock" }),
    context as never,
  );
  const internal = model as unknown as {
    previous: unknown;
    _fetchResponse(request: unknown, stream: false): Promise<unknown>;
  };
  internal.previous = {
    id: "parent",
    output: [
      { type: "function_call", call_id: "a" },
      { type: "function_call", call_id: "b" },
    ],
  };
  await assert.rejects(
    internal._fetchResponse(
      {
        input: [
          { type: "function_call_result", callId: "a" },
          { type: "function_call_result", callId: "a" },
        ],
      },
      false,
    ),
    (error: unknown) =>
      error instanceof SourceError &&
      error.code === "maintenance_tool_results_incomplete",
  );
});

test("final HTTP keeps instructions, caches one public prefix, and continues native results after tier fallback", async () => {
  const db = new Database("postgresql://unused:unused@127.0.0.1:1/unused");
  db.transaction = async () => undefined as never;
  const runtime = {
    db,
    env: {
      OPENAI_API_KEY: "local-mock",
      OPENAI_BASE_URL: "https://provider.invalid/v1",
      MEMOIA_CONFIG: '{"llm_prompt_cache_options":true}',
    },
    deadline: Date.now() + 60000,
  };
  const claim = {
    userId: crypto.randomUUID(),
    projectId: "local",
    id: crypto.randomUUID(),
    owner: crypto.randomUUID(),

    blobIds: [],
    changes: [],
  };
  const context = new MaintenanceContext(runtime, claim, async () => {});
  context.config = {
    llm_model: "gpt-6-luna",
    reasoning_effort: "high",
    language: "en",
    embedding_model: "text-embedding-3-small",
    embedding_dim: 1536,
    embedding_provider: "openai",
    embedding_batch_size: 64,
    embedding_max_token_size: 8192,
    enable_event_embedding: false,
    profile_topics: [],
    event_tag_definitions: [],
    source_max_input_tokens: 16384,
    source_context_window_tokens: 131072,
    source_output_reserve_tokens: 32768,
  };
  let reads = 0;
  context.readChanges = async () => {
    reads++;
    return {
      items: [
        { fact_id: "fact-original", current_fact: { id: "fact-original" } },
      ],
      next_cursor: null,
      remaining_review: context.remaining(),
    };
  };
  const requests: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(
      String(init?.body ?? (await new Request(input).text())),
    );
    requests.push(body);
    if (requests.length === 1)
      return Response.json(
        {
          error: {
            type: "rate_limit_error",
            code: "rate_limit_exceeded",
            message: "local simulated retry",
          },
        },
        { status: 429 },
      );
    const output =
      requests.length === 2
        ? Array.from({ length: 4 }, (_, index) => ({
            type: "function_call",
            id: `fc_local_${index}`,
            call_id: `call_local_${index}`,
            name: "read_changes",
            arguments: '{"cursor":null,"limit":100}',
            status: "completed",
          }))
        : [
            {
              type: "message",
              id: "msg_local",
              role: "assistant",
              content: [{ type: "output_text", text: "Done", annotations: [] }],
              status: "completed",
            },
          ];
    if (requests.length === 2)
      output.unshift({
        type: "compaction",
        id: "compact_local",
        encrypted_content: "synthetic_compaction",
      } as never);
    return Response.json({
      id: requests.length === 2 ? "resp_tool" : "resp_done",
      object: "response",
      created_at: 1,
      status: "completed",
      error: null,
      incomplete_details: null,
      model: "gpt-6-luna",
      output,
      usage: {
        input_tokens: 100,
        output_tokens: 5,
        total_tokens: 105,
        input_tokens_details: { cached_tokens: 80 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    });
  };
  try {
    let now = Date.now();
    const budget = new SliceBudget(now, undefined, () => now);
    const referenceTime = {
      current_date: "2026-11-04",
      time_zone: "UTC",
      time_zone_source: "service_default",
    };
    let saved: any;
    await assert.rejects(
      runMaintenance(context, {
        budget,
        referenceTime,
        save: async (state) => {
          saved = JSON.parse(JSON.stringify(state));
          now = budget.softDeadlineAt;
        },
      }),
      TaskYield,
    );
    assert.equal(saved.phase, "agent_running");
    assert.equal(requests.length, 2);
    const restored = new MaintenanceContext(runtime, claim, async () => {});
    restored.config = context.config;
    restored.restore(saved.state);
    await runMaintenance(restored, {
      budget: new SliceBudget(now, undefined, () => now),
      referenceTime,
      resume: saved,
      save: async (state) => {
        saved = state;
      },
    });
    assert.equal(saved.phase, "agent_completed");
    assert.equal(requests.length, 3);
    assert.equal(
      reads,
      5,
      "one initial read and four tool calls, without replay",
    );
    assert.deepEqual(
      requests.map((r) => r.service_tier),
      ["flex", "default", "flex"],
    );
    assert.ok(requests[0].instructions.includes("Task and goal"));
    for (const body of requests) {
      assert.equal(body.instructions, requests[0].instructions);
      assert.equal(body.store, true);
      assert.equal(body.max_output_tokens, 32768);
      assert.equal(body.prompt_cache_key, undefined);
      assert.equal(body.prompt_cache_options.mode, "implicit");
      assert.equal(body.prompt_cache_options.ttl, "30m");
    }
    assert.equal(requests[0].input[0].content[0].text, "---");
    assert.deepEqual(requests[0].input[0].content[0].prompt_cache_breakpoint, {
      mode: "explicit",
      ttl: "12h",
    });
    assert.deepEqual(requests[1].input, requests[0].input);
    assert.equal(requests[2].previous_response_id, "resp_tool");
    assert.equal(requests[2].input.length, 4);
    for (const item of requests[2].input)
      assert.match(JSON.stringify(item.output), /f1/);
    assert.ok(
      requests[2].input.every(
        (item: any) => item.type === "function_call_output",
      ),
    );
    assert.deepEqual(
      new Set(requests[2].input.map((item: any) => item.call_id)),
      new Set(["call_local_0", "call_local_1", "call_local_2", "call_local_3"]),
    );
    assert.equal(
      requests[2].prompt_cache_options.comparison_response_id,
      "resp_tool",
    );
    assert.equal(requests[0].input[1].role, "developer");
    assert.ok(requests[0].tools.some((t: any) => t.name === "stage_profile"));
    assert.ok(requests[0].tools.some((t: any) => t.name === "stage_event"));
  } finally {
    globalThis.fetch = original;
    await db.close();
  }
});

test("short references are stable across pages and remain independent of compaction text", () => {
  const refs = new References();
  const id = crypto.randomUUID();
  assert.equal(refs.encode("facts", id), "f1");
  assert.equal(refs.encode("facts", id), "f1");
  refs.encode("facts", crypto.randomUUID());
  assert.equal(refs.decode("facts", "f1"), id);
  assert.equal(
    refs
      .entry("profiles", {
        id: crypto.randomUUID(),
        fact_ids: [id],
        content: "a place",
      })
      .fact_ids?.toString(),
    "f1",
  );
  assert.throws(() => refs.decode("facts", id));
});

function localContext() {
  const db = new Database("postgresql://unused:unused@127.0.0.1:1/unused");
  db.transaction = async () => undefined as never;
  const ctx = new MaintenanceContext(
    {
      db,
      env: {
        OPENAI_API_KEY: "local-mock",
        MEMOIA_CONFIG: '{"llm_prompt_cache_options":true}',
      },
      deadline: Date.now() + 60000,
    },
    {
      userId: crypto.randomUUID(),
      projectId: "local",
      id: crypto.randomUUID(),
      owner: crypto.randomUUID(),

      blobIds: [],
      changes: [],
    },
    async () => {},
  );
  ctx.config = {
    llm_model: "gpt-6-luna",
    reasoning_effort: "high",
    language: "en",
    embedding_model: "text-embedding-3-small",
    embedding_dim: 1536,
    embedding_provider: "openai",
    embedding_batch_size: 64,
    embedding_max_token_size: 8192,
    enable_event_embedding: false,
    profile_topics: [],
    event_tag_definitions: [],
    source_max_input_tokens: 16384,
    source_context_window_tokens: 131072,
    source_output_reserve_tokens: 32768,
  };
  ctx.readChanges = async () => ({
    items: [],
    next_cursor: null,
    remaining_review: ctx.remaining(),
  });
  return ctx;
}
function modelResponse(id: string, output: unknown[], diagnostic?: unknown) {
  return Response.json({
    id,
    object: "response",
    created_at: 1,
    status: "completed",
    error: null,
    incomplete_details: null,
    model: "gpt-6-luna",
    output,
    usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
    ...(diagnostic === undefined
      ? {}
      : { prompt_cache_diagnostics: diagnostic }),
  });
}
const done = [
  {
    type: "message",
    id: "msg",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Done", annotations: [] }],
  },
];
const readCall = [
  {
    type: "function_call",
    id: "fc",
    call_id: "call",
    name: "read_changes",
    arguments: '{"cursor":null,"limit":100}',
    status: "completed",
  },
];

test("Runner preserves original domain, lease, SQL and permanent tool errors", async () => {
  const original = globalThis.fetch;
  try {
    for (const failure of [
      new SourceError("maintenance_read_conflict", "retry", 503, true),
      new LeaseLostError(),
      Object.assign(new Error("query cancelled"), { code: "57014" }),
      new SourceError("invalid_model_output", "permanent", 502),
    ]) {
      const ctx = localContext();
      let reads = 0,
        requests = 0;
      ctx.readChanges = async () => {
        if (++reads === 2) throw failure;
        return {
          items: [],
          next_cursor: null,
          remaining_review: ctx.remaining(),
        };
      };
      globalThis.fetch = async () => {
        requests++;
        return modelResponse("resp_tool", readCall);
      };
      try {
        await assert.rejects(
          runMaintenance(ctx),
          (error: unknown) => error === failure,
        );
        assert.equal(
          requests,
          1,
          "a failed tool must not replay the model or tools",
        );
      } finally {
        await ctx.runtime.db.close();
      }
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("conversation_locked falls back on the same parent and native tool result", async () => {
  const original = globalThis.fetch;
  const ctx = localContext();
  const requests: any[] = [];
  let reads = 0;
  ctx.readChanges = async () => {
    reads++;
    return { items: [], next_cursor: null, remaining_review: ctx.remaining() };
  };
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    if (requests.length === 1) return modelResponse("resp_tool", readCall);
    if (requests.length === 2)
      return Response.json(
        {
          error: {
            code: "conversation_locked",
            type: "invalid_request_error",
            message: "locked",
          },
        },
        { status: 400 },
      );
    return modelResponse("resp_done", done);
  };
  try {
    await runMaintenance(ctx);
    assert.deepEqual(
      requests.map((r) => r.service_tier),
      ["flex", "flex", "default"],
    );
    assert.equal(reads, 2, "initial changes and one tool execution only");
    assert.deepEqual(requests[2].input, requests[1].input);
    for (const r of requests.slice(1)) {
      assert.equal(r.previous_response_id, "resp_tool");
      assert.equal(r.instructions, requests[0].instructions);
      assert.equal(r.input.length, 1);
      assert.equal(r.input[0].type, "function_call_output");
      assert.equal(r.prompt_cache_options.comparison_response_id, "resp_tool");
    }
  } finally {
    globalThis.fetch = original;
    await ctx.runtime.db.close();
  }
});

test("Flex failures consume failure budget when Standard cannot fit, then a new slice starts with Flex", async () => {
  const original = globalThis.fetch;
  const ctx = localContext();
  let now = Date.now();
  let budget = new SliceBudget(now, undefined, () => now);
  const tiers: string[] = [];
  let reads = 0;
  ctx.readChanges = async () => {
    reads++;
    return { items: [], next_cursor: null, remaining_review: ctx.remaining() };
  };
  globalThis.fetch = async (_input, init) => {
    tiers.push(JSON.parse(String(init?.body)).service_tier);
    if (tiers.length === 1) return modelResponse("resp_tool", readCall);
    if (tiers.length <= 3) {
      now = budget.softDeadlineAt;
      return Response.json(
        {
          error: {
            type: "rate_limit_error",
            code: "rate_limit_exceeded",
            message: "retry",
          },
        },
        { status: 429 },
      );
    }
    return modelResponse("resp_done", done);
  };
  const referenceTime = {
    current_date: "2026-11-04",
    time_zone: "UTC",
    time_zone_source: "service_default",
  };
  let saved: any;
  const save = async (state: unknown) => {
    saved = JSON.parse(JSON.stringify(state));
  };
  try {
    await assert.rejects(
      runMaintenance(ctx, { budget, referenceTime, save }),
      (error: unknown) =>
        error instanceof SourceError &&
        error.code === "model_unavailable" &&
        error.retryable,
    );
    assert.deepEqual(tiers, ["flex", "flex"]);
    assert.equal(saved.parentId, "resp_tool");
    budget = new SliceBudget(now, undefined, () => now);
    const restored = localContext();
    restored.restore(saved.state);
    await assert.rejects(
      runMaintenance(restored, { budget, referenceTime, resume: saved, save }),
      (error: unknown) =>
        error instanceof SourceError &&
        error.code === "model_unavailable" &&
        error.retryable,
    );
    assert.deepEqual(tiers, ["flex", "flex", "flex"]);
    await runMaintenance(restored, {
      budget: new SliceBudget(now, undefined, () => now),
      referenceTime,
      resume: saved,
      save,
    });
    assert.deepEqual(tiers, ["flex", "flex", "flex", "flex"]);
    assert.equal(reads, 2);
    await restored.runtime.db.close();
  } finally {
    globalThis.fetch = original;
    await ctx.runtime.db.close();
  }
});

test("initial Flex failure cannot become a free yield, while no request can yield normally", async () => {
  const original = globalThis.fetch;
  const ctx = localContext();
  let now = Date.now();
  let budget = new SliceBudget(now, undefined, () => now);
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    now = budget.softDeadlineAt;
    return Response.json(
      {
        error: {
          type: "rate_limit_error",
          code: "rate_limit_exceeded",
          message: "retry",
        },
      },
      { status: 429 },
    );
  };
  const referenceTime = {
    current_date: "2026-11-04",
    time_zone: "UTC",
    time_zone_source: "service_default",
  };
  try {
    for (let slice = 0; slice < 2; slice++) {
      budget = new SliceBudget(now, undefined, () => now);
      await assert.rejects(
        runMaintenance(ctx, { budget, referenceTime, save: async () => {} }),
        (error: unknown) =>
          error instanceof SourceError &&
          error.code === "model_unavailable" &&
          error.retryable,
      );
    }
    assert.equal(requests, 2);
    budget = new SliceBudget(now - 12 * 60_000, undefined, () => now);
    await assert.rejects(
      runMaintenance(ctx, { budget, referenceTime, save: async () => {} }),
      TaskYield,
    );
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = original;
    await ctx.runtime.db.close();
  }
});

test("cache diagnostics are allowlisted and cannot fail or replay a successful request", async () => {
  const original = globalThis.fetch,
    info = console.info;
  const logs: any[] = [];
  console.info = (raw: unknown) => {
    logs.push(JSON.parse(String(raw)));
  };
  const diagnostics = [
    {
      type: "cache_miss",
      reason: "context_compacted",
      comparison_reusable_tokens: 0,
      cache_missed_tokens: 42,
      raw_prompt: "private-body",
    },
    {
      type: "cache_miss",
      reason: "private-reason",
      comparison_reusable_tokens: -1,
      cache_missed_tokens: 0.5,
    },
    { type: "cache_hit" },
    { type: "comparison_response_not_found" },
    { type: "unavailable" },
    { type: "unsupported", raw_prompt: "private-body" },
    null,
  ];
  try {
    for (const diagnostic of diagnostics) {
      const ctx = localContext();
      globalThis.fetch = async () =>
        modelResponse("resp_done", done, diagnostic);
      try {
        await runMaintenance(ctx);
      } finally {
        await ctx.runtime.db.close();
      }
    }
    const safe = logs.filter((v) => v.event === "llm_cache_diagnostic");
    assert.equal(safe.length, 5);
    assert.equal(safe[0].reason, "context_compacted");
    assert.equal(safe[0].comparison_reusable_tokens, 0);
    assert.equal(safe[0].cache_missed_tokens, 42);
    assert.equal(safe[1].reason, "unknown");
    assert.equal(safe[1].comparison_reusable_tokens, null);
    assert.equal(safe[1].cache_missed_tokens, null);
    assert.equal(JSON.stringify(logs).includes("private-"), false);
    const ctx = localContext();
    let requests = 0;
    console.info = (raw: unknown) => {
      if (JSON.parse(String(raw)).event === "llm_cache_diagnostic")
        throw Error("log unavailable");
    };
    globalThis.fetch = async () => {
      requests++;
      return modelResponse("resp_done", done, { type: "cache_hit" });
    };
    try {
      await runMaintenance(ctx);
      assert.equal(requests, 1);
    } finally {
      await ctx.runtime.db.close();
    }
  } finally {
    globalThis.fetch = original;
    console.info = info;
  }
});
