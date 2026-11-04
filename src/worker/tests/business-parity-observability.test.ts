import test from "node:test";
import assert from "node:assert/strict";
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
