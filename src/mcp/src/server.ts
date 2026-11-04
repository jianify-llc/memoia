import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MemoiaClient, MemoiaError } from "@jianify/memoia";
import { z } from "zod";

/** The operator fixes the user and project credential; tool arguments cannot change ownership. */
export function createMemoryServer(client: MemoiaClient, userId: string) {
  const server = new McpServer({ name: "memoia", version: "0.12.0" });
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
  const failure = (error: unknown) => ({
    ...result({ error: error instanceof MemoiaError ? error.code : "memory_request_failed", ...(error instanceof MemoiaError ? { outcome: error.outcome } : {}) }),
    isError: true,
  });
  async function ensureUser() {
    try { await client.getUser(userId); }
    catch (error) {
      if (!(error instanceof MemoiaError) || error.status !== 404) throw error;
      await client.createUser({ id: userId });
    }
  }
  server.registerTool("save_memory", {
    description: "Save user-provided information. A completed receipt confirms Facts; Profile/Event maintenance remains asynchronous. Retain the idempotency key to query an uncertain result.",
    inputSchema: { text: z.string().min(1), idempotency_key: z.string().min(1).max(200), occurred_at: z.iso.datetime({ offset: true }), source_id: z.string().min(1).max(200).default("mcp") },
  }, async ({ text, idempotency_key, occurred_at, source_id }) => {
    try {
      await ensureUser();
      const operation = await client.importBlob(userId, {
        idempotency_key, source_id,
        messages: [{ message_id: idempotency_key, role: "user", content: text, occurred_at }],
      });
      return result(operation);
    } catch (error) { return failure(error); }
  });
  server.registerTool("get_user_profiles", {
    description: "Read the configured user's current profiles and maintenance status.", inputSchema: {},
  }, async () => {
    try { await ensureUser(); return result(await client.getProfiles(userId)); }
    catch (error) { return failure(error); }
  });
  server.registerTool("search_memories", {
    description: "Retrieve supported Facts, Events and Profiles for the configured user.",
    inputSchema: { query: z.string().min(1), max_length: z.number().int().min(1).max(8192).default(8192) },
  }, async ({ query, max_length }) => {
    try { await ensureUser(); return result(await client.search(userId, query, 10, { max_token_size: max_length })); }
    catch (error) { return failure(error); }
  });
  return server;
}
