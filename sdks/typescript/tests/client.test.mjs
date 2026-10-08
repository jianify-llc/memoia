import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoiaClient, MemoiaError } from "../dist/index.js";

const user = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const eventId = "33333333-3333-4333-8333-333333333333";
const complete = { operation_id: "44444444-4444-4444-8444-444444444444", status: "completed", source_id: sourceId, blob_id: "55555555-5555-4555-8555-555555555555", result: { event_ids: [eventId], profile_ids: [] }, error: null };
const source = { idempotency_key: "luvel:batch:1", source_id: sourceId, messages: [{ message_id: "1", role: "user", content: "Tokyo", occurred_at: "2026-10-02T00:00:00Z" }] };
const json = (body, status = 200) => Response.json(body, { status });
const client = (fetch, options = {}) => new MemoiaClient({ baseUrl: "https://memoia.example", apiKey: "private-project-token", fetch, ...options });

describe("fixed Blob flush contract", () => {
  const progress = { operation_id: eventId, status: "pending", blob_ids: [complete.blob_id],
    attempts: 0, available_at: "2026-10-07T00:00:00Z", error: null, retryable: false };
  const maintenance = { pending_blob_count: 1, flushes: [progress] };
  const flush = { operation_id: eventId, kind: "flush", status: "processing", source_id: null,
    blob_id: null, result: null, error: null, flush: progress };
  it("accepts a fact-only receipt without waiting for or replaying derivatives", async () => {
    const factOnly = { ...complete, result: { event_ids: [], profile_ids: [], fact_ids: [eventId], memory_version: 7 } };
    let calls = 0;
    const api = client(async () => { calls++; return json(factOnly); });
    assert.deepEqual(await api.importBlob(user, source), factOnly);
    assert.equal(calls, 1);
  });

  it("queries progress separately, seals batches and retries the original flush", async () => {
    const calls = [];
    const api = client(async (url, init) => { calls.push({ url, init }); return json(init.method === "GET" ? maintenance : flush, init.method === "GET" ? 200 : 202); });
    assert.deepEqual(await api.getMaintenance(user), maintenance);
    assert.deepEqual(await api.flushUser(user, { idempotency_key: "batch-flush" }), flush);
    assert.deepEqual(await api.retryOperation(user, eventId), flush);
    assert.equal(calls[0].url, `https://memoia.example/api/users/${user}/maintenance`);
    assert.equal(calls[1].url, `https://memoia.example/api/users/${user}/flush`);
    assert.equal(calls[1].init.method, "POST");
    assert.deepEqual(JSON.parse(calls[1].init.body), { idempotency_key: "batch-flush" });
    assert.equal(calls[2].url, `https://memoia.example/api/users/${user}/operations/${eventId}/retry`);
  });

  it("rejects a retry acknowledgement for a different flush", async () => {
    const api = client(async () => json({ ...flush, operation_id: user }));
    await assert.rejects(api.retryOperation(user, eventId),
      (error) => error.code === "INVALID_RESPONSE" && error.outcome === "unknown");
  });

  it("preserves a retryable backoff error without declaring the original flush failed", async () => {
    const error = { code: "maintenance_lease_expired", retryable: true };
    const pending = { ...flush, error, flush: { ...progress, attempts: 1, error, retryable: true } };
    assert.deepEqual(await client(async () => json(pending)).getOperation(user, eventId), pending);
    const listed = { operations: [pending] };
    assert.deepEqual(await client(async () => json(listed)).listOperations(user), listed);
  });

  it("rejects contradictory terminal/progress states instead of accepting a phantom success", async () => {
    for (const invalid of [
      { ...flush, flush: { ...progress, status: "failed" } },
      { ...flush, status: "failed", error: { code: "maintenance_timeout", retryable: true } },
      { ...flush, status: "completed", result: { blob_ids: progress.blob_ids, profile_ids: [], event_ids: [] } },
      { ...flush, error: { code: "maintenance_capacity", retryable: false } },
    ]) {
      await assert.rejects(client(async () => json(invalid)).getOperation(user, eventId),
        error => error.code === "INVALID_RESPONSE" && error.outcome === "rejected");
    }
  });

  it("accepts empty completed flushes and rejects malformed user-scope receipts", async () => {
    const empty = { ...flush, status: "completed", result: { blob_ids: [], profile_ids: [], event_ids: [] },
      flush: { ...progress, status: "completed", blob_ids: [] } };
    assert.deepEqual(await client(async () => json(empty)).flushUser(user, { idempotency_key: "empty" }), empty);
    for (const invalid of [{ ...empty, source_id: sourceId }, { ...empty, flush: null },
      { ...empty, result: complete.result }]) {
      await assert.rejects(client(async () => json(invalid)).flushUser(user, { idempotency_key: "empty" }),
        error => error.code === "INVALID_RESPONSE" && error.outcome === "unknown");
    }
  });

  it("returns independent Fact hits with the legacy story expansion options", async () => {
    let posted;
    const response = { facts: [{ id: eventId, content: "Tokyo", score: .04, occurred_at: "2026-10-07T00:00:00Z",
      source_id: sourceId, blob_id: complete.blob_id, evidence: {
        fact_id: eventId, blob_id: complete.blob_id, content: "Tokyo", support_groups: [["1"]],
        certainty: "asserted", revision: 1, source_messages: [] } }], events: [], profiles: [] };
    const api = client(async (_url, init) => { posted = JSON.parse(init.body); return json(response); });
    assert.deepEqual(await api.search(user, "Tokyo", 5, { include_events: true, event_max_tokens: 800 }), response);
    assert.deepEqual(posted, { query: "Tokyo", limit: 5, include_events: true, event_max_tokens: 800 });
  });
});

