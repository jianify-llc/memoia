import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runProbe } from "../v2-sdk-probe.mjs";

// These deterministic adapters test the acceptance tool, not Memoia or a model.
async function fixture(mode = "complete", version = "0.2.1") {
  const directory = await mkdtemp(join(tmpdir(), "memoia-v2-probe-"));
  const symbol = `memoia-probe-${randomUUID()}`;
  const sourceId = randomUUID(), operationId = randomUUID(), nameId = randomUUID(), foodId = randomUUID();
  const counters = { imports: 0, retracts: 0, deletes: 0, keyReads: 0, calls: 0 };
  let phase = 0, created = false, lastKey, userId;
  const operation = (status = "completed") => ({ operation_id: operationId, status,
    source_id: sourceId, external_id: "fixture", result: status === "completed" ? { event_ids: [randomUUID()], profile_ids: [] } : null,
    error: null });
  const imported = operation();
  const profile = (id, content) => ({ id, content, topic: "basic_info", sub_topic: "name", source_ids: [sourceId], updated_at: new Date().toISOString() });
  const history = () => ({ entries: [{ operation_id: operationId,
    profiles: phase === 1 ? [{ fact_ids: [nameId] }, { fact_ids: [foodId] }] : phase === 2 ?
      [{ fact_ids: [mode === "invalid-history" ? nameId : foodId] }] : [], added: [], removed: [] }] });
  const source = () => ({ source_id: sourceId, status: phase === 3 ? "retracted" : "active",
    retracted_message_ids: phase === 1 ? [] : phase === 2 ? ["name"] : ["name", "food"],
    evidence: phase === 1 ? [{ fact_id: nameId, support_groups: [["name"]] }, { fact_id: foodId, support_groups: [["food"]] }] :
      phase === 2 ? [{ fact_id: foodId, support_groups: [["food"]] }] : [] });
  globalThis[Symbol.for(symbol)] = class {
    constructor(options) { assert.equal(options.maxAttempts, 1); }
    async getProfiles() { return { profiles: phase === 1 ? [profile(nameId, "Renata Calder"), profile(foodId, "lemon risotto")] :
      phase === 2 ? [profile(foodId, "lemon risotto")] : [] }; }
    async importSource(uid, input) {
      counters.imports++; created = true; phase = 1; lastKey = input.idempotency_key; userId = uid;
      if (mode === "lost-ack") throw { outcome: "unknown", status: null, message: "must never escape" };
      return ["processing", "never-completes"].includes(mode) ? operation("processing") : imported;
    }
    async getOperationByKey(uid, key) {
      counters.keyReads++; assert.equal(uid, userId); assert.equal(key, lastKey);
      return mode === "never-completes" ? operation("processing") : imported;
    }
    async getOperation() { return imported; }
    async getSourceByExternalId() { return source(); }
    async getSource() { return source(); }
    async getHistory() { return history(); }
    async search() { return { events: phase === 3 ? [] : [{ source_id: sourceId }] }; }
    async retractMessages(uid, sid, input) {
      assert.equal(uid, userId); assert.equal(sid, sourceId);
      counters.retracts++; phase++; lastKey = input.idempotency_key;
      return operation();
    }
  };
  const transport = async (url, options) => {
    counters.calls++;
    const credential = options.headers.Authorization;
    if (credential !== "Bearer protected-fixture-token") return new Response("{}", { status: mode === "auth-bypass" ? 200 : 401 });
    assert.match(new URL(url).pathname, /^\/api\/v1\/users\/[0-9a-f-]+$/);
    if (options.method === "DELETE") {
      counters.deletes++; if (mode !== "cleanup-unconfirmed") created = false;
      return new Response(JSON.stringify({ errno: 0 }));
    }
    return new Response(JSON.stringify({ errno: created ? 0 : 404 }), { status: created ? 200 : 404 });
  };
  await mkdir(join(directory, "dist"));
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "@jianify/memoia", version, type: "module" }));
  await writeFile(join(directory, "dist/index.js"), `export const MemoiaClient = globalThis[Symbol.for(${JSON.stringify(symbol)})];`);
  return { entry: join(directory, "dist/index.js"), counters, transport,
    close: async () => { delete globalThis[Symbol.for(symbol)]; await rm(directory, { recursive: true }); } };
}

async function probe(mode, version) {
  const f = await fixture(mode, version);
  try {
    const result = await runProbe({ origin: "https://fixture.invalid", token: "protected-fixture-token",
      deadline_ms: mode === "never-completes" ? 1000 : 5000 }, f.entry,
    { transport: f.transport, pollIntervalMs: 0 });
    assert.doesNotMatch(JSON.stringify(result), /protected-fixture-token|Renata|risotto|must never escape/);
    return { result, counters: { ...f.counters } };
  } finally { await f.close(); }
}

test("fixed SDK, auth, receipt read-back, partial/full withdrawal and cleanup form a complete probe", async () => {
  const { result, counters } = await probe("complete");
  assert.equal(result.success, true);
  assert.equal(result.checks.cleanup, true);
  assert.deepEqual([counters.imports, counters.retracts, counters.deletes], [1, 2, 1]);
});

for (const mode of ["processing", "lost-ack"]) {
  test(`${mode} uses only receipt reads, not a second import POST`, async () => {
    const { result, counters } = await probe(mode);
    assert.equal(result.success, true);
    assert.equal(counters.imports, 1);
    assert.ok(counters.keyReads >= 2);
  });
}

test("deadline with a still-processing receipt preserves its user and exits unsuccessfully", async () => {
  const { result, counters } = await probe("never-completes");
  assert.equal(result.success, false);
  assert.equal(result.outcome_unknown, true);
  assert.equal(result.checks.cleanup, false);
  assert.equal(counters.imports, 1);
  assert.equal(counters.deletes, 0);
  assert.ok(result.ids.user_id && result.ids.import_key);
  assert.equal(result.ids.operation_ids.length, 1);
});

test("history exposing withdrawn evidence fails even when the mutation succeeded", async () => {
  const { result, counters } = await probe("invalid-history");
  assert.equal(result.success, false);
  assert.equal(result.checks.partial_retract, false);
  assert.equal(result.checks.cleanup, true);
  assert.equal(counters.deletes, 1);
});

test("DELETE success without confirming user absence is not accepted cleanup", async () => {
  const { result, counters } = await probe("cleanup-unconfirmed");
  assert.equal(result.success, false);
  assert.equal(result.checks.cleanup, false);
  assert.equal(counters.deletes, 1);
  assert.ok(result.ids.user_id);
});

test("wrong SDK version and missing auth isolation stop before any write", async () => {
  const wrong = await probe("complete", "0.2.0");
  assert.equal(wrong.result.success, false);
  assert.equal(wrong.counters.calls, 0);
  const bypass = await probe("auth-bypass");
  assert.equal(bypass.result.success, false);
  assert.equal(bypass.counters.imports, 0);
  assert.equal(bypass.counters.deletes, 0);
});
