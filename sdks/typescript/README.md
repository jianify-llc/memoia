# Memoia TypeScript SDK

On Cloudflare Workers, pass the configured Service Binding directly:

```ts
const memoia = new MemoiaClient({ binding: env.MEMOIA, apiKey: projectToken });
```

The binding selects the Worker. For a reachable HTTP deployment, pass `baseUrl`
instead. Both transports use the same authenticated API and operation receipts.

`listUsageEvents({ date, user_id, cursor, limit })` lists the authenticated project's model usage events for a UTC recording date. Pass `user_id` to read one user and pass `next_cursor` to continue that page sequence.

## Append and extract Facts

`importBlob(userId, input)` appends messages to the session Blob. The public Blob ID equals `source_id`. Collect operation IDs from `staged` receipts, pass 1–32 from the same Blob to `flushBlob(userId, blobId, { idempotency_key, append_operation_ids })` and poll the resulting `fact_flush` Operation. Later messages use the same Blob and a new flush. The optional `maintenance_reasoning_effort` applies to Profile/Event maintenance.

```ts
import { MemoiaClient } from "@jianify/memoia";

const memoia = new MemoiaClient({ baseUrl: memoiaOrigin, apiKey: projectToken });
const sessionId = String(dialogId);
const operation = await memoia.importBlob(userId, {
  idempotency_key: batchKey,
  source_id: sessionId,
  messages: [{ message_id: "123", role: "user", content: "I live in Tokyo.", occurred_at: "2026-10-02T00:00:00Z" }],
}, { deadline: Date.now() + 90_000 });

if (operation.status === "staged") {
  const flush = await memoia.flushBlob(userId, sessionId, {
    idempotency_key: flushKey,
    append_operation_ids: [operation.operation_id],
  });
  // Save flush.operation_id and poll it until the original task finishes.
}
```

A Source is unique within the authenticated project and user. Messages belong to the Source. Overlapping appends reuse message identities, and changing the body, role or recording time for an existing ID returns a conflict. For image messages, the caller can pass `visual_description` with the text. Memoia stages the description until Fact completion or input expiry. Source evidence retains message IDs and times so the caller can resolve the image from its own storage.

On completion, the Fact flush saves the Facts and indexes, clears temporary input and candidates, and records `fact_ids` and `memory_version` in the same commit. Unfinished input expires after seven days by default. Replay does not extend the deadline. If sealing returns `expired_append_inputs`, read `MemoiaError.expiredAppendOperationIds` and seal the still-valid range separately. If an accepted flush's input expires, the original receipt continues to report `input_required`.

## Delete and correct Facts

`deleteMessages(userId, sourceId, { idempotency_key, message_ids })` removes the messages' Fact contributions in the Source and returns a synchronous receipt. It needs neither message bodies nor Event IDs.

`updateFact(userId, factId, input)` and `deleteFact(userId, factId, input)` use a caller-owned idempotency key, `expected_revision` and a short `reason`. An update replaces the editable content, subject, reporter, certainty, support groups and `fact_time`. The Fact retains its identity and must reference undeleted messages in its original Blob. A stale revision requires a fresh read and a new proposal. Fact deletion leaves the messages and other Facts intact. The `correct` receipt confirms the Fact/index change. Related Profile/Event text can remain readable until maintenance succeeds.

## Recover original operations

The base URL is an origin, without `/api`. `deadline` is an absolute Unix timestamp in milliseconds; `signal` may also cancel a request. The SDK sends `X-Memoia-Deadline-Ms` as the positive remaining duration in milliseconds, calculated for each attempt; the server applies it from receipt time and also enforces its own execution limit. Reads retain a 5-second per-attempt limit, writes a 90-second limit, both bounded by the caller's remaining deadline. The client never generates or replaces an idempotency key.

