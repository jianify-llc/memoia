import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApp } from "../src/http";
import type { Runtime } from "../src/runtime";

const openapi = JSON.parse(
  readFileSync(
    new URL("../../../openapi.json", import.meta.url),
    "utf8",
  ),
);
test("registered HTTP method/path pairs cover the frozen OpenAPI", () => {
  const app = createApp(() => {
    throw new Error("no request expected");
  });
  const routes = new Set(
    app.routes
      .filter((r) => r.method !== "ALL")
      .map((r) => `${r.method} ${r.path.replace(/:([^/]+)/g, "{$1}")}`),
  );
  for (const [path, methods] of Object.entries(openapi.paths) as Array<
    [string, Record<string, unknown>]
  >) {
    for (const method of Object.keys(methods)) {
      const normal = path.replace("{idempotency_key}", "{key}");
      assert.ok(
        routes.has(`${method.toUpperCase()} ${normal}`),
        `${method.toUpperCase()} ${path}`,
      );
    }
  }
});
test("unauthenticated requests stop before any user query", async () => {
  let closed = 0;
  const queries: string[] = [];
  const runtime = {
    env: { ACCESS_TOKEN: "root" },
    db: {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
      close: async () => {
        closed++;
      },
    },
  } as unknown as Runtime;
  const app = createApp(() => runtime);
  const unauth = await app.request("/api/users", {}, runtime.env);
  assert.equal(unauth.status, 401);
  assert.equal(queries.length, 0);
  assert.equal(closed, 1);
  const res = await app.request(
    "/api/users/00000000-0000-0000-0000-000000000000/flush",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer sk-other-token",
        "Content-Type": "application/json",
      },
      body: '{"idempotency_key":"k"}',
    },
    runtime.env,
  );
  assert.equal(res.status, 401);
  assert.equal(queries.length, 1);
  assert.equal(closed, 2);
});

test("read-only project key cannot mutate users", async () => {
  const id = "123456781234123412341234567890ab",
    token = `mka_${id}_secret`;
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  const token_hash = Array.from(new Uint8Array(bytes), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
  let calls = 0;
  const runtime = {
    env: {},
    db: {
      query: async (sql: string) => {
        calls++;
        assert.match(sql, /project_api_keys/);
        return {
          rows: [{ project_id: "alpha", scopes: ["read"], token_hash }],
        };
      },
      close: async () => {},
    },
  } as unknown as Runtime;
  const app = createApp(() => runtime);
  const response = await app.request(
    "/api/users",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
    runtime.env,
  );
  assert.equal(response.status, 403);
  assert.equal(calls, 1);
  assert.deepEqual(await response.json(), {
    detail: {
      code: "scope_required",
      message: "API key lacks required scope",
      retryable: false,
    },
  });
});

test("project administrator cannot manage a different project", async () => {
  const token = "sk-alpha-secret";
  let calls = 0;
  const runtime = {
    env: {},
    db: {
      query: async (sql: string) => {
        calls++;
        assert.match(sql, /FROM memoia.projects/);
        return { rows: [{ project_id: "alpha", project_secret: token }] };
      },
      close: async () => {},
    },
  } as unknown as Runtime;
  const app = createApp(() => runtime);
  const response = await app.request(
    "/api/projects/beta/keys",
    { headers: { Authorization: `Bearer ${token}` } },
    runtime.env,
  );
  assert.equal(response.status, 403);
  assert.equal(calls, 1);
});

test("request schema rejects unknown project fields before database writes", async () => {
  let calls = 0;
  const runtime = {
    env: { ACCESS_TOKEN: "root" },
    db: {
      query: async () => {
        calls++;
        throw new Error("unexpected write");
      },
      close: async () => {},
    },
  } as unknown as Runtime;
  const response = await createApp(() => runtime).request(
    "/api/projects",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer root",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ project_id: "p", unexpected: true }),
    },
    runtime.env,
  );
  assert.equal(response.status, 422);
  assert.equal(calls, 0);
});
test("oversized body is rejected before the handler", async () => {
  let calls = 0;
  const runtime = {
    env: { ACCESS_TOKEN: "root" },
    db: {
      query: async () => {
        calls++;
        throw new Error("unexpected write");
      },
      close: async () => {},
    },
  } as unknown as Runtime;
  const response = await createApp(() => runtime).request(
    "/api/projects",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer root",
        "Content-Type": "application/json",
      },
      body: "x".repeat(2 * 1024 * 1024 + 1),
    },
    runtime.env,
  );
  assert.equal(response.status, 413);
  assert.equal(calls, 0);
});
