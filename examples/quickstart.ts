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
console.log({ operation_id: receipt.operation_id, status: receipt.status });
if (receipt.status === "completed") {
  // The automatic flush updates Profile/Event separately. Read all three memory layers.
  const memories = await client.search(MEMOIA_USER_ID, "What does the user enjoy?", 10, { max_token_size: 8192 });
  console.log({ fact_count: memories.facts.length, event_count: memories.events.length, profile_count: memories.profiles.length });
}