describe("structured bounded search contract", () => {
  const evidence = { fact_id: eventId, blob_id: complete.blob_id, content: "Zhou cancelled hiking because of work.",
    support_groups: [["1"]], certainty: "asserted", source_messages: [] };
  const response = {
    facts: [{ id: eventId, content: evidence.content, source_id: sourceId, blob_id: complete.blob_id,
      score: .04, occurred_at: "2026-10-07T00:00:00Z", evidence }],
    events: [{ id: sourceId, content: "The hiking plan changed after Zhou had to work.", source_id: null,
      blob_id: null, score: .04, occurred_at: "2026-10-07T00:00:00Z", title: "Cancelled hiking",
      summary: "Work prevented the planned trip.", keywords: "hiking, work", time: "Saturday", location: null,
      interpretation: null, fact_ids: [eventId], evidence: [evidence] }],
    profiles: [{ id: complete.blob_id, content: "Zhou is the user's colleague.", topic: "relationships",
      sub_topic: "Zhou", fact_ids: [eventId], source_ids: [sourceId], score: .04,
      created_at: "2026-10-07T00:00:00Z", updated_at: "2026-10-07T00:00:00Z" }],
  };
  it("preserves all three object classes and sends strict ID exclusions only in a private POST", async () => {
    const calls = [];
    const api = client(async (url, init) => { calls.push({ url, init }); return json(response); });
    const options = { max_token_size: 1500, exclude_fact_ids: [eventId], exclude_event_ids: [sourceId],
      exclude_profile_ids: [complete.blob_id], deadline: Date.now() + 5_000, signal: new AbortController().signal };
    assert.deepEqual(await api.search(user, "Why was hiking cancelled?", 5, options), response);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://memoia.example/api/users/${user}/search`);
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].init.body), { query: "Why was hiking cancelled?", limit: 5,
      max_token_size: 1500, exclude_fact_ids: [eventId], exclude_event_ids: [sourceId], exclude_profile_ids: [complete.blob_id] });
  });

  for (const field of ["exclude_fact_ids", "exclude_event_ids", "exclude_profile_ids"]) {
    it(`${field} rejects malformed IDs and more than 500 entries without any request`, async () => {
      let calls = 0;
      const api = client(async () => { calls++; return json(response); });
      for (const value of [["not-a-uuid"], Array(501).fill(eventId), null, eventId]) {
        assert.throws(() => api.search(user, "hiking", 5, { [field]: value }),
          (error) => error.code === "INVALID_INPUT" && error.outcome === "rejected");
      }
      assert.equal(calls, 0);
      await api.search(user, "hiking", 5, { [field]: Array(500).fill(eventId) });
      assert.equal(calls, 1);
    });
  }

  it("rejects out-of-range budgets locally while retaining server defaults and both valid bounds", async () => {
    const bodies = [];
    const api = client(async (_url, init) => { bodies.push(JSON.parse(init.body)); return json({ facts: [], events: [], profiles: [] }); });
    for (const max_token_size of [0, 10001, -1, 1.5, null, "4000"]) {
      assert.throws(() => api.search(user, "hiking", 5, { max_token_size }), (error) => error.code === "INVALID_INPUT");
    }
    assert.equal(bodies.length, 0);
    for (const max_token_size of [1, 10000]) await api.search(user, "hiking", 5, { max_token_size });
    await api.search(user, "hiking");
    assert.deepEqual(bodies, [{ query: "hiking", limit: 5, max_token_size: 1 },
      { query: "hiking", limit: 5, max_token_size: 10000 }, { query: "hiking", limit: 10 }]);
  });

  it("filters Profile topics through the generated contract without limiting Fact or Event identity", async () => {
    const bodies = [];
    const api = client(async (_url, init) => { bodies.push(JSON.parse(init.body)); return json(response); });
    for (const exclude_profile_topics of [[""], ["x".repeat(257)], Array(51).fill("basic_info"), null]) {
      assert.throws(() => api.search(user, "hiking", 5, { exclude_profile_topics }),
        (error) => error.code === "INVALID_INPUT");
    }
    assert.equal(bodies.length, 0);
    assert.deepEqual(await api.search(user, "hiking", 5, { exclude_profile_topics: ["basic_info"] }), response);
    await api.search(user, "hiking", 5, { exclude_profile_topics: Array(50).fill("x".repeat(256)) });
    assert.deepEqual(bodies[0], { query: "hiking", limit: 5, exclude_profile_topics: ["basic_info"] });
    assert.equal(bodies.length, 2);
  });

  it("validates Profile identity and rejects invented extra fields instead of treating them as Facts", async () => {
    for (const profile of [{ ...response.profiles[0], id: "bad-id" },
      { ...response.profiles[0], fact_ids: ["bad-id"] }, { ...response.profiles[0], revision: 9 }]) {
      await assert.rejects(client(async () => json({ ...response, profiles: [profile] })).search(user, "hiking"),
        (error) => error.code === "INVALID_RESPONSE" && error.outcome === "rejected");
    }
    for (const field of ["facts", "events", "profiles"]) {
      const partial = { ...response };
      delete partial[field];
      await assert.rejects(client(async () => json(partial)).search(user, "hiking"),
        (error) => error.code === "INVALID_RESPONSE" && error.outcome === "rejected");
    }
  });
});

