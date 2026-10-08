# Memoia TypeScript SDK

`@jianify/memoia@0.9.0` supports Node.js and Cloudflare Workers. Protocol types and standalone runtime validators come from `src/server/api/openapi.json`. Every capability uses one unversioned `/api` contract; deploy server and consumers together. No legacy SDK or version alias is supported.

```ts
import { MemoiaClient } from "@jianify/memoia";

const memoia = new MemoiaClient({ baseUrl: "https://test-memoia.jianify.dev", apiKey: projectToken });
const operation = await memoia.importBlob(userId, {
  idempotency_key: batchKey,
  source_id: String(dialogId),
  messages: [{ message_id: "123", role: "user", content: "I live in Tokyo.", occurred_at: "2026-10-02T00:00:00Z" }],
}, { deadline: Date.now() + 90_000 });

await memoia.getBlob(userId, operation.blob_id!);
await memoia.deleteMessages(userId, String(dialogId), {
  idempotency_key: deletionKey,
  message_ids: ["123"],
});
```

A Source is unique within the authenticated project and user. Every import or message deletion creates one server-owned Blob tied to its fixed idempotency key. Messages belong to the Source, not the Blob: overlapping batches reuse their identity and cannot create independent evidence from the same message. Changed body, role or occurrence time for an existing message ID returns a conflict. `deleteMessages()` deletes contributions across all Blobs in that Source; it does not require message bodies or event IDs. Event deletion and permanent account forgetting remain distinct operations.

Completed imports atomically erase raw input and retain their receipt, facts and message associations. Incomplete raw input defaults to seven days of temporary retention; retry does not extend it. After expiry, `retryOperation()` returns `input_required`. First query the original receipt, then explicitly resupply the identical batch using its original key if still incomplete. The SDK never reconstructs or resends expired input automatically. Legacy groups (`legacy:` / `v1-flush:`) are not inferred external conversation identities.

The base URL is an origin, without `/api`. `deadline` is an absolute Unix timestamp in milliseconds; `signal` may also cancel a request. Reads retain a 5-second per-attempt limit, writes a 90-second limit, both bounded by the caller's remaining deadline. The client never generates or replaces an idempotency key.

Completed results are schema-validated Fact receipts with an immutable `memory_version`, not a promise of completed Profile/Event. `processing` is not success. Every mutation is sent once, including explicitly retryable 409/429 responses. Only safe reads receive bounded backoff. A transport timeout, lost write response, or any write 5xx throws `MemoiaError` with `outcome === "unknown"`; it does not prove rollback. For source operations, query `getOperationByKey()` before deciding how to recover. For unkeyed management writes, read the affected resource before another deliberate mutation.

`flushUser(userId, { idempotency_key })` seals the user's completed, unassigned Blobs across Sources and returns a `kind: "flush"` Operation with `source_id`/`blob_id` null. `flush.blob_ids` is fixed; an empty flush completes without a model. `getMaintenance(userId)` exposes `pending_blob_count` and recent `flushes` with operation IDs, status, attempts and errors. Query `getOperation()`/`getOperationByKey()` and explicitly `retryOperation(userId, originalFlushId)` after repair; this does not resend source input. Profile/Event commit atomically with the flush receipt. Timed flushing defaults to 30s quiet / 120s maximum; old failed flushes retain their own retry budget while newer batches can proceed. Message deletion immediately removes invalid Fact evidence, but old derived text may remain readable until maintenance succeeds. Permanent user forgetting has no such delay.

A flush selects a bounded prefix of whole Blobs (up to 100 scanned, 256 KiB of changes/current Facts); the tail remains in `pending_blob_count` for subsequent flushes. An indivisible oversized Blob fails explicitly without calling the model. Automatic backoff keeps the original Operation `processing` and its flush `pending`, with the last retryable error; only permanent failure or exhausted attempts becomes `failed`. Repeating recovery while processing does not reset attempts. SDK validation rejects contradictory Operation/progress states.

`search()` returns complete `facts`, associated `events` and `profiles` as separate objects with stable IDs; a missing/deleted Event does not invalidate its Fact. `max_token_size` is the shared response budget (default 4000, range 1–10000). `exclude_fact_ids`, `exclude_event_ids` and `exclude_profile_ids` accept at most 500 UUIDs each and independently exclude those exact output IDs, without revision tracking. An excluded Fact may still locate unseen associated Events/Profiles, including entries generated later by maintenance or omitted from a previous response budget. Navigation anchors have a separate bounded candidate pool and never displace unseen Facts; all returned objects and evidence remain within the shared budget. `exclude_profile_topics` accepts at most 50 nonempty topic strings of at most 256 characters and filters only Profiles, not Facts or Events. Invalid or oversized exclusions fail locally rather than being silently shortened. Existing `include_events` / `event_max_tokens` options remain compatible; no execution controls enter the POST body. Story fields include title, summary, keywords, time, location, content and a separate interpretation which is not Fact evidence.

HTTP 409 is recoverable only when the server explicitly supplies `detail.retryable: true` with `detail.code: "write_conflict"` or `"lease_lost"`. The SDK preserves that classification for the caller; `retryable` is not permission for SDK write replay. Other conflicts, including changed idempotent input, do not authorize recovery. Task consumers own receipt lookup and explicit `retryOperation()` on persisted input. `maxAttempts` controls read attempts only.

