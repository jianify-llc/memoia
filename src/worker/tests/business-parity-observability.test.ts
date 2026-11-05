import test from "node:test";
import assert from "node:assert/strict";
import { APIError } from "openai";
import { inSpan } from "../src/observability";
import { SourceError } from "../src/errors";

test("spans preserve results and report only controlled error codes", async () => {
  const attributes: Record<string, unknown> = {};
  const span = {
    setAttributes(values: object) {
      Object.assign(attributes, values);
    },
    setAttribute(key: string, value: unknown) {
      attributes[key] = value;
    },
    setStatus(value: unknown) {
      attributes.status = value;
    },
  };
  const tracing = {
    enterSpan(_name: string, fn: (span: unknown) => unknown) {
      return fn(span);
    },
  } as unknown as Tracing;
  assert.equal(
    await inSpan(tracing, "model", { kind: "agent_loop" }, async () => 7),
    7,
  );
  const failure = new SourceError(
    "model_unavailable",
    "sensitive provider content",
    503,
  );
  await assert.rejects(
    inSpan(tracing, "model", {}, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(attributes["error.code"], "model_unavailable");
  assert.ok(!JSON.stringify(attributes).includes("sensitive"));
});

test("tracing failures never replay work or hide business failures", async () => {
  let calls = 0;
  const unavailable = {
    enterSpan() {
      throw new Error("tracer");
    },
  } as unknown as Tracing;
  assert.equal(await inSpan(unavailable, "test", {}, async () => ++calls), 1);
  const brokenAnnotations = {
    enterSpan(_name: string, fn: (span: unknown) => unknown) {
      return fn({
        setAttributes() {
          throw new Error("tracer");
        },
        setStatus() {
          throw new Error("tracer");
        },
      });
    },
  } as unknown as Tracing;
  const failure = new Error("business");
  await assert.rejects(
    inSpan(brokenAnnotations, "test", {}, async () => {
      calls++;
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(calls, 2);
});

test("model spans retain only safe OpenAI rejection metadata", async () => {
  const run = async (error: APIError, name = "memoia.model") => {
    const attributes: Record<string, unknown> = {};
    const tracing = {
      enterSpan(_name: string, fn: (span: unknown) => unknown) {
        return fn({
          setAttributes(values: object) {
            Object.assign(attributes, values);
          },
          setAttribute(key: string, value: unknown) {
            attributes[key] = value;
          },
          setStatus() {},
        });
      },
    } as unknown as Tracing;
    let calls = 0;
    await assert.rejects(
      inSpan(tracing, name, {}, async () => {
        calls++;
        throw error;
      }),
      (value) => value === error,
    );
    assert.equal(calls, 1);
    return attributes;
  };
  const denied = APIError.generate(
    403,
    {
      error: {
        code: "unsupported_country_region_territory",
        type: "request_forbidden",
        message: "fixture user content and provider body",
        param: "fixture request input",
      },
    },
    undefined,
    new Headers({
      "x-request-id": "req_Fixture403",
      "set-cookie": "sk-private",
    }),
  );
  assert.deepEqual(await run(denied), {
    "error.code": "internal_error",
    "upstream.status": 403,
    "upstream.error.code": "unsupported_country_region_territory",
    "upstream.error.type": "request_forbidden",
    "upstream.request_id": "req_Fixture403",
  });
  assert.deepEqual(await run(denied, "memoia.http"), {
    "error.code": "internal_error",
  });
  const unsafe = APIError.generate(
    403,
    {
      error: {
        code: "sk_fixture_secret",
        type: "request_forbidden\n",
      },
    },
    undefined,
    new Headers({ "x-request-id": "sk-private" }),
  );
  assert.deepEqual(await run(unsafe), {
    "error.code": "internal_error",
    "upstream.status": 403,
  });
});

test("usage logs correlate the operation without changing project aggregates", async () => {
  const { recordUsage } = await import("../src/models");
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        query: async (sql: string, values: unknown[]) => {
          statements.push({ sql, values });
          return { rows: [], rowCount: 1 };
        },
      }),
  };
  const logs: string[] = [];
  const oldInfo = console.info;
  console.info = (value) => logs.push(String(value));
  try {
    await recordUsage(
      {
        db: db as never,
        env: { OPENAI_API_KEY: "local" },
        deadline: Date.now() + 1000,
        operationId: "operation-1",
      },
      "project-1",
      { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
      "agent_loop",
    );
  } finally {
    console.info = oldInfo;
  }
  assert.equal(JSON.parse(logs[0]).operation_id, "operation-1");
  assert.ok(statements.some(({ sql }) => sql.includes("usage_counters")));
  assert.ok(statements.every(({ values }) => !values.includes("operation-1")));
});