describe("event time evidence contract", () => {
  it("sends source timezone and keeps it distinct from event dates", async () => {
    let posted;
    const api = client(async (_url, init) => { posted = JSON.parse(init.body); return json({ ...complete, source_id: posted.source_id }); });
    const input = { idempotency_key: "time-import", source_id: "dialog-1", messages: [
      { message_id: "1", role: "user", content: "去年四月住京都", occurred_at: "2026-01-01T00:30:00+08:00", time_zone: "Asia/Shanghai" },
    ] };
    await api.importBlob(user, input);
    assert.deepEqual(posted, input);
  });

  it("preserves precision, original time expression and source recording evidence", async () => {
    const evidence = { fact_id: eventId, blob_id: complete.blob_id, content: "Kyoto hotel", topic: "life_event", sub_topic: "travel", support_groups: [["1"]],
      event_time: { start: "2025-04-01", end: "2025-04-30", precision: "month", evidence: [{ message_id: "1", expression: "去年四月" }] },
      source_messages: [{ message_id: "1", recorded_at: "2026-01-01T00:30:00+08:00", time_zone: "Asia/Shanghai" }] };
    const body = { facts: [], profiles: [], events: [{ id: eventId, content: "Kyoto hotel", source_id: "dialog-1", blob_id: complete.blob_id,
      score: .03, occurred_at: "2026-01-01T00:30:00+08:00", evidence: [evidence] }] };
    const api = client(async () => json(body));
    assert.deepEqual(await api.search(user, "Kyoto hotel 2025-04"), body);
    evidence.event_time.start = "invented-date";
    await assert.rejects(api.search(user, "Kyoto"), (error) => error instanceof MemoiaError);
  });
});