Only safe reads receive bounded backoff. Each SDK write sends one request. A timeout, lost response or write 5xx yields `MemoiaError` with `outcome === "unknown"`. Check `getOperationByKey()` for the original receipt. If the request needs resending, use the same key and original input. For unkeyed management writes, read the affected resource first. A retryable 409 requires the server's explicit `write_conflict` or `lease_lost` classification. `maxAttempts` controls read attempts.

`retryOperation(userId, id)` resumes only an eligible original Fact flush or maintenance flush. It uses the original scope and checkpoints on the server. For delete or correction, recover using the original endpoint and idempotency key. Historical synchronous import receipts remain queryable.

## Maintain and query derived memory

`flushUser(userId, { idempotency_key })` seals a bounded batch of already committed Fact changes and returns a `kind: "flush"` Operation. A session Blob can contribute multiple maintenance pages without changing its public ID. Timed flushing defaults to 30 seconds of quiet and a 120-second maximum wait to seal. `getMaintenance(userId)` reports pending Blob count and recent flush receipts. An empty flush completes without a model. Completed Profile/Event writes remain in place while a failed task recovers. The maintenance receipt completes after all writes succeed.

`queryFacts()`, `queryEvents()` and `queryProfiles()` query independent pools. Query text stays in read-only POST bodies. The SDK exports the OpenAPI-derived request and result types. See the [API reference](../../docs/api.md) for filters and time fields. `getProjectIdentity()` returns the authenticated `project_id` for cache scope.

`search()` returns complete `facts`, associated `events` and `profiles` as separate objects with stable IDs; a missing/deleted Event does not invalidate its Fact. `max_token_size` is the shared response budget (default 8192, range 1–10000). `exclude_fact_ids`, `exclude_event_ids` and `exclude_profile_ids` accept at most 500 UUIDs each and independently exclude those exact output IDs, without revision tracking. An excluded Fact may still locate unseen associated Events/Profiles, including entries generated later by maintenance or omitted from a previous response budget. Navigation anchors have a separate bounded candidate pool and never displace unseen Facts; all returned objects and evidence remain within the shared budget. `exclude_profile_topics` accepts at most 50 nonempty topic strings of at most 256 characters and filters only Profiles, not Facts or Events. Invalid or oversized exclusions fail locally rather than being silently shortened. Existing `include_events` / `event_max_tokens` options remain compatible; no execution controls enter the POST body. Story fields include title, summary, keywords, `event_time`, location, content and a separate interpretation which is not Fact evidence. Event `event_time` remains nullable prose, distinct from structured `FactTime`; no runtime alias reads the former Event `time` key. Search rejects that old key; list/query EventData retains its existing extensible response shape.

`forgetUser(userId, { deadline })` permanently forgets an account within the authenticated project. It requires a valid UUID and accepts only HTTP 200 with the same UUID and `forgotten: true`; an empty response, another user's receipt, or a malformed acknowledgment is not proof of forgetting. UUID letter casing is normalized for identity comparison. This is not ordinary event deletion, message retraction, or an unconfirmed deletion. The server tombstone also blocks later imports and resumed operations with `410 user_forgotten`, a permanent non-retryable error.

A lost or invalid DELETE acknowledgment remains `outcome === "unknown"` and is never automatically replayed. The caller may explicitly call `forgetUser()` again for the same project and UUID: the server's permanent tombstone makes that confirmation idempotent. Only a verified forgetting receipt may justify resolving earlier unknown account writes. The SDK does not own account-cleanup scheduling or discard its caller's unresolved operation tracking.

The SDK does not perform message segmentation, profile reconstruction, task scheduling, or provider-specific business decisions.

Transport callbacks are invoked as standalone functions, never as methods of the client. This is required by native Worker `fetch`; Node-only mocks do not establish Worker runtime compatibility. A custom transport that depends on an object's `this` must be explicitly bound by its caller. Transport failures retain bounded read retry and unknown-write handling; the client never prints the original exception, credentials or response body.

