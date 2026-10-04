import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, open, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runProbe } from "../v2-sdk-probe.mjs";

// These deterministic adapters test the acceptance tool, not Memoia or a model.
async function fixture(mode = "complete", version = "0.3.0") {
  const directory = await mkdtemp(join(tmpdir(), "memoia-v2-probe-"));
  const symbol = `memoia-probe-${randomUUID()}`;
  let sourceId = randomUUID();
  const blobId = randomUUID(), operationId = randomUUID(), nameId = randomUUID(), foodId = randomUUID(), eventId = randomUUID();
  const extraId = randomUUID();
  const lateSourceId = randomUUID(), lateOperationId = randomUUID(), lateEventId = randomUUID(), lateProfileId = randomUUID();
  const counters = { imports: 0, retracts: 0, deletes: 0, keyReads: 0, calls: 0, completedReplays: 0,
    forgets: 0, lateImports: 0 };
  let phase = 0, created = false, lastKey, userId, acceptedBody, completed = false;
  class MemoiaError extends Error {
    constructor(code, status, retryable, outcome = "rejected") {
      super("must never escape");
      Object.assign(this, { code, status, retryable, outcome });
    }
  }
  const operation = (status = "completed") => ({ operation_id: operationId, status,
    source_id: sourceId, blob_id: blobId, result: status === "completed" ? { event_ids: [eventId], profile_ids: [] } : null,
    error: null });
  const imported = operation();
  const profile = (id, content) => ({ id, content, topic: "basic_info", sub_topic: "name",
    source_ids: [mode === "replay-profile-association-changed" && counters.completedReplays ? extraId : sourceId],
    updated_at: new Date().toISOString() });
  const history = () => ({ entries: [{ operation_id: operationId,
    profiles: phase === 1 ? [{ fact_ids: [nameId] }, { fact_ids: [foodId] }] : phase === 2 ?
      [{ fact_ids: [mode === "invalid-history" ? nameId : foodId] }] :
      mode === "final-history-leak" ? [{ fact_ids: [foodId] }] : [], added: [], removed: [] }] });
  const blob = () => ({ blob_id: blobId, source_id: sourceId, status: phase === 3 ? "retracted" : "active",
    message_ids: ["name", "food"], event_ids: phase === 3 ? [] : [eventId], created_at: new Date().toISOString() });
  const source = () => ({ source_id: sourceId, blobs: [blob()], message_ids: ["name", "food"],
    deleted_message_ids: phase === 1 ? [] : phase === 2 ? ["name"] : ["name", "food"],
    evidence: phase === 1 ? [{ fact_id: nameId, support_groups: [["name"]] }, { fact_id: foodId, support_groups: [["food"]] }] :
      phase === 2 ? [{ fact_id: foodId, support_groups: [["food"]] }] : [] });
  const MemoiaClient = class {
    constructor(options) { assert.equal(options.maxAttempts, 1); }
    async getProfiles() { return { profiles: phase === 1 ? [profile(nameId, "Renata Calder"), profile(foodId, "lemon risotto"),
      ...(mode === "replay-profiles-grow" && counters.completedReplays ? [profile(extraId, "fixture")] : [])] :
      phase === 2 ? [profile(foodId, "lemon risotto")] : [] }; }
    async importBlob(uid, input) {
      counters.imports++;
      if (counters.forgets) {
        counters.lateImports++;
        assert.equal(counters.forgets, 2, "A late import requires two confirmed forget receipts");
        assert.equal(uid, userId);
        assert.notEqual(input.idempotency_key, acceptedBody.idempotency_key);
        assert.notEqual(input.source_id, acceptedBody.source_id);
        assert.equal(input.messages.length, 1);
        if (mode === "late-lost-ack") throw new MemoiaError("TRANSPORT_ERROR", null, false, "unknown");
        if (mode === "late-forged-410") throw { code: "user_forgotten", status: 410, retryable: false, outcome: "rejected" };
        if (mode === "late-404") throw new MemoiaError("HTTP_ERROR", 404, false);
        if (mode === "late-auth-denied") throw new MemoiaError("HTTP_ERROR", 403, false);
        if (mode === "late-wrong-code") throw new MemoiaError("source_not_found", 410, false);
        if (mode === "late-retryable") throw new MemoiaError("user_forgotten", 410, true);
        if (mode === "late-unknown-410") throw new MemoiaError("user_forgotten", 410, false, "unknown");
        if (["late-processing", "late-completed", "late-failed"].includes(mode)) {
          created = true;
          const status = mode.slice(5);
          return { operation_id: lateOperationId, status, source_id: lateSourceId, blob_id: randomUUID(),
            result: status === "completed" ? { event_ids: [lateEventId], profile_ids: [lateProfileId] } : null,
            error: status === "failed" ? { code: "model_unavailable", retryable: true } : null };
        }
        throw new MemoiaError("user_forgotten", 410, false);
      }
      if (counters.imports > 1) {
        assert.equal(completed, true, "A replay must not race an unconfirmed import");
        assert.equal(uid, userId); assert.deepEqual(input, acceptedBody);
        counters.completedReplays++;
        if (mode === "replay-lost-ack") throw { outcome: "unknown", status: null, message: "must never escape" };
        if (mode === "replay-processing") return operation("processing");
        if (mode === "replay-id-changed") return { ...imported, operation_id: extraId };
        if (mode === "replay-source-id-changed") return { ...imported, source_id: extraId };
        if (mode === "replay-event-id-changed") return { ...imported, result: { ...imported.result, event_ids: [extraId] } };
        return imported;
      }
      acceptedBody = structuredClone(input); created = true; phase = 1; lastKey = input.idempotency_key; userId = uid;
      sourceId = input.source_id; imported.source_id = sourceId;
      if (mode === "lost-ack") throw { outcome: "unknown", status: null, message: "must never escape" };
      if (["processing", "never-completes"].includes(mode)) return operation("processing");
      completed = true;
      return imported;
    }
    async getOperationByKey(uid, key) {
      counters.keyReads++; assert.equal(uid, userId); assert.equal(key, lastKey);
      if (mode === "never-completes") return operation("processing");
      completed = true;
      return imported;
    }
    async getOperation() { return imported; }
    async getBlob() { return blob(); }
    async getSource() { return source(); }
    async listSources() { return { sources: [source(),
      ...(mode === "replay-sources-grow" && counters.completedReplays ? [{ ...source(), source_id: extraId }] : [])] }; }
    async getHistory() { return history(); }
    async search() { return { events: phase === 3 && mode !== "final-search-leak" ? [] : [{ source_id: sourceId }] }; }
    async deleteMessages(uid, sid, input) {
      assert.equal(uid, userId); assert.equal(sid, sourceId);
      counters.retracts++; phase++; lastKey = input.idempotency_key;
      return operation();
    }
    async forgetUser(uid) {
      assert.equal(uid, userId);
      assert.equal(phase, 3, "Forget must follow all original business checks");
      counters.forgets++;
      const prefix = counters.forgets === 1 ? "forget" : "forget-repeat";
      if (mode === `${prefix}-lost-ack`) throw new MemoiaError("TRANSPORT_ERROR", null, false, "unknown");
      if (mode === `${prefix}-rejected`) throw new MemoiaError("HTTP_ERROR", 403, false);
      if (mode === `${prefix}-wrong-user`) return { user_id: extraId, forgotten: true };
      if (mode === `${prefix}-false`) return { user_id: uid, forgotten: false };
      if (mode === `${prefix}-missing`) return { user_id: uid };
      if (mode === `${prefix}-null`) return null;
      if (mode === `${prefix}-extra`) return { user_id: uid, forgotten: true, ignored: true };
      if (mode !== "cleanup-unconfirmed") created = false;
      return { user_id: uid, forgotten: true };
    }
  };
  globalThis[Symbol.for(symbol)] = { MemoiaClient, MemoiaError };
  const transport = async (url, options) => {
    counters.calls++;
    const credential = options.headers.Authorization;
    if (credential !== "Bearer protected-fixture-token") return new Response("{}", { status: mode === "auth-bypass" ? 200 : 401 });
    if (new URL(url).pathname === `/api/v1/users/event/${userId}`) {
      assert.equal(options.method, "GET");
      assert.equal(new URL(url).searchParams.get("topk"), "100");
      return new Response(JSON.stringify({ errno: 0, data: { events: [{ id: eventId },
        ...(mode === "replay-events-grow" && counters.completedReplays ? [{ id: extraId }] : [])] } }));
    }
    assert.match(new URL(url).pathname, /^\/api\/v1\/users\/[0-9a-f-]+$/);
    if (options.method === "DELETE") {
      counters.deletes++; if (mode !== "cleanup-unconfirmed") created = false;
      return new Response(JSON.stringify({ errno: 0 }));
    }
    return new Response(JSON.stringify({ errno: created ? 0 : 404 }), { status: created ? 200 : 404 });
  };
  await mkdir(join(directory, "dist"));
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "@jianify/memoia", version, type: "module" }));
  await writeFile(join(directory, "dist/index.js"), `export const { MemoiaClient, MemoiaError } = globalThis[Symbol.for(${JSON.stringify(symbol)})];`);
  return { entry: join(directory, "dist/index.js"), counters, transport, lateIds: { lateSourceId, lateOperationId, lateEventId, lateProfileId },
    close: async () => { delete globalThis[Symbol.for(symbol)]; await rm(directory, { recursive: true }); } };
}