describe("fixed source identity and acknowledgement", () => {
  it("queries the server-owned Blob separately and deletes messages with a fixed key", async () => {
    const blob = { blob_id: complete.blob_id, source_id: "dialog-1", status: "active", message_ids: ["1"], event_ids: [eventId], created_at: "2026-10-02T00:00:00Z" };
    const deletion = { idempotency_key: "delete-1", message_ids: ["1"] };
    const calls = [];
    const api = client(async (url, init) => {
      calls.push({ url, init });
      return json(init.method === "GET" ? blob : { ...complete, source_id: "dialog-1", blob_id: null });
    });
    assert.deepEqual(await api.getBlob(user, complete.blob_id), blob);
    assert.equal((await api.deleteMessages(user, "dialog-1", deletion)).status, "completed");
    assert.equal(calls[0].url, `https://memoia.example/api/users/${user}/blobs/${complete.blob_id}`);
    assert.equal(calls[1].url, `https://memoia.example/api/users/${user}/sources/dialog-1/messages`);
    assert.equal(calls[1].init.method, "DELETE");
    assert.deepEqual(JSON.parse(calls[1].init.body), deletion);
  });

  it("does not replay a message deletion with a lost acknowledgement", async () => {
    let calls = 0;
    const api = client(async () => { calls++; throw new TypeError("connection closed"); });
    await assert.rejects(api.deleteMessages(user, "dialog-1", { idempotency_key: "d", message_ids: ["1"] }),
      (error) => error.outcome === "unknown");
    assert.equal(calls, 1);
  });

  it("rejects valid-shaped acknowledgements for another source or blob", async () => {
    const wrong = { ...complete, source_id: "another-dialog" };
    await assert.rejects(client(async () => json(wrong)).importBlob(user, source),
      (error) => error.code === "INVALID_RESPONSE" && error.outcome === "unknown");
    await assert.rejects(client(async () => json(wrong)).deleteMessages(user, sourceId,
      { idempotency_key: "d", message_ids: ["1"] }),
      (error) => error.code === "INVALID_RESPONSE" && error.outcome === "unknown");
    const blob = { blob_id: eventId, source_id: sourceId, status: "active", message_ids: ["1"], event_ids: [], created_at: "2026-10-02T00:00:00Z" };
    await assert.rejects(client(async () => json(blob)).getBlob(user, complete.blob_id),
      (error) => error.code === "INVALID_RESPONSE");
  });

  it("validates final UUID IDs and sends the unversioned origin path", async () => {
    let sent;
    const api = client(async (url, init) => { sent = { url, init }; return json(complete); });
    assert.deepEqual(await api.importBlob(user, source), complete);
    assert.equal(sent.url, `https://memoia.example/api/users/${user}/blobs`);
    assert.equal(sent.init.redirect, "manual");
    assert.equal(sent.init.headers.Authorization, "Bearer private-project-token");
    assert.deepEqual(JSON.parse(sent.init.body), source);
  });

  it("does not turn processing or a legal event-free completion into an error", async () => {
    const pending = { ...complete, status: "processing", result: null };
    assert.equal((await client(async () => json(pending, 202)).importBlob(user, source)).status, "processing");
    const empty = { ...complete, result: { event_ids: [], profile_ids: [] } };
    assert.deepEqual((await client(async () => json(empty)).importBlob(user, source)).result.event_ids, []);
  });

  it("rejects malformed final IDs and impossible completed states as unknown writes", async () => {
    for (const broken of [
      { ...complete, result: null },
      { ...complete, source_id: null },
      { ...complete, result: { event_ids: ["blob-id"], profile_ids: [] } },
      { ...complete, result: { event_ids: null, profile_ids: [] } },
    ]) {
      await assert.rejects(client(async () => json(broken)).importBlob(user, source), (error) => error.code === "INVALID_RESPONSE" && error.outcome === "unknown");
    }
  });

  it("does not replay after timeout/lost acknowledgement, then queries by the same key", async () => {
    const methods = [];
    const api = client(async (url, init) => {
      methods.push(init.method);
      if (init.method === "POST") throw new TypeError("connection closed");
      assert.match(url, /operations\/by-key\/luvel%3Abatch%3A1$/);
      return json(complete);
    });
    await assert.rejects(api.importBlob(user, source), (error) => error instanceof MemoiaError && error.outcome === "unknown");
    assert.deepEqual(await api.getOperationByKey(user, source.idempotency_key), complete);
    assert.deepEqual(methods, ["POST", "GET"]);
  });

  it("leaves retryable write recovery to its caller without replaying the body", async () => {
    let calls = 0;
    const api = client(async () => { calls++; return json({ detail: { code: "PROVIDER_RATE_LIMIT", retryable: true } }, 429); });
    await assert.rejects(api.importBlob(user, source), error => error.retryable && error.outcome === "rejected");
    assert.equal(calls, 1);
  });

  it("preserves recoverable ownership conflicts with one attempt, then resumes the durable operation", async () => {
    for (const code of ["lease_lost", "write_conflict"]) {
      const calls = [];
      const failed = { ...complete, status: "failed", result: null, error: { code, retryable: true } };
      const api = client(async (url, init) => {
        calls.push({ path: new URL(url).pathname, method: init.method, body: init.body });
        if (calls.length === 1) return json({ detail: { code, retryable: true } }, 409);
        if (init.method === "GET") return json(failed);
        return json(complete);
      }, { maxAttempts: 1 });
      await assert.rejects(api.importBlob(user, source), (error) =>
        error instanceof MemoiaError && error.status === 409 && error.code === code &&
        error.retryable === true && error.outcome === "rejected");
      assert.equal(calls.length, 1);
      const operation = await api.getOperationByKey(user, source.idempotency_key);
      assert.deepEqual(operation, failed);
      assert.deepEqual(await api.retryOperation(user, operation.operation_id), complete);
      assert.deepEqual(calls.map(({ method }) => method), ["POST", "GET", "POST"]);
      assert.match(calls[1].path, /operations\/by-key\/luvel%3Abatch%3A1$/);
      assert.match(calls[2].path, /operations\/44444444-4444-4444-8444-444444444444\/retry$/);
      assert.equal(calls[2].body, undefined);
    }
  });

  it("preserves recoverable conflicts without implicitly replaying writes", async () => {
    for (const code of ["lease_lost", "write_conflict"]) {
      const bodies = [];
      const api = client(async (_url, init) => { bodies.push(init.body); return json({ detail: { code, retryable: true } }, 409); }, { maxAttempts: 2 });
      await assert.rejects(api.importBlob(user, source), error => error.retryable && error.outcome === "rejected");
      assert.equal(bodies.length, 1);
      assert.deepEqual(JSON.parse(bodies[0]), source);
    }
  });

  it("does not treat other conflicts or non-retryable ownership failures as replay permission", async () => {
    for (const detail of [
      { code: "lease_lost", retryable: false },
      { code: "write_conflict", retryable: false },
      { code: "idempotency_conflict", retryable: true },
      { code: "source_conflict", retryable: true },
      undefined,
    ]) {
      let count = 0;
      const api = client(async () => { count++; return json(detail === undefined ? {} : { detail }, 409); });
      await assert.rejects(api.importBlob(user, source), (error) =>
        error instanceof MemoiaError && error.status === 409 && error.retryable === false);
      assert.equal(count, 1);
    }
  });

  it("does not retry parameter/auth failures even if the server requests it", async () => {
    for (const status of [400, 401, 403, 409, 422]) {
      let count = 0;
      await assert.rejects(client(async () => { count++; return json({ detail: { code: "DENIED", retryable: true } }, status); }).importBlob(user, source));
      assert.equal(count, 1);
    }
  });

  it("resumes accepted work without sending a reconstructed source body", async () => {
    const api = client(async (url, init) => {
      assert.match(url, /operations\/44444444-4444-4444-8444-444444444444\/retry$/);
      assert.equal(init.method, "POST");
      assert.equal(init.body, undefined);
      return json(complete);
    });
    assert.equal((await api.retryOperation(user, complete.operation_id)).status, "completed");
  });

  it("does not misclassify an unstructured server failure as a rejected write", async () => {
    let calls = 0;
    await assert.rejects(client(async () => { calls++; return json({ detail: "unexpected error" }, 500); }).importBlob(user, source), (error) => error.outcome === "unknown");
    assert.equal(calls, 1);
  });

  it("preserves controlled missing-operation codes but not a missing API route", async () => {
    await assert.rejects(client(async () => json({ detail: { code: "operation_not_found", message: "Operation not found", retryable: false } }, 404)).getOperationByKey(user, "key"), (error) => error.status === 404 && error.code === "operation_not_found");
    await assert.rejects(client(async () => json({ detail: "Not Found" }, 404)).getOperationByKey(user, "key"), (error) => error.status === 404 && error.code === "HTTP_ERROR");
  });
});