Requests use `redirect: "manual"`, which the Worker runtime supports, and reject every 3xx response without following `Location` or disclosing it. Redirected mutations retain an unknown outcome because their first request may already have executed. `pnpm test` runs both Node contract tests and an isolated workerd transport regression; all workerd outbound requests are intercepted locally, without business credentials or network access.

`listSources()`, `listOperations()` and `getHistory()` accept server-defined `limit`/`offset` pagination and transport options. Operation listings let callers locate accepted work after a refresh. History returns profile revisions and added/removed diffs with withdrawn evidence excluded.

Administrative methods are `listProjects`, `createProject`, `updateProject`, `listKeys`, `createKey`, `revokeKey`, and the explicit `rotateLegacyToken`. Project/key pagination follows server OpenAPI. Authorization remains on the server: root creates/suspends projects; project administrators manage only their own keys. Key creation returns its token once, revocation returns no body, and lost administrative mutation acknowledgements are not silently replayed. Rotating a legacy token immediately invalidates clients using the prior token.

## Bounded provenance reads

`listSources()` returns summaries only (`source_id`, `legacy`, `created_at`). Detail reads use `getSource(userId, sourceId, requestOptions?, page?)`; the third argument remains transport options. `page` accepts `limit` (default 50, maximum 100), `message_offset`, `blob_offset`, and `evidence_offset` (default 0).

Each detail collection has its own required nullable `next_*_offset`. Only `null` means that collection is exhausted; missing pagination fields are an invalid response, not proof of completion. Message pages include active and deleted IDs, with `deleted_message_ids` as a subset of that same page. Evidence retains its supporting message observations even when they lie outside the message page. The SDK never traverses a whole source automatically.

Ordering is message ID, Blob `(created_at, id)`, and evidence `(occurred_at, id)`. Offset pagination is bounded per response. Refresh after concurrent changes.

## Build and local consumption

Daily usage requires all counters and `usage_complete`. A false value flags recorded calls without provider token counts. Usage values are recorded subtotals. Evidence responses require `certainty` (including `legacy`) and a positive `revision`. Missing required fields fail SDK validation.

```bash
pnpm install --frozen-lockfile
pnpm check:generated
pnpm test
pnpm pack
```

The generated validators are standalone JavaScript: runtime use requires no Node.js APIs, dynamic evaluation, or Ajv dependency. A fixed-version tarball can be copied into a consumer's `vendor/` directory and referenced through a `file:` dependency with its lockfile; no registry publication is required for first integration. Regenerate after exporting server OpenAPI. The generated-schema check must be part of verification before distribution.

## Time evidence

Import messages may include the original IANA `time_zone`. `occurred_at` is the message recording instant. Fact `fact_time` carries the supported calendar date or range, precision and original expressions. Fact `created_at` is first insertion and `updated_at` is the latest content or evidence change. Unknown legacy timestamps are null. `source_messages` carries supporting message times and zones. The SDK exports `FactTime` and `Evidence`. Event `event_time` is separate, nullable story text.

`search` and `getContext` send private queries in POST JSON bodies and use read timeouts/retry classification. User, profiles, events, project config/usage and source operations all use this same client. Query retrieval fuses lexical/vector rankings per Fact independently of Event; context keeps their global order. Temporary query embedding failure preserves lexical retrieval; input or configuration rejection fails explicitly. No query date parsing or temporal score is added.

`getContext` returns required ordered `entries: string[]` and `context === entries.join("\n\n")`; the SDK validates both the generated shape and this equality. Each entry contains a complete fact with available time/source evidence. Token packing skips entries that do not fit, without truncating evidence. Consumers retain these boundaries for their final wrapped prompt budget; profiles are read independently. Old stored events remain readable, but old string-only context responses are not accepted by this contract. DELETE user means permanent forgetting and requires the same-UUID tombstone acknowledgement. User-level flush is separate from completed Fact imports/deletions; it only maintains derived content.