`forgetUser(userId, { deadline })` permanently forgets an account within the authenticated project. It requires a valid UUID and accepts only HTTP 200 with the same UUID and `forgotten: true`; an empty response, another user's receipt, or a malformed acknowledgment is not proof of forgetting. UUID letter casing is normalized for identity comparison. This is not ordinary event deletion, message retraction, or an unconfirmed deletion. The server tombstone also blocks later imports and resumed operations with `410 user_forgotten`, a permanent non-retryable error.

A lost or invalid DELETE acknowledgment remains `outcome === "unknown"` and is never automatically replayed. The caller may explicitly call `forgetUser()` again for the same project and UUID: the server's permanent tombstone makes that confirmation idempotent. Only a verified forgetting receipt may justify resolving earlier unknown account writes. The SDK does not own account-cleanup scheduling or discard its caller's unresolved operation tracking.

The SDK does not perform message segmentation, profile reconstruction, task scheduling, or provider-specific business decisions.

Transport callbacks are invoked as standalone functions, never as methods of the client. This is required by native Worker `fetch`; Node-only mocks do not establish Worker runtime compatibility. A custom transport that depends on an object's `this` must be explicitly bound by its caller. Transport failures retain bounded read retry and unknown-write handling; the client never prints the original exception, credentials or response body.

Requests use `redirect: "manual"`, which the Worker runtime supports, and reject every 3xx response without following `Location` or disclosing it. Redirected mutations retain an unknown outcome because their first request may already have executed. `pnpm test` runs both Node contract tests and an isolated workerd transport regression; all workerd outbound requests are intercepted locally, without business credentials or network access.

`listSources()`, `listOperations()`, and `getHistory()` accept server-defined `limit`/`offset` pagination together with transport options. Operation listings allow an Inspector refresh to recover accepted work without storing a second browser session. History contains actual profile revisions and added/removed diffs; it excludes withdrawn evidence and is not a restore API. `retryOperation()` resumes the server's persisted request without resending message bodies.

Administrative methods are `listProjects`, `createProject`, `updateProject`, `listKeys`, `createKey`, `revokeKey`, and the explicit `rotateLegacyToken`. Project/key pagination follows server OpenAPI. Authorization remains on the server: root creates/suspends projects; project administrators manage only their own keys. Key creation returns its token once, revocation returns no body, and lost administrative mutation acknowledgements are not silently replayed. Rotating a legacy token immediately invalidates clients using the prior token.

## Bounded provenance reads (0.5)

`listSources()` returns summaries only (`source_id`, `legacy`, `created_at`). Detail reads use `getSource(userId, sourceId, requestOptions?, page?)`; the third argument remains transport options. `page` accepts `limit` (default 50, maximum 100), `message_offset`, `blob_offset`, and `evidence_offset` (default 0).

Each detail collection has its own required nullable `next_*_offset`. Only `null` means that collection is exhausted; missing pagination fields are an invalid response, not proof of completion. Message pages include active and deleted IDs, with `deleted_message_ids` as a subset of that same page. Evidence retains its supporting message observations even when they lie outside the message page. The SDK never traverses a whole source automatically.

Ordering is message ID, Blob `(created_at, id)`, and evidence `(occurred_at, id)`. Offset pagination is bounded per response, not a snapshot or an O(1) deep-page guarantee; refresh after concurrent changes. This read-contract change requires coordinated server/consumer rollout but no new schema revision.

## Build and local consumption

```bash
pnpm install --frozen-lockfile
pnpm check:generated
pnpm test
pnpm pack
```

The generated validators are standalone JavaScript: runtime use requires no Node.js APIs, dynamic evaluation, or Ajv dependency. A fixed-version tarball can be copied into a consumer's `vendor/` directory and referenced through a `file:` dependency with its lockfile; no registry publication is required for first integration. Regenerate after exporting server OpenAPI. The generated-schema check must be part of verification before distribution.

## Time evidence (0.4)

Import messages may include `time_zone` (original IANA zone). `occurred_at` remains the message recording instant, not the date of the event it describes. Returned source evidence and search facts preserve `event_time` (inclusive dates, precision and verbatim source expressions) and `source_messages` (recording instants/zones). `EventTime` and `Evidence` are exported from generated OpenAPI. Unknown dates must remain unknown. A month/year range is not an exact occurrence or duration. SDK 0.9.0 requires schema revision 0009 and coordinated consumers; no model backfill of historical identity or time is performed.

`search` and `getContext` send private queries in POST JSON bodies and use read timeouts/retry classification. User, profiles, events, project config/usage and source operations all use this same client. Query retrieval fuses lexical/vector rankings per Fact independently of Event; context keeps their global order. Temporary query embedding failure preserves lexical retrieval; input or configuration rejection fails explicitly. No query date parsing or temporal score is added.

`getContext` returns required ordered `entries: string[]` and `context === entries.join("\n\n")`; the SDK validates both the generated shape and this equality. Each entry contains a complete fact with available time/source evidence. Token packing skips entries that do not fit, without truncating evidence. Consumers retain these boundaries for their final wrapped prompt budget; profiles are read independently. Old stored events remain readable, but old string-only context responses are not accepted by this contract. DELETE user means permanent forgetting and requires the same-UUID tombstone acknowledgement. User-level flush is separate from completed Fact imports/deletions; it only maintains derived content.