describe("permanent account forgetting", () => {
  it("requires a bodyless DELETE and accepts an explicit repeat with the same UUID", async () => {
    const receipt = { user_id: user, forgotten: true };
    const calls = [];
    const api = client(async (url, init) => {
      calls.push({ url, init });
      return json(receipt);
    });
    assert.deepEqual(await api.forgetUser(user, { deadline: Date.now() + 30_000 }), receipt);
    assert.deepEqual(await api.forgetUser(user), receipt);
    assert.equal(calls.length, 2);
    for (const { url, init } of calls) {
      assert.equal(url, `https://memoia.example/api/users/${user}`);
      assert.equal(init.method, "DELETE");
      assert.equal(init.body, undefined);
      assert.equal(init.headers["Content-Type"], undefined);
      assert.equal(init.headers.Authorization, "Bearer private-project-token");
      assert.equal(init.redirect, "manual");
    }
  });

  it("compares UUID identity independently of letter casing", async () => {
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const receipt = { user_id: id, forgotten: true };
    assert.deepEqual(await client(async () => json(receipt)).forgetUser(id.toUpperCase()), receipt);
  });

  it("rejects invalid UUID input before starting a destructive request", async () => {
    let calls = 0;
    const api = client(async () => { calls++; return json({ user_id: user, forgotten: true }); });
    for (const id of ["", "not-a-user-uuid", `${user}/sources`, 42, null]) {
      await assert.rejects(async () => api.forgetUser(id), (error) => error.code === "INVALID_INPUT" && error.outcome === "rejected");
    }
    assert.equal(calls, 0);
  });

  it("does not accept false, incomplete, foreign or malformed forgetting receipts", async () => {
    for (const receipt of [
      { user_id: sourceId, forgotten: true },
      { user_id: "not-a-uuid", forgotten: true },
      { user_id: user, forgotten: false },
      { user_id: user, forgotten: "true" },
      { user_id: user, forgotten: 1 },
      { user_id: user },
      { forgotten: true },
      { user_id: user, forgotten: true, unexpected: "private data" },
      null,
    ]) {
      let calls = 0;
      await assert.rejects(client(async () => { calls++; return json(receipt); }).forgetUser(user), (error) =>
        error instanceof MemoiaError && error.code === "INVALID_RESPONSE" && error.outcome === "unknown" && error.retryable === false);
      assert.equal(calls, 1);
    }
    for (const status of [201, 202, 204]) {
      let calls = 0;
      const api = client(async () => {
        calls++;
        return status === 204 ? new Response(null, { status }) : json({ user_id: user, forgotten: true }, status);
      });
      await assert.rejects(api.forgetUser(user), (error) => error.code === "INVALID_RESPONSE" && error.status === status && error.outcome === "unknown");
      assert.equal(calls, 1);
    }
  });

  it("retains an unknown DELETE without replay and lets the caller explicitly confirm it", async () => {
    let calls = 0;
    const receipt = { user_id: user, forgotten: true };
    const api = client(async () => {
      calls++;
      if (calls === 1) throw new Error("lost forgetting acknowledgment");
      return json(receipt);
    }, { maxAttempts: 4 });
    await assert.rejects(api.forgetUser(user), (error) => error.code === "TRANSPORT_ERROR" && error.outcome === "unknown" && error.retryable === false);
    assert.equal(calls, 1);
    assert.deepEqual(await api.forgetUser(user), receipt);
    assert.equal(calls, 2);
  });

  it("bounds a hung DELETE and refuses expired or cancelled requests before I/O", async () => {
    let calls = 0;
    const api = client((_url, { signal }) => new Promise((_resolve, reject) => {
      calls++;
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }), { writeTimeoutMs: 15 });
    await assert.rejects(api.forgetUser(user), (error) => error.outcome === "unknown" && error.retryable === false);
    assert.equal(calls, 1);
    await assert.rejects(api.forgetUser(user, { deadline: Date.now() - 1 }), /BUDGET_EXHAUSTED/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(api.forgetUser(user, { signal: controller.signal }), /BUDGET_EXHAUSTED/);
    assert.equal(calls, 1);
  });

  it("does not replay unauthorized forgetting or permanently rejected future imports", async () => {
    for (const status of [401, 403]) {
      let calls = 0;
      await assert.rejects(client(async () => { calls++; return json({ detail: { code: "DENIED", retryable: true } }, status); }).forgetUser(user), (error) =>
        error.status === status && error.retryable === false && error.outcome === "rejected");
      assert.equal(calls, 1);
    }
    for (const action of ["import", "retry"]) {
      let calls = 0;
      const api = client(async () => { calls++; return json({ detail: { code: "user_forgotten", retryable: false } }, 410); });
      await assert.rejects(action === "import" ? api.importBlob(user, source) : api.retryOperation(user, complete.operation_id), (error) =>
        error.code === "user_forgotten" && error.status === 410 && error.retryable === false && error.outcome === "rejected");
      assert.equal(calls, 1);
    }
  });
});

describe("bounded transport", () => {
  it("rejects redirects without replaying or exposing the destination", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      for (const method of ["GET", "POST", "DELETE"]) {
        let calls = 0;
        const api = client(async (_url, init) => {
          calls++;
          assert.equal(init.redirect, "manual");
          return new Response("private response", { status, headers: { Location: "https://other.example/?secret=private-project-token" } });
        });
        const request = method === "GET" ? api.getProfiles(user) : method === "DELETE" ? api.forgetUser(user) : api.importBlob(user, source);
        await assert.rejects(request, (error) =>
          error instanceof MemoiaError && error.code === "REDIRECT_REJECTED" &&
          error.status === status && error.retryable === false &&
          error.outcome === (method === "GET" ? "rejected" : "unknown") &&
          !error.message.includes("private-project-token") && !error.message.includes("other.example"));
        assert.equal(calls, 1);
      }
    }
  });

  it("calls fetch as a function without supplying the client as its receiver", async () => {
    let calls = 0;
    const api = client(async function (_url, init) {
      assert.equal(this, undefined);
      calls++;
      assert.equal(init.method, "GET");
      return json(complete);
    });
    assert.deepEqual(await api.getOperationByKey(user, source.idempotency_key), complete);
    assert.equal(calls, 1);
  });

  it("preserves an explicitly bound custom transport owner", async () => {
    const owner = {
      calls: 0,
      async fetch() { this.calls++; return json(complete); },
    };
    assert.deepEqual(await client(owner.fetch.bind(owner)).getOperationByKey(user, "key"), complete);
    assert.equal(owner.calls, 1);
  });

  it("validates project/key creation responses and handles bodyless revocation", async () => {
    const project = { project_id: "luvel-test", status: "active", created_at: "2026-10-02T00:00:00Z" };
    const issued = { key_id: eventId, name: "Luvel", scopes: ["read", "write"], expires_at: null, revoked_at: null, created_at: project.created_at, token: "one-time-token" };
    const calls = [];
    const api = client(async (url, init) => {
      calls.push([new URL(url).pathname, init.method]);
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      return json(url.endsWith("/keys") ? issued : project, 201);
    });
    assert.deepEqual(await api.createProject({ project_id: "luvel-test" }), project);
    assert.deepEqual(await api.createKey("luvel-test", { name: "Luvel", scopes: ["read", "write"] }), issued);
    assert.equal(await api.revokeKey("luvel-test", eventId), undefined);
    assert.deepEqual(calls.map((call) => call[1]), ["POST", "POST", "DELETE"]);
    await assert.rejects(async () => api.createKey("luvel-test", { name: "bad", scopes: ["root"] }), /INVALID_INPUT/);
  });

  it("does not replay project/key mutations with a lost acknowledgement", async () => {
    let count = 0;
    const api = client(async () => { count++; throw new Error("lost acknowledgement"); });
    await assert.rejects(api.createKey("luvel-test", { name: "Luvel", scopes: ["read"] }), (error) => error.outcome === "unknown");
    assert.equal(count, 1);
  });

  it("uses server-defined pagination without accidentally dropping older sources", async () => {
    const api = client(async (url) => {
      assert.equal(new URL(url).search, "?limit=20&offset=40");
      return json({ sources: [] });
    });
    assert.deepEqual(await api.listSources(user, { limit: 20, offset: 40 }), { sources: [] });
    await assert.rejects(async () => api.listSources(user, { limit: 101 }), /INVALID_INPUT/);
    await assert.rejects(async () => api.getHistory(user, { offset: -1 }), /INVALID_INPUT/);
  });

  it("validates recoverable operation listings with the same completion invariants", async () => {
    assert.deepEqual(await client(async () => json({ operations: [complete] })).listOperations(user), { operations: [complete] });
    await assert.rejects(client(async () => json({ operations: [{ ...complete, result: null }] })).listOperations(user), /INVALID_RESPONSE/);
  });

  it("validates actual profile revision snapshots and diffs, not operation-status placeholders", async () => {
    const profile = { id: eventId, content: "Lives in Tokyo", topic: "basic_info", sub_topic: "residence", source_ids: [sourceId], fact_ids: [eventId] };
    const history = { entries: [{ revision_id: eventId, operation_id: complete.operation_id, source_id: sourceId, created_at: "2026-10-02T00:00:00Z", profiles: [profile], added: [profile], removed: [] }] };
    assert.deepEqual(await client(async () => json(history)).getHistory(user), history);
    await assert.rejects(client(async () => json({ entries: [{ operation_id: complete.operation_id, kind: "import", status: "completed" }] })).getHistory(user), /INVALID_RESPONSE/);
  });

  it("does not start I/O after the caller's budget or cancellation", async () => {
    let count = 0;
    const api = client(async () => { count++; return json(complete); });
    await assert.rejects(api.getOperationByKey(user, "key", { deadline: Date.now() - 1 }), /BUDGET_EXHAUSTED/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(api.getOperationByKey(user, "key", { signal: controller.signal }), /BUDGET_EXHAUSTED/);
    assert.equal(count, 0);
  });

  it("stops a hung mutation at its timeout without starting another attempt", async () => {
    let count = 0;
    const api = client((_url, { signal }) => new Promise((_resolve, reject) => { count++; signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }), { writeTimeoutMs: 15 });
    await assert.rejects(api.importBlob(user, source), (error) => error.outcome === "unknown");
    assert.equal(count, 1);
  });

  it("rejects endpoint paths/embedded credentials and invalid input before network I/O", async () => {
    for (const baseUrl of ["https://memoia.example/api", "https://user:pass@memoia.example", "https://memoia.example/?key=secret"]) {
      assert.throws(() => new MemoiaClient({ baseUrl, apiKey: "secret" }), TypeError);
    }
    let count = 0;
    const api = client(async () => { count++; return json(complete); });
    await assert.rejects(async () => api.importBlob(user, { ...source, idempotency_key: "" }), /INVALID_INPUT/);
    assert.equal(count, 0);
  });

  it("never includes provider bodies or the project key in returned errors", async () => {
    const api = client(async () => json({ detail: { code: "token private-project-token", message: "private content", retryable: false } }, 500));
    await assert.rejects(api.importBlob(user, source), (error) => error.message === "Memoia request failed: HTTP_ERROR");
  });
});


