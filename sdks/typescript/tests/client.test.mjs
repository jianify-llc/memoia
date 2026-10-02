import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoiaClient, MemoiaError } from "../dist/index.js";

const user = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const eventId = "33333333-3333-4333-8333-333333333333";
const complete = { operation_id: "44444444-4444-4444-8444-444444444444", status: "completed", source_id: sourceId, external_id: "luvel:memory_store_logs:1", result: { event_ids: [eventId], profile_ids: [] }, error: null };
const source = { idempotency_key: "luvel:batch:1", external_id: "luvel:memory_store_logs:1", messages: [{ message_id: "1", role: "user", content: "Tokyo", occurred_at: "2026-10-02T00:00:00Z" }] };
const json = (body, status = 200) => Response.json(body, { status });
const client = (fetch, options = {}) => new MemoiaClient({ baseUrl: "https://memoia.example", apiKey: "private-project-token", fetch, ...options });

describe("fixed source identity and acknowledgement", () => {
  it("validates final UUID IDs and sends the origin-only v2 path", async () => {
    let sent;
    const api = client(async (url, init) => { sent = { url, init }; return json(complete); });
    assert.deepEqual(await api.importSource(user, source), complete);
    assert.equal(sent.url, `https://memoia.example/api/v2/users/${user}/sources`);
    assert.equal(sent.init.redirect, "error");
    assert.equal(sent.init.headers.Authorization, "Bearer private-project-token");
    assert.deepEqual(JSON.parse(sent.init.body), source);
  });

  it("does not turn processing or a legal event-free completion into an error", async () => {
    const pending = { ...complete, status: "processing", source_id: null, result: null };
    assert.equal((await client(async () => json(pending, 202)).importSource(user, source)).status, "processing");
    const empty = { ...complete, result: { event_ids: [], profile_ids: [] } };
    assert.deepEqual((await client(async () => json(empty)).importSource(user, source)).result.event_ids, []);
  });

  it("rejects malformed final IDs and impossible completed states as unknown writes", async () => {
    for (const broken of [
      { ...complete, result: null },
      { ...complete, source_id: null },
      { ...complete, result: { event_ids: ["blob-id"], profile_ids: [] } },
      { ...complete, result: { event_ids: null, profile_ids: [] } },
    ]) {
      await assert.rejects(client(async () => json(broken)).importSource(user, source), (error) => error.code === "INVALID_RESPONSE" && error.outcome === "unknown");
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
    await assert.rejects(api.importSource(user, source), (error) => error instanceof MemoiaError && error.outcome === "unknown");
    assert.deepEqual(await api.getOperationByKey(user, source.idempotency_key), complete);
    assert.deepEqual(methods, ["POST", "GET"]);
  });

  it("retries an explicit retryable rejection without changing the body or key", async () => {
    const bodies = [];
    const api = client(async (_url, init) => {
      bodies.push(init.body);
      return bodies.length === 1 ? json({ detail: { code: "PROVIDER_RATE_LIMIT", retryable: true } }, 429) : json(complete);
    });
    assert.equal((await api.importSource(user, source)).status, "completed");
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
  });

  it("does not retry parameter/auth failures even if the server requests it", async () => {
    for (const status of [400, 401, 403, 409, 422]) {
      let count = 0;
      await assert.rejects(client(async () => { count++; return json({ detail: { code: "DENIED", retryable: true } }, status); }).importSource(user, source));
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
    await assert.rejects(client(async () => { calls++; return json({ detail: "unexpected error" }, 500); }).importSource(user, source), (error) => error.outcome === "unknown");
    assert.equal(calls, 1);
  });

  it("preserves controlled missing-operation codes but not a missing API route", async () => {
    await assert.rejects(client(async () => json({ detail: { code: "operation_not_found", message: "Operation not found", retryable: false } }, 404)).getOperationByKey(user, "key"), (error) => error.status === 404 && error.code === "operation_not_found");
    await assert.rejects(client(async () => json({ detail: "Not Found" }, 404)).getOperationByKey(user, "key"), (error) => error.status === 404 && error.code === "HTTP_ERROR");
  });
});

describe("bounded transport", () => {
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
    await assert.rejects(api.importSource(user, source), (error) => error.outcome === "unknown");
    assert.equal(count, 1);
  });

  it("rejects endpoint paths/embedded credentials and invalid input before network I/O", async () => {
    for (const baseUrl of ["https://memoia.example/api/v2", "https://user:pass@memoia.example", "https://memoia.example/?key=secret"]) {
      assert.throws(() => new MemoiaClient({ baseUrl, apiKey: "secret" }), TypeError);
    }
    let count = 0;
    const api = client(async () => { count++; return json(complete); });
    await assert.rejects(async () => api.importSource(user, { ...source, idempotency_key: "" }), /INVALID_INPUT/);
    assert.equal(count, 0);
  });

  it("never includes provider bodies or the project key in returned errors", async () => {
    const api = client(async () => json({ detail: { code: "token private-project-token", message: "private content", retryable: false } }, 500));
    await assert.rejects(api.importSource(user, source), (error) => error.message === "Memoia request failed: HTTP_ERROR");
  });
});
