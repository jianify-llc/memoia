# Development

The service code is `src/worker`. Cloudflare HTTP/Queue/Cron and Node HTTP/polling adapters call the same business functions. The public SDK is `sdks/typescript`; `src/mcp` is an optional local TypeScript client adapter.

## Local setup

Install Node.js 22, pnpm 10.12.4, Docker and PostgreSQL client tools. Install each package with `pnpm install --frozen-lockfile`. In the Worker package use `pnpm check`, `pnpm test`, `pnpm build` and `pnpm dev`. A dry-run build uploads nothing.

`pnpm build:node` bundles the Node API, maintenance worker and migration CLI with the same Prompt files and SQL migrations. Production Docker uses Node 24. Its Compose stack runs its own PostgreSQL/pgvector; Supabase/Hyperdrive remains the Cloudflare deployment path. See the [Docker setup](../deploy/README.md#docker-independent-postgresql) for explicit initialization and startup.

Explicitly supply local test database URLs. The complete root gate in [the deployment guide](../deploy/README.md) starts isolated PostgreSQL/Redis and runs every required integration test. Worker runtime needs no Redis: its PostgreSQL writer lease and Legato Task lease have separate owners, and model waits hold neither SQL transactions nor the short commit lease.

## Configuration

Use a Hyperdrive binding with query caching disabled, or an explicitly supplied local `DATABASE_URL`. Worker secrets include `ACCESS_TOKEN`, `OPENAI_API_KEY` and any separate embedding/billing credential. `MEMOIA_CONFIG` supplies supported service settings as JSON; project settings override model, reasoning, language, topics and Fact-specific selection through the normal management API. Store sensitive gateway headers as secrets. No credentials belong in repository templates or logs.

Service configuration must be a JSON object with supported field names and valid types. Invalid configuration is rejected before accepting business work, including unknown/retired keys; diagnostics contain field names, not values. `source_input_retention_seconds` is a positive integer (default 604800): it governs temporary import/correction input and legacy chat cleanup. Existing unexpired inputs keep their original expiry on retry; completion erases input immediately.

The default embedding model is `text-embedding-3-large` with 1536 dimensions, matching the former deployment template and the TS database baseline. Preserve the effective model and dimension of existing vectors when migrating, including explicit configuration overrides: equal dimensions do not make vectors from different models interchangeable. Changing the model requires regenerating its vectors; changing dimensions also requires a compatible schema/index migration and retrieval evaluation.

Fact defaults to the configured model and reasoning (Luna/high by default), Standard service tier, and one extraction call. Maintenance starts each model request in Flex and uses Standard fallback within the same slice budget. Each request keeps complete instructions; only a new/rebuilt response chain gets the public 12h separator, followed by dynamic data with implicit 30m caching. Non-Loop Fact calls cache only their fixed rules. Prompts, tools, output formats and their budget tests are versioned together. External Agents tracing remains disabled; native Worker spans expose controlled IDs, status, timing and numerical usage without message bodies.

Imports and deletes complete Facts before maintenance. Task slicing uses a twelve-minute cooperative boundary and fourteen-minute hard boundary; safe state is checkpointed through Legato. Preserve original receipts on timeout or uncertain commit. See [API contracts](api.md), [migration and recovery](guide/typescript-worker-migration.md), and [test coverage](guide/ts-contract-coverage.md).

Node owns one bounded database pool per API/worker process (eight connections); individual invocations borrow it. Cloudflare invocations own and close their existing pools. The Node worker polls every five seconds with four execution slots; housekeeping continues while slots are occupied. Queue notification reservations never block Node execution selection. SIGTERM stops intake and drains actual handler/slice promises before closing the pool. Compose allows sixteen minutes; forced termination preserves database task state and the last safe checkpoint for normal lease recovery, rather than claiming the interrupted work succeeded.

Platform adapters assemble the common Runtime. Only the Cloudflare adapter resolves Hyperdrive and implements the optional `MaintenanceWakeup.send` port with Queue; the Node adapter owns process resources and polling. Business code uses the port without reading Queue bindings. Both drivers share PostgreSQL task selection, notification receipts, leases and the maintenance consumer; no extra scheduler state or dummy Queue is introduced.

Dependency versions and security overrides live in package manifests/locks. The scoped esbuild override patches Drizzle's legacy loader without changing the ORM or migration format; validate it with isolated schema generation. SDK validator generation uses the locked AJV version and must preserve the OpenAPI contract when regenerated. Audit development tools separately from shipped production dependencies; an audit result does not establish model quality or deployment acceptance.