describe("single API private read contract", () => {
  it("sends query text only in POST bodies to search and context", async () => {
    const calls = [];
    const query = "not April 2025, April 2026 before the trip";
    const api = client(async (url, init) => {
      calls.push({ url, method: init.method, body: JSON.parse(init.body) });
      return json(url.endsWith("/context") ? { context: "Kyoto\n[Time evidence]", entries: ["Kyoto\n[Time evidence]"] } : { facts: [], events: [], profiles: [] });
    });
    await api.search(user, query, 3);
    assert.deepEqual(await api.getContext(user, { query, max_token_size: 500 }), { context: "Kyoto\n[Time evidence]", entries: ["Kyoto\n[Time evidence]"] });
    assert.deepEqual(calls, [
      { url: `https://memoia.example/api/users/${user}/search`, method: "POST", body: { query, limit: 3 } },
      { url: `https://memoia.example/api/users/${user}/context`, method: "POST", body: { query, max_token_size: 500 } },
    ]);
  });
  it("read-only POST uses read timeout and outcome classification, never a write replay", async () => {
    let calls = 0;
    const api = client(async (_url, init) => { calls++; return new Promise((_resolve, reject) =>
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })); },
      { readTimeoutMs: 10, writeTimeoutMs: 1000, maxAttempts: 1 });
    await assert.rejects(api.getContext(user, { query: "private" }), error => error instanceof MemoiaError && error.outcome === "rejected");
    assert.equal(calls, 1);
  });
  it("requires valid typed management acknowledgements", async () => {
    const id = { id: user };
    assert.deepEqual(await client(async () => json(id, 201)).createUser({ id: user }), id);
    await assert.rejects(client(async () => json({ errno: 0, data: id })).createUser({ id: user }), error => error.outcome === "unknown");
    assert.equal(await client(async () => new Response(null, { status: 204 })).updateConfig({ profile_config: "" }), undefined);
    await assert.rejects(client(async () => json(false)).updateConfig({ profile_config: "" }), error => error.outcome === "unknown");
  });
});

