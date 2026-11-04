import { test } from "node:test";
import assert from "node:assert/strict";
import { authenticate, allows, requiredScope } from "../src/auth";
import type { Database } from "../src/db";

const db = (rows: unknown[], calls: unknown[][] = []) =>
  ({
    query: async (_sql: string, params: unknown[]) => {
      calls.push(params);
      return { rows };
    },
  }) as unknown as Database;
test("root and legacy keys use their own project and require exact bearer credentials", async () => {
  const calls: unknown[][] = [];
  assert.deepEqual(
    await authenticate(db([]), "Bearer root-secret", "root-secret"),
    { projectId: "__root__", scopes: ["admin"], isRoot: true },
  );
  assert.equal(await authenticate(db([]), "root-secret", "root-secret"), null);
  assert.equal(
    await authenticate(
      db([{ project_id: "alpha", project_secret: "sk-alpha-good" }], calls),
      "Bearer sk-alpha-bad",
    ),
    null,
  );
  assert.deepEqual(
    await authenticate(
      db([{ project_id: "alpha", project_secret: "sk-alpha-good" }]),
      "Bearer sk-alpha-good",
    ),
    { projectId: "alpha", scopes: ["admin"], isRoot: false },
  );
  assert.deepEqual(calls[0], ["alpha"]);
});
test("scoped key is bound to its database record and endpoint method", async () => {
  const id = "123456781234123412341234567890ab",
    token = `mka_${id}_secret`;
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  const token_hash = Array.from(new Uint8Array(bytes), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
  const calls: unknown[][] = [];
  const principal = await authenticate(
    db([{ project_id: "a", scopes: ["read"], token_hash }], calls),
    `Bearer ${token}`,
  );
  assert.deepEqual(principal, {
    projectId: "a",
    scopes: ["read"],
    isRoot: false,
  });
  assert.equal(calls[0][0], "12345678-1234-1234-1234-1234567890ab");
  assert.equal(allows(principal!, "read"), true);
  assert.equal(allows(principal!, "write"), false);
  assert.equal(requiredScope("POST", "/api/users/id/facts/query"), "read");
  assert.equal(requiredScope("POST", "/api/users/id/flush"), "write");
  assert.equal(requiredScope("PATCH", "/api/project/config"), "admin");
  assert.equal(
    await authenticate(
      db([{ project_id: "a", scopes: ["read"], token_hash }]),
      `Bearer ${token}x`,
    ),
    null,
  );
  assert.equal(await authenticate(db([]), `Bearer ${token}`), null);
});
