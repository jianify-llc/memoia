import { MemoiaClient } from "../sdks/typescript/src/index.js";

// Keep these identifiers and the timestamp unchanged when resolving the same business operation.
const { MEMOIA_API_URL, MEMOIA_PROJECT_TOKEN, MEMOIA_USER_ID, MEMOIA_SOURCE_ID, MEMOIA_OPERATION_KEY, MEMOIA_MESSAGE_TIME } = process.env;
if (!MEMOIA_API_URL || !MEMOIA_PROJECT_TOKEN || !MEMOIA_USER_ID || !MEMOIA_SOURCE_ID || !MEMOIA_OPERATION_KEY || !MEMOIA_MESSAGE_TIME)
  throw new Error("Supply the explicit Memoia connection, user, source, operation key and message timestamp");
const client = new MemoiaClient({ baseUrl: MEMOIA_API_URL, apiKey: MEMOIA_PROJECT_TOKEN, maxAttempts: 1 });
const receipt = await client.importBlob(MEMOIA_USER_ID, {
  source_id: MEMOIA_SOURCE_ID,
  idempotency_key: MEMOIA_OPERATION_KEY,
  messages: [{ message_id: "preference-1", role: "user", content: "I enjoy cycling and reading.", occurred_at: MEMOIA_MESSAGE_TIME }],
});
const operation = receipt.blob_id && (receipt.status === "staged" || receipt.status === "processing")
  ? await client.flushBlob(MEMOIA_USER_ID, MEMOIA_SOURCE_ID, {
      idempotency_key: `extract:${MEMOIA_OPERATION_KEY}`, append_operation_ids: [receipt.operation_id],
    })
  : receipt;
console.log({ operation_id: operation.operation_id, status: operation.status });
if (operation.status === "processing")
  console.log("Query the original Operation to confirm the completed Blob results.");
