import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, Response as RuntimeResponse, convertV4MiniflareOptions } from "miniflare";

const userId = "11111111-1111-4111-8111-111111111111";
const origin = "https://memoia.invalid";
const apiKey = "isolated-placeholder-token";
const forgetUsers = Object.fromEntries([
  "normal-default-forget", "normal-native-forget", "normal-wrapped-forget", "normal-bound-forget",
  "redirect-302-forget", "redirect-307-forget", "redirect-308-forget",
  "unknown-response-forget", "unknown-transport-forget",
].map((marker, index) => [marker, `66666666-6666-4666-8666-${String(index + 1).padStart(12, "0")}`]));
const forgetMarkers = Object.fromEntries(Object.entries(forgetUsers).map(([marker, id]) => [id, marker]));
const complete = (externalId) => ({
  operation_id: "22222222-2222-4222-8222-222222222222",
  status: "completed",
  source_id: "33333333-3333-4333-8333-333333333333",
  external_id: externalId,
  result: { event_ids: [], profile_ids: [] },
  error: null,
});
const json = (value, status = 200) => new RuntimeResponse(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json" },
});
const calls = [];
let runtime;

before(async () => {
  const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  const bundle = await build({
    stdin: {
      sourcefile: "memoia-workerd-probe.js",
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
      contents: `
import { MemoiaClient } from ${JSON.stringify(entry)};
export default {
  async fetch(request) {
    const query = new URL(request.url).searchParams;
    const marker = query.get("marker");
    const action = query.get("action");
    const mode = query.get("mode");
    const options = {
      baseUrl: ${JSON.stringify(origin)}, apiKey: ${JSON.stringify(apiKey)},
      maxAttempts: 4, readTimeoutMs: 2000,
      writeTimeoutMs: marker.startsWith("unknown-transport") ? 100 : 2000,
    };
    if (mode === "native") options.fetch = fetch;
    if (mode === "wrapped") options.fetch = (input, init) => fetch(input, init);
    if (mode === "bound") options.fetch = fetch.bind(globalThis);
    const client = new MemoiaClient(options);
    try {
      const value = action === "read"
        ? await client.getOperationByKey(${JSON.stringify(userId)}, marker)
        : action === "forget"
        ? await client.forgetUser(${JSON.stringify(forgetUsers)}[marker])
        : await client.importSource(${JSON.stringify(userId)}, {
            idempotency_key: "probe:" + marker,
            external_id: "probe:" + marker,
            messages: [{
              message_id: "1", role: "user",
              content: "never-forward-body:" + marker,
              occurred_at: "2026-10-03T00:00:00Z",
            }],
          });
      return Response.json({ ok: true, value });
    } catch (error) {
      return Response.json({
        ok: false, name: error.name, code: error.code,
        status: error.status, retryable: error.retryable,
        outcome: error.outcome, message: error.message,
      });
    }
  },
};`,
    },
    bundle: true,
    write: false,
    platform: "browser",
    target: "es2022",
    format: "esm",
  });
  runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-03-02",
    compatibilityFlags: ["nodejs_compat"],
    telemetry: { enabled: false },
    cf: false,
    outboundService: async (request) => {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.text() : "";
      const input = body ? JSON.parse(body) : null;
      const pathId = decodeURIComponent(url.pathname.split("/").at(-1));
      const marker = input
        ? input.external_id.slice("probe:".length)
        : forgetMarkers[pathId] ?? pathId;
      calls.push({
        marker, origin: url.origin, method: request.method,
        path: url.pathname, body,
        authorization: request.headers.get("authorization"),
        cacheControl: request.headers.get("cache-control"),
        pragma: request.headers.get("pragma"),
      });
      if (marker.startsWith("redirect-")) {
        const status = Number(marker.split("-")[1]);
        return new RuntimeResponse(null, {
          status,
          headers: { Location: "https://must-not-follow.invalid/captured?private=fixture" },
        });
      }
      if (marker.startsWith("unknown-response")) {
        return new RuntimeResponse("invalid JSON", { status: 502 });
      }
      if (marker.startsWith("unknown-transport")) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return request.method === "DELETE" ? json({ user_id: pathId, forgotten: true }) : json(complete(input.external_id));
      }
      if (request.method === "GET") {
        return json({ detail: { code: "operation_not_found", message: "not found", retryable: false } }, 404);
      }
      if (request.method === "DELETE") return json({ user_id: pathId, forgotten: true });
      return json(complete(input.external_id));
    },
  }));
  await runtime.ready;
});

after(async () => {
  await runtime?.dispose();
});

async function probe(marker, action, mode = "default") {
  const response = await runtime.dispatchFetch(`http://localhost/probe?${new URLSearchParams({ marker, action, mode })}`);
  assert.equal(response.status, 200);
  return response.json();
}

