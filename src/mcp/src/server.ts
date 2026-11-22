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
    description: "Queue Fact extraction from user-provided information. Read the original receipt to confirm the Blob result.",
    inputSchema: { text: z.string().min(1), idempotency_key: z.string().min(1).max(200), occurred_at: z.iso.datetime({ offset: true }), source_id: z.string().min(1).max(200).default("mcp") },
  }, async ({ text, idempotency_key, occurred_at, source_id }) => {
    try {
      await ensureUser();
      const operation = await client.importBlob(userId, {
        idempotency_key, source_id,
        messages: [{ message_id: idempotency_key, role: "user", content: text, occurred_at }],
      });
      if (operation.status === "completed" || operation.status === "failed" || !operation.blob_id)
        return result(operation);
      return result(await client.flushBlob(userId, source_id, {
        idempotency_key: `mcp-flush:${idempotency_key}`,
        append_operation_ids: [operation.operation_id],
      }));
    } catch (error) { return failure(error); }
  });
  server.registerTool("get_import_result", {
    description: "Read a Fact import or flush receipt for the configured user.",
    inputSchema: { operation_id: z.uuid() },
  }, async ({ operation_id }) => {
    try {
      const operation = await client.getOperation(userId, operation_id);
      if (operation.kind !== "append" && operation.kind !== "import" && operation.kind !== "fact_flush")
        return failure(new MemoiaError("invalid_operation", 404, false));
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
