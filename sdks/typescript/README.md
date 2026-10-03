# Memoia TypeScript SDK v2

`@jianify/memoia@0.2.3` supports Node.js and Cloudflare Workers. This is a separate v2 client; the upstream v1 SDK is unchanged. Protocol types and runtime validators are generated from `src/server/api/openapi-v2.json`, not a second hand-written contract. This patch fixes native Worker fetch receiver and redirect compatibility, preserving recoverable ownership-conflict classification and bundled validator license notices; the server protocol remains v2/0.2.0.

```ts
import { MemoiaClient } from "@jianify/memoia";

const memoia = new MemoiaClient({ baseUrl: "https://test-memoia.jianify.dev", apiKey: projectToken });
const operation = await memoia.importSource(userId, {
  idempotency_key: batchKey,
  external_id: `luvel:memory_store_logs:${logId}`,
  messages: [{ message_id: "123", role: "user", content: "I live in Tokyo.", occurred_at: "2026-10-02T00:00:00Z" }],
}, { deadline: Date.now() + 90_000 });
```

The base URL is an origin, without `/api/v2`. `deadline` is an absolute Unix timestamp in milliseconds; `signal` may also cancel a request. Reads retain a 5-second per-attempt limit, writes a 90-second limit, both bounded by the caller's remaining deadline. The client never generates or replaces an idempotency key.

Completed results are schema-validated, including final event/profile IDs. `processing` is not success. A transport timeout or lost write response throws `MemoiaError` with `outcome === "unknown"`: query `getOperationByKey()` to recover before deciding whether to resend. Only safe reads and explicit retryable server failures receive bounded backoff; there is no implicit replay of a write whose commit is unknown.

HTTP 409 is recoverable only when the server explicitly supplies `detail.retryable: true` with `detail.code: "write_conflict"` or `"lease_lost"`. Other conflicts, including changed idempotent input, are not implicitly replayed. Task consumers can use `maxAttempts: 1` to retain this classification without SDK replay, then query the fixed operation key and call `retryOperation()` on its persisted input. This patch does not change the OpenAPI wire contract or weaken unknown-write handling.

The SDK does not perform message segmentation, profile reconstruction, task scheduling, or provider-specific business decisions.

Transport callbacks are invoked as standalone functions, never as methods of the client. This is required by native Worker `fetch`; Node-only mocks do not establish Worker runtime compatibility. A custom transport that depends on an object's `this` must be explicitly bound by its caller. Transport failures retain bounded read retry and unknown-write handling; the client never prints the original exception, credentials or response body.

Requests use `redirect: "manual"`, which the Worker runtime supports, and reject every 3xx response without following `Location` or disclosing it. Redirected mutations retain an unknown outcome because their first request may already have executed. `pnpm test` runs both Node contract tests and an isolated workerd transport regression; all workerd outbound requests are intercepted locally, without business credentials or network access.

`listSources()`, `listOperations()`, and `getHistory()` accept server-defined `limit`/`offset` pagination together with transport options. Operation listings allow an Inspector refresh to recover accepted work without storing a second browser session. History contains actual profile revisions and added/removed diffs; it excludes withdrawn evidence and is not a restore API. `retryOperation()` resumes the server's persisted request without resending message bodies.

Administrative methods are `listProjects`, `createProject`, `updateProject`, `listKeys`, `createKey`, `revokeKey`, and the explicit `rotateLegacyToken`. Project/key pagination follows server OpenAPI. Authorization remains on the server: root creates/suspends projects; project administrators manage only their own keys. Key creation returns its token once, revocation returns no body, and lost administrative mutation acknowledgements are not silently replayed. Rotating a legacy token immediately invalidates clients using the prior token.

## Build and local consumption

```bash
pnpm install --frozen-lockfile
pnpm check:generated
pnpm test
pnpm pack
```

The generated validators are standalone JavaScript: runtime use requires no Node.js APIs, dynamic evaluation, or Ajv dependency. A fixed-version tarball can be copied into a consumer's `vendor/` directory and referenced through a `file:` dependency with its lockfile; no registry publication is required for first integration. Regenerate after exporting server OpenAPI. The generated-schema check must be part of verification before distribution.