function received(marker) {
  return calls.filter((call) => call.marker === marker);
}

function assertOriginOnly() {
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call.origin === origin), "A redirect must never forward credentials or a message body to another host");
}

describe("Memoia SDK in the real workerd runtime", { concurrency: false }, () => {
  for (const mode of ["default", "native", "wrapped", "bound"]) {
    it(`uses ${mode} fetch without changing its receiver and preserves a real GET 404`, async () => {
      const marker = `normal-${mode}-read`;
      const result = await probe(marker, "read", mode);
      assert.deepEqual(result, {
        ok: false, name: "MemoiaError", code: "operation_not_found", status: 404,
        retryable: false, outcome: "rejected", message: "Memoia request failed: operation_not_found",
      });
      const [call] = received(marker);
      assert.equal(received(marker).length, 1);
      assert.equal(call.method, "GET");
      assert.equal(call.body, "");
      assert.equal(call.authorization, `Bearer ${apiKey}`);
      assert.equal(call.cacheControl, "no-cache");
      assert.equal(call.pragma, "no-cache");
      assertOriginOnly();
    });

    it(`uses ${mode} fetch to validate the final POST receipt`, async () => {
      const marker = `normal-${mode}-write`;
      const result = await probe(marker, "write", mode);
      assert.deepEqual(result, { ok: true, value: complete(`probe:${marker}`) });
      const [call] = received(marker);
      assert.equal(received(marker).length, 1);
      assert.equal(call.method, "POST");
      assert.equal(call.authorization, `Bearer ${apiKey}`);
      assert.equal(JSON.parse(call.body).messages[0].content, `never-forward-body:${marker}`);
      assertOriginOnly();
    });

    it(`uses ${mode} fetch for a bodyless permanent account DELETE`, async () => {
      const marker = `normal-${mode}-forget`;
      const result = await probe(marker, "forget", mode);
      assert.deepEqual(result, { ok: true, value: { user_id: forgetUsers[marker], forgotten: true } });
      const [call] = received(marker);
      assert.equal(received(marker).length, 1);
      assert.equal(call.method, "DELETE");
      assert.equal(call.path, `/api/v2/users/${forgetUsers[marker]}`);
      assert.equal(call.body, "");
      assert.equal(call.authorization, `Bearer ${apiKey}`);
      assertOriginOnly();
    });
  }

  for (const status of [302, 307, 308]) {
    for (const action of ["read", "write", "forget"]) {
      it(`rejects ${status} ${action} redirects without forwarding or replaying`, async () => {
        const marker = `redirect-${status}-${action}`;
        const result = await probe(marker, action);
        assert.deepEqual(result, {
          ok: false, name: "MemoiaError", code: "REDIRECT_REJECTED", status,
          retryable: false, outcome: action === "read" ? "rejected" : "unknown",
          message: "Memoia request failed: REDIRECT_REJECTED",
        });
        assert.equal(received(marker).length, 1);
        assert.doesNotMatch(result.message, /must-not-follow|fixture|never-forward-body|isolated-placeholder/);
        assertOriginOnly();
      });
    }
  }

  it("does not replay a POST after an unknown response", async () => {
    const result = await probe("unknown-response", "write");
    assert.equal(result.ok, false);
    assert.equal(result.code, "INVALID_RESPONSE");
    assert.equal(result.status, 502);
    assert.equal(result.outcome, "unknown");
    assert.equal(result.retryable, false);
    assert.equal(received("unknown-response").length, 1);
    assertOriginOnly();
  });

  it("does not replay a POST after its native fetch transport is aborted", async () => {
    const result = await probe("unknown-transport", "write");
    assert.equal(result.ok, false);
    assert.equal(result.code, "TRANSPORT_ERROR");
    assert.equal(result.status, null);
    assert.equal(result.outcome, "unknown");
    assert.equal(result.retryable, false);
    assert.equal(received("unknown-transport").length, 1);
    assertOriginOnly();
  });

  it("does not replay a DELETE after an unknown response", async () => {
    const marker = "unknown-response-forget";
    const result = await probe(marker, "forget");
    assert.equal(result.ok, false);
    assert.equal(result.code, "INVALID_RESPONSE");
    assert.equal(result.status, 502);
    assert.equal(result.outcome, "unknown");
    assert.equal(result.retryable, false);
    assert.equal(received(marker).length, 1);
    assertOriginOnly();
  });

  it("does not replay a DELETE after its native fetch transport is aborted", async () => {
    const marker = "unknown-transport-forget";
    const result = await probe(marker, "forget", "native");
    assert.equal(result.ok, false);
    assert.equal(result.code, "TRANSPORT_ERROR");
    assert.equal(result.status, null);
    assert.equal(result.outcome, "unknown");
    assert.equal(result.retryable, false);
    assert.equal(received(marker).length, 1);
    assertOriginOnly();
  });
});
