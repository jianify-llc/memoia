import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MemoiaClient, MemoiaError } from "@jianify/memoia";
import { createMemoryServer } from "../src/server.js";

const user = "10000000-0000-4000-8000-000000000001";
async function connect(api: object) {
  const server = createMemoryServer(api as MemoiaClient, user);
  const client = new Client({ name: "local-test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
test("MCP advertises the three existing memory tools and fixes the target user", async () => {
  const seen: unknown[] = [];
  const api = {
    async getUser(id: string) { assert.equal(id, user); return { id }; },
    async importBlob(id: string, input: unknown) { seen.push({ id, input }); return { operation_id: "receipt", status: "completed", result: { fact_ids: ["fact"] } }; },
    async getProfiles(id: string) { assert.equal(id, user); return { profiles: [] }; },
    async search(id: string, query: string, count: number, options: unknown) { seen.push({ id, query, count, options }); return { facts: [], events: [], profiles: [] }; },
  };
  const session = await connect(api);
  try {
    assert.deepEqual((await session.client.listTools()).tools.map(t => t.name).sort(), ["get_user_profiles", "save_memory", "search_memories"]);
    const args = { text: "I like tea.", idempotency_key: "same-operation", occurred_at: "2026-11-01T10:00:00Z" };
    await session.client.callTool({ name: "save_memory", arguments: args });
    await session.client.callTool({ name: "save_memory", arguments: args });
    assert.deepEqual(seen[0], seen[1], "a deliberate replay preserves the business input and timestamp");
    assert.equal((seen[0] as any).id, user);
    await session.client.callTool({ name: "search_memories", arguments: { query: "tea" } });
    assert.deepEqual(seen[2], { id: user, query: "tea", count: 10, options: { max_token_size: 8192 } });
    assert.equal((await session.client.callTool({ name: "get_user_profiles", arguments: {} })).isError, undefined);
  } finally { await session.close(); }
});
test("MCP returns an uncertain write as an error without retry, flush or secret disclosure", async () => {
  let writes = 0;
  const session = await connect({
    async getUser() { return { id: user }; },
    async importBlob() { writes++; throw new MemoiaError("RESPONSE_LOST", null, false, "unknown"); },
    async flushUser() { throw new Error("must not start maintenance separately"); },
  });
  try {
    const result = await session.client.callTool({ name: "save_memory", arguments: { text: "private", idempotency_key: "fixed", occurred_at: "2026-11-01T10:00:00Z" } });
    assert.equal(result.isError, true); assert.equal(writes, 1);
    assert.match(JSON.stringify(result), /unknown/); assert.doesNotMatch(JSON.stringify(result), /private/);
  } finally { await session.close(); }
});
test("MCP rejects incomplete mutation identities before calling Memoia", async () => {
  let calls = 0;
  const session = await connect({ async getUser() { calls++; } });
  try {
    const result = await session.client.callTool({ name: "save_memory", arguments: { text: "tea" } });
    assert.equal(result.isError, true); assert.equal(calls, 0);
  } finally { await session.close(); }
});