async function probe(mode, version, checkpoint) {
  const f = await fixture(mode, version);
  try {
    const result = await runProbe({ origin: "https://fixture.invalid", token: "protected-fixture-token",
      deadline_ms: mode === "never-completes" ? 1000 : 5000 }, f.entry,
    { transport: f.transport, pollIntervalMs: 0, ...(checkpoint ? { checkpoint } : {}) });
    assert.doesNotMatch(JSON.stringify(result), /protected-fixture-token|Renata|risotto|must never escape/);
    return { result, counters: { ...f.counters }, lateIds: f.lateIds };
  } finally { await f.close(); }
}

test("fixed SDK completes original checks before permanent forget, repeat receipt and rejected late import", async () => {
  const { result, counters } = await probe("complete");
  assert.equal(result.success, true);
  assert.equal(result.checks.cleanup, true);
  assert.equal(result.checks.operation_replay, true);
  assert.equal(result.checks.forget_user, true);
  assert.equal(result.checks.forget_repeat, true);
  assert.equal(result.checks.late_import_rejected, true);
  assert.deepEqual([counters.imports, counters.completedReplays, counters.retracts, counters.forgets,
    counters.lateImports, counters.deletes], [3, 1, 2, 2, 1, 0]);
  assert.equal(result.ids.forget_user_id, result.ids.user_id);
  assert.equal(result.ids.forget_repeat_user_id, result.ids.user_id);
  assert.ok(result.ids.late_import_key && result.ids.late_input_source_id);
  assert.notEqual(result.ids.late_import_key, result.ids.import_key);
  assert.notEqual(result.ids.late_input_source_id, result.ids.input_source_id);
  assert.equal(result.counts.sources_before_replay, result.counts.sources_after_replay);
  assert.equal(result.counts.profiles_before, result.counts.profiles_after_replay);
  assert.equal(result.counts.events_before_replay, result.counts.events_after_replay);
});