describe("single writer and complete context entries", () => {
  it("never replays unkeyed profile creation after a generic 500", async () => {
    let calls = 0;
    const api = client(async () => { calls++; return calls === 1
      ? json({ detail: { code: "internal_error", retryable: true } }, 500)
      : json({ id: eventId }, 201); }, { maxAttempts: 2 });
    await assert.rejects(api.addProfile(user, { content: "Kyoto", topic: "travel", sub_topic: "hotel" }),
      error => error.code === "internal_error" && error.outcome === "unknown");
    assert.equal(calls, 1);
  });
  it("requires ordered complete entries in the context contract", async () => {
    await assert.rejects(client(async () => json({ context: "old string only" })).getContext(user, { query: "Kyoto" }),
      error => error.code === "INVALID_RESPONSE");
    const entries = ["Kyoto\n[time/source evidence]", "Another complete fact"];
    assert.deepEqual(await client(async () => json({ context: entries.join("\n\n"), entries })).getContext(user, { query: "Kyoto" }),
      { context: entries.join("\n\n"), entries });
    await assert.rejects(client(async () => json({ context: "different text", entries })).getContext(user, { query: "Kyoto" }),
      error => error.code === "INVALID_RESPONSE");
  });
  it("retries a transient read-only POST without changing the query", async () => {
    const calls = [];
    const api = client(async (_url, init) => {
      calls.push({ method: init.method, body: init.body });
      return calls.length === 1 ? json({ detail: { code: "unavailable", retryable: true } }, 503)
        : json({ context: "", entries: [] });
    }, { maxAttempts: 2 });
    assert.deepEqual(await api.getContext(user, { query: "Kyoto", max_token_size: 1500 }), { context: "", entries: [] });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
    assert.equal(calls[0].method, "POST");
  });
});
