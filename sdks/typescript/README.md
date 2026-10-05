# Memoia TypeScript SDK v2

`@jianify/memoia@0.5.0` supports Node.js and Cloudflare Workers. Protocol types and runtime validators are generated from `src/server/api/openapi-v2.json`. This v2 revision changes Source from a processing batch to a caller-owned grouping; upgrade callers together with the server. The upstream v1 SDK and its event/user deletion contracts are unchanged.

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

A Source is unique within the authenticated project and user. Every import creates one server-owned Blob tied to its fixed idempotency key. Messages belong to the Source, not the Blob: overlapping batches reuse their identity and cannot create independent evidence from the same message. Changed body, role or occurrence time for an existing message ID returns a conflict. `deleteMessages()` deletes contributions across all Blobs in that Source; it does not require message bodies or event IDs. Event deletion and permanent account forgetting remain distinct operations.

Completed imports atomically erase raw input and retain their receipt, facts and message associations. Incomplete raw input defaults to seven days of temporary retention; retry does not extend it. After expiry, `retryOperation()` returns `input_required`. First query the original receipt, then explicitly resupply the identical batch using its original key if still incomplete. The SDK never reconstructs or resends expired input automatically. Legacy groups (`legacy:` / `v1-flush:`) are not inferred external conversation identities.

The base URL is an origin, without `/api/v2`. `deadline` is an absolute Unix timestamp in milliseconds; `signal` may also cancel a request. Reads retain a 5-second per-attempt limit, writes a 90-second limit, both bounded by the caller's remaining deadline. The client never generates or replaces an idempotency key.

Completed results are schema-validated, including final event/profile IDs. `processing` is not success. A transport timeout or lost write response throws `MemoiaError` with `outcome === "unknown"`: query `getOperationByKey()` to recover before deciding whether to resend. Only safe reads and explicit retryable server failures receive bounded backoff; there is no implicit replay of a write whose commit is unknown.

HTTP 409 is recoverable only when the server explicitly supplies `detail.retryable: true` with `detail.code: "write_conflict"` or `"lease_lost"`. Other conflicts, including changed idempotent input, are not implicitly replayed. Task consumers can use `maxAttempts: 1` to retain this classification without SDK replay, then query the fixed operation key and call `retryOperation()` on its persisted input. Unknown-write handling is unchanged.

`forgetUser(userId, { deadline })` permanently forgets an account within the authenticated project. It requires a valid UUID and accepts only HTTP 200 with the same UUID and `forgotten: true`; an empty response, another user's receipt, or a malformed acknowledgment is not proof of forgetting. UUID letter casing is normalized for identity comparison. This is not ordinary event deletion, message retraction, or the unchanged v1 user deletion. The server tombstone also blocks later v2 imports and resumed operations with `410 user_forgotten`, a permanent non-retryable error.

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

Import messages may include `time_zone` (original IANA zone). `occurred_at` remains the message recording instant, not the date of the event it describes. Returned source evidence and search events preserve `event_time` (inclusive dates, precision and verbatim source expressions) and `source_messages` (recording instants/zones). `EventTime` and `Evidence` are exported from generated OpenAPI. Missing fields in old responses are compatible; unknown dates must remain unknown. A month/year range is not an exact occurrence or duration. Pair SDK 0.4 with schema revision 0007; no history backfill is implicit.