for (const mode of ["processing", "lost-ack"]) {
  test(`${mode} waits for confirmed completion before its one deliberate replay`, async () => {
    const { result, counters } = await probe(mode);
    assert.equal(result.success, true);
    assert.equal(counters.imports, 3);
    assert.equal(counters.completedReplays, 1);
    assert.ok(counters.keyReads >= 2);
  });
}

for (const mode of ["replay-id-changed", "replay-source-id-changed", "replay-event-id-changed", "replay-sources-grow",
  "replay-profiles-grow", "replay-profile-association-changed", "replay-events-grow"]) {
  test(`${mode} fails explicit idempotency acceptance`, async () => {
    const { result, counters } = await probe(mode);
    assert.equal(result.success, false);
    assert.equal(result.checks.operation_replay, false);
    assert.equal(result.outcome_unknown, false);
    assert.equal(result.checks.cleanup, true);
    assert.equal(counters.imports, 2);
    assert.equal(counters.retracts, 0);
  });
}

for (const mode of ["replay-lost-ack", "replay-processing"]) {
  test(`${mode} preserves the user and known IDs, without a third import POST`, async () => {
    const { result, counters } = await probe(mode);
    assert.equal(result.success, false);
    assert.equal(result.checks.operation_replay, false);
    assert.equal(result.outcome_unknown, true);
    assert.equal(result.checks.cleanup, false);
    assert.deepEqual([counters.imports, counters.completedReplays, counters.deletes, counters.retracts], [2, 1, 0, 0]);
    assert.ok(result.ids.user_id && result.ids.import_key && result.ids.import_operation_id && result.ids.source_id);
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
  assert.equal(counters.forgets, 0);
});

for (const mode of ["final-history-leak", "final-search-leak"]) {
  test(`${mode} never enters permanent forget before original business acceptance`, async () => {
    const { result, counters } = await probe(mode);
    assert.equal(result.success, false);
    assert.equal(result.checks.profile_history, false);
    assert.equal(result.checks.forget_user, false);
    assert.equal(counters.retracts, 2);
    assert.equal(counters.forgets, 0);
    assert.equal(counters.lateImports, 0);
    assert.equal(counters.deletes, 1);
  });
}

test("DELETE success without confirming user absence is not accepted cleanup", async () => {
  const { result, counters } = await probe("cleanup-unconfirmed");
  assert.equal(result.success, false);
  assert.equal(result.checks.cleanup, false);
  assert.equal(counters.deletes, 0);
  assert.equal(counters.forgets, 2);
  assert.ok(result.ids.user_id);
});

test("wrong SDK version and missing auth isolation stop before any write", async () => {
  const wrong = await probe("complete", "0.2.1");
  assert.equal(wrong.result.success, false);
  assert.equal(wrong.counters.calls, 0);
  const bypass = await probe("auth-bypass");
  assert.equal(bypass.result.success, false);
  assert.equal(bypass.counters.imports, 0);
  assert.equal(bypass.counters.deletes, 0);
});

for (const mode of ["forget-lost-ack", "forget-wrong-user", "forget-false", "forget-missing", "forget-null", "forget-extra",
  "forget-repeat-lost-ack", "forget-repeat-wrong-user", "forget-repeat-false", "forget-repeat-missing", "forget-repeat-null", "forget-repeat-extra"]) {
  test(`${mode} stops without another forget, late import or v1 deletion`, async () => {
    const { result, counters } = await probe(mode);
    assert.equal(result.success, false);
    assert.equal(result.outcome_unknown, true);
    assert.equal(result.checks.profile_history, true);
    assert.equal(result.checks.cleanup, false);
    assert.equal(result.checks.late_import_rejected, false);
    assert.equal(counters.forgets, mode.startsWith("forget-repeat-") ? 2 : 1);
    assert.equal(counters.imports, 2);
    assert.equal(counters.lateImports, 0);
    assert.equal(counters.deletes, 0);
    assert.ok(result.ids.source_id && result.ids.import_operation_id && result.ids.retract_operation_id);
  });
}

for (const mode of ["forget-rejected", "forget-repeat-rejected"]) {
  test(`${mode} is not permanent forget proof and never falls back to ordinary deletion`, async () => {
    const { result, counters } = await probe(mode);
    assert.equal(result.success, false);
    assert.equal(result.outcome_unknown, false);
    assert.equal(result.checks.forget_repeat, false);
    assert.equal(result.checks.late_import_rejected, false);
    assert.equal(counters.forgets, mode.startsWith("forget-repeat-") ? 2 : 1);
    assert.equal(counters.lateImports, 0);
    assert.equal(counters.deletes, 0);
  });
}

for (const mode of ["late-lost-ack", "late-forged-410", "late-unknown-410", "late-404", "late-auth-denied", "late-wrong-code", "late-retryable"]) {
  test(`${mode} cannot substitute for typed nonretryable user_forgotten rejection`, async () => {
    const { result, counters } = await probe(mode);
    assert.equal(result.success, false);
    assert.equal(result.checks.forget_user, true);
    assert.equal(result.checks.forget_repeat, true);
    assert.equal(result.checks.late_import_rejected, false);
    assert.equal(result.outcome_unknown, ["late-lost-ack", "late-forged-410", "late-unknown-410"].includes(mode));
    assert.equal(counters.lateImports, 1);
    assert.equal(counters.imports, 3);
    assert.equal(counters.forgets, 2);
    assert.equal(counters.deletes, 0);
    assert.ok(result.ids.late_import_key && result.ids.late_input_source_id);
  });
}

for (const mode of ["late-processing", "late-completed", "late-failed"]) {
  test(`${mode} preserves unexpected known receipts and fails without replay or deletion`, async () => {
    const { result, counters, lateIds } = await probe(mode);
    assert.equal(result.success, false);
    assert.equal(result.checks.late_import_rejected, false);
    assert.equal(result.checks.cleanup, false);
    assert.equal(result.outcome_unknown, mode === "late-processing");
    assert.equal(counters.lateImports, 1);
    assert.equal(counters.imports, 3);
    assert.equal(counters.forgets, 2);
    assert.equal(counters.deletes, 0);
    assert.equal(result.ids.late_operation_id, lateIds.lateOperationId);
    assert.equal(result.ids.late_source_id, lateIds.lateSourceId);
    assert.ok(result.ids.operation_ids.includes(result.ids.import_operation_id));
    assert.ok(result.ids.operation_ids.includes(lateIds.lateOperationId));
    assert.ok(result.ids.source_ids.includes(result.ids.source_id));
    assert.ok(result.ids.source_ids.includes(lateIds.lateSourceId));
    if (mode === "late-completed") {
      assert.ok(result.ids.event_ids.includes(lateIds.lateEventId));
      assert.ok(result.ids.profile_ids.includes(lateIds.lateProfileId));
    }
  });
}

test("checkpoint precedes every mutation and persists cumulative receipts before the next write", async () => {
  const f = await fixture();
  const records = [];
  try {
    const result = await runProbe({ origin: "https://fixture.invalid", token: "protected-fixture-token", deadline_ms: 5000 }, f.entry,
      { transport: f.transport, pollIntervalMs: 0, checkpoint: async (record) => {
        const count = { "first_import.before": [0, 0, 0], "first_import.receipt": [1, 0, 0],
          "operation_replay.before": [1, 0, 0], "operation_replay.receipt": [2, 0, 0],
          "partial_retract.before": [2, 0, 0], "partial_retract.receipt": [2, 1, 0],
          "retract.before": [2, 1, 0], "retract.receipt": [2, 2, 0],
          "forget_user.before": [2, 2, 0], "forget_user.receipt": [2, 2, 1],
          "forget_repeat.before": [2, 2, 1], "forget_repeat.receipt": [2, 2, 2],
          "late_import.before": [2, 2, 2], "late_import.rejected": [3, 2, 2], "cleanup.confirmed": [3, 2, 2] };
        assert.equal(record.kind, "boundary");
        assert.deepEqual([f.counters.imports, f.counters.retracts, f.counters.forgets], count[record.stage]);
        assert.doesNotMatch(JSON.stringify(record), /protected-fixture-token|Renata|risotto|must never escape/);
        records.push(record);
      } });
    assert.equal(result.success, true);
    assert.equal(records.length, 15);
    const first = records.find((r) => r.stage === "first_import.before");
    assert.ok(first.ids.user_id && first.ids.import_key && first.ids.late_import_key && first.ids.late_input_source_id);
    assert.equal(first.outcome_unknown, true);
    assert.equal(first.ids.operation_ids.length, 0, "Checkpoint data must not change with later receipts");
    const imported = records.find((r) => r.stage === "first_import.receipt");
    const replay = records.find((r) => r.stage === "operation_replay.before");
    assert.equal(imported.outcome_unknown, false);
    assert.ok(imported.ids.operation_ids.includes(result.ids.import_operation_id));
    assert.ok(imported.ids.source_ids.includes(result.ids.source_id));
    assert.deepEqual(imported.ids.event_ids, result.ids.event_ids);
    assert.deepEqual(replay.ids.operation_ids, imported.ids.operation_ids);
    const confirmed = records.find((r) => r.stage === "forget_user.receipt");
    const repeat = records.find((r) => r.stage === "forget_repeat.before");
    assert.equal(confirmed.ids.forget_user_id, result.ids.user_id);
    assert.equal(repeat.ids.forget_user_id, result.ids.user_id);
    assert.equal(repeat.checks.forget_user, true);
    const late = records.find((r) => r.stage === "late_import.before");
    assert.equal(late.ids.forget_repeat_user_id, result.ids.user_id);
    assert.equal(late.checks.forget_repeat, true);
  } finally { await f.close(); }
});

test("a pending asynchronous checkpoint holds the mutation until durable recording completes", async () => {
  const f = await fixture();
  let release, reached;
  const ready = new Promise((resolve) => { reached = resolve; });
  const durable = new Promise((resolve) => { release = resolve; });
  try {
    const running = runProbe({ origin: "https://fixture.invalid", token: "protected-fixture-token", deadline_ms: 5000 }, f.entry,
      { transport: f.transport, pollIntervalMs: 0, checkpoint: async (record) => {
        if (record.stage === "first_import.before") { reached(); await durable; }
      } });
    await ready;
    assert.equal(f.counters.imports, 0);
    assert.equal(f.counters.deletes, 0);
    release();
    assert.equal((await running).success, true);
  } finally { release(); await f.close(); }
});

for (const [stage, counts, mode = "complete"] of [
  ["first_import.before", [0, 0, 0, 0]], ["operation_replay.before", [1, 0, 0, 0]],
  ["partial_retract.before", [2, 0, 0, 0]], ["retract.before", [2, 1, 0, 0]],
  ["forget_user.before", [2, 2, 0, 0]], ["forget_repeat.before", [2, 2, 1, 0]],
  ["late_import.before", [2, 2, 2, 0]], ["cleanup.before", [2, 1, 0, 0], "invalid-history"],
]) {
  test(`rejected checkpoint ${stage} prevents the corresponding and later mutations`, async () => {
    let rejected = false;
    const { result, counters } = await probe(mode, undefined, async (record) => {
      if (record.stage === stage) { rejected = true; throw new Error("must never escape"); }
    });
    assert.equal(rejected, true);
    assert.equal(result.success, false);
    assert.equal(result.outcome_unknown, false, "A refused pre-write checkpoint must not issue that request");
    assert.equal(result.checks.cleanup, false);
    assert.deepEqual([counters.imports, counters.retracts, counters.forgets, counters.deletes], counts);
  });
}

for (const [stage, counts] of [["first_import.receipt", [1, 0, 0]], ["forget_user.receipt", [2, 2, 1]],
  ["forget_repeat.receipt", [2, 2, 2]], ["cleanup.confirmed", [3, 2, 2]]]) {
  test(`rejected receipt checkpoint ${stage} retains known result without another write`, async () => {
    const { result, counters } = await probe("complete", undefined, async (record) => {
      if (record.stage === stage) throw new Error("must never escape");
    });
    assert.equal(result.success, false);
    assert.equal(result.outcome_unknown, false);
    assert.ok(result.ids.operation_ids.length > 0 && result.ids.source_ids.length > 0);
    assert.deepEqual([counters.imports, counters.retracts, counters.forgets], counts);
    assert.equal(counters.deletes, 0);
    if (stage !== "first_import.receipt") assert.equal(result.ids.forget_user_id, result.ids.user_id);
  });
}

test("checkpoint failure during receipt lookup is not mistaken for a transient provider error", async () => {
  const { result, counters } = await probe("processing", undefined, async (record) => {
    if (record.stage === "first_import.receipt" && !record.outcome_unknown) {
      throw Object.assign(new Error("must never escape"), { status: 503 });
    }
  });
  assert.equal(result.success, false);
  assert.equal(result.outcome_unknown, false);
  assert.equal(counters.keyReads, 1);
  assert.equal(counters.imports, 1);
  assert.equal(counters.retracts, 0);
  assert.equal(counters.deletes, 0);
});

test("unexpected late receipt is checkpointed with all known IDs before probe failure", async () => {
  const records = [];
  const { result, lateIds } = await probe("late-completed", undefined, async (record) => { records.push(record); });
  const accepted = records.find((r) => r.stage === "late_import.receipt");
  assert.ok(accepted);
  assert.equal(result.success, false);
  assert.equal(accepted.outcome_unknown, false);
  assert.equal(accepted.ids.late_operation_id, lateIds.lateOperationId);
  assert.equal(accepted.ids.late_source_id, lateIds.lateSourceId);
  assert.ok(accepted.ids.event_ids.includes(lateIds.lateEventId));
  assert.ok(accepted.ids.profile_ids.includes(lateIds.lateProfileId));
});

test("CLI regular-file boundary survives process exit inside the first mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memoia-probe-checkpoint-"));
  const receipt = join(directory, "receipt.ndjson");
  const server = createServer((request, response) => {
    const missing = request.url.startsWith("/api/v2/");
    response.writeHead(missing ? 401 : 404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ errno: 404 }));
  });
  let child, output;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    await mkdir(join(directory, "dist"));
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "@jianify/memoia", version: "0.3.0", type: "module" }));
    await writeFile(join(directory, "dist/index.js"), `export class MemoiaError extends Error {}
      export class MemoiaClient {
        async getProfiles() { return { profiles: [] }; }
        async importBlob() { process.exit(73); }
      }`);
    output = await open(receipt, "wx", 0o600);
    child = spawn(process.execPath, [fileURLToPath(new URL("../v2-sdk-probe.mjs", import.meta.url)), join(directory, "dist/index.js")],
      { stdio: ["pipe", output.fd, "pipe"], timeout: 10_000 });
    const finished = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code)); });
    child.stdin.end(JSON.stringify({ origin: `http://127.0.0.1:${server.address().port}`, token: "protected-fixture-token", deadline_ms: 5000 }));
    assert.equal(await finished, 73);
    await output.close(); output = undefined;
    const text = await readFile(receipt, "utf8");
    assert.doesNotMatch(text, /protected-fixture-token|Renata|risotto/);
    const records = text.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, "boundary");
    assert.equal(records[0].stage, "first_import.before");
    assert.equal(records[0].outcome_unknown, true);
    assert.ok(records[0].ids.user_id && records[0].ids.import_key && records[0].ids.late_import_key);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await output?.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true });
  }
});

test("CLI final result has a distinct kind even when input validation stops before mutation", async () => {
  const f = await fixture("complete", "0.2.3");
  let child;
  try {
    child = spawn(process.execPath, [fileURLToPath(new URL("../v2-sdk-probe.mjs", import.meta.url)), f.entry],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 });
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; });
    const finished = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code)); });
    child.stdin.end(JSON.stringify({ origin: "https://fixture.invalid", token: "protected-fixture-token", deadline_ms: 5000 }));
    assert.equal(await finished, 1);
    assert.doesNotMatch(text, /protected-fixture-token|Renata|risotto/);
    const records = text.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, "result");
    assert.equal(records[0].success, false);
    assert.equal(records[0].checks.sdk_version, false);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await f.close();
  }
});
