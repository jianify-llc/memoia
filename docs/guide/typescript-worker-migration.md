# TypeScript Worker migration

This guide describes the Cloudflare TypeScript runtime and coordinated Test database migration. Independent Node/Docker deployment uses the same service and its own PostgreSQL/pgvector; see [Docker setup](../../deploy/README.md#docker-independent-postgresql). Local checks do not authorize or prove a Test cutover.

## Ownership and execution

Memoia remains an independent Apache-2.0 repository. The Luvel instance is `luvel-memoia-test`; Memoia alone owns the `memoia` schema and `memoia.__drizzle_migrations`. Luvel migrations do not manage this schema. User UUID values are shared, without cross-schema foreign keys or automatic account cascades.

Luvel's existing memory Task calls the same SDK synchronously through Service Binding. Its remaining deadline is sent as `X-Memoia-Deadline-Ms`; the service clamps it to its own budget. Lost acknowledgements are resolved through the original Operation. Fact imports have no second Queue.

Only unified maintenance uses `luvel-memoia-maintenance-test`. Queue messages carry a user wakeup or original flush identity; `memoia.queue_tasks` owns execution, while Operation and Blob retain domain identity and receipts. Delayed wakes preserve the 30-second quiet/120-second sealing rule, with a one-minute reconciliation fallback. One user has one effective Loop; consumer concurrency and tool concurrency start at four. A slice yields at a safe boundary after twelve minutes and loses ordinary write rights at fourteen; a yield does not consume the four-failure budget. Provider call timeout remains ten minutes for maintenance and two minutes for Fact, bounded by the applicable deadline. Compaction retains the frozen 256000-token threshold.

Tool proposals are committed together. The task checkpoint retains the last complete native tool round, short references and bounded decision state; it does not serialize the SDK session or conversation history. A completed Agent checkpoint resumes at embedding and commit. Resume validates the fixed batch, configuration, prompt, current read revisions and active user. Redis writing coordination is replaced by `memory_user_states.generation/version/writer_lease_until`: this user lease protects concurrent memory writes, while the task lease fences ownership of a maintenance slice. SQL uses short transactions, including local search-path configuration for Hyperdrive transaction pooling. No transaction waits for a model.

## Configuration and readiness

`wrangler.jsonc` records the approved Test resource bindings, including the nonsecret Hyperdrive ID, and contains no credentials. The initial closed target uses `MEMOIA_WRITES_ENABLED=false` and `MAINTENANCE_ENABLED=false`. After the approved fresh-Test readiness checks, the versioned candidate enables both flags. The write pause blocks new Queue/Cron mutations, including input cleanup. Existing invocations must still be drained; changing a flag does not cancel them. Shared resource creation, role grants, binding activation, routing and deployment require the separately approved cutover.

| Binding/config | Source and purpose |
| --- | --- |
| `HYPERDRIVE` | Memoia-specific database role against Luvel Test Supabase; query caching must be disabled in the actual Hyperdrive resource. |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | Current completion credentials and endpoint; copied only through authorized secret/config maintenance. |
| `EMBEDDING_API_KEY`, `EMBEDDING_BASE_URL` | Optional independent embedding connection, preserving OpenAI/Jina/Ollama behavior. |
| `ACCESS_TOKEN` | Existing root administration credential; not a public frontend value. Project keys remain in PostgreSQL. |
| `ADMIN_URL`, `ADMIN_TOKEN` | Optional existing external billing endpoint and its Bearer secret; preserve their Python names during migration. Store the token as a secret. |
| `MEMOIA_CONFIG` | Model, reasoning, embedding, budget and topic settings as JSON, including supported gateway headers/query. Use a secret binding if a gateway header is sensitive; provider keys and database credentials retain their separate bindings. |
| `MAINTENANCE_QUEUE` | The dedicated maintenance notification Queue. |

Project model, reasoning, Fact overrides, language, topics and tags remain in project configuration. Prompt files are imported from the Worker prompt source; fixed instructions are sent every round. Public 12h and implicit 30m boundaries use the existing model/endpoint capability gate. Native `previous_response_id` carries tool continuations; no Session or persistent local model-history table is added.

The shared provider preserves `llm_openai_default_header` and `llm_openai_default_query`; if these contain gateway secrets, supply `MEMOIA_CONFIG` as a secret rather than plain Worker vars. Topic and Subtopic names retain Python's normalization. SDK tool errors retain their original domain/SQL retry classification. A `conversation_locked` response retries the same parent/input in Standard within existing limits; persistent locks defer the original flush. Safe cache diagnostics log only allowlisted categories, reasons and numeric counts, independently of completion and usage accounting.

One strict service-config parser is shared by invocation initialization, model selection, provider construction, cache capability checks and temporary-input retention. Valid nullable legacy settings remain supported; retired keys must be removed or mapped to their documented bindings instead of being silently ignored. The chosen default is `text-embedding-3-large / 1536`, matching the target vector columns. Preserve the source's actual model and dimension, including explicit overrides: changing the default does not convert existing vectors, and equal dimensions do not make different models interchangeable. Project identity remains part of authentication and data ownership.

The compatibility date is pinned to `2026-10-30`, the supported maximum of the locked local workerd binary. Future updates require the same runtime tests; setting a newer unsupported date does not validate newer behavior.

Database calls use a bounded connection wait, client query timeout and short transaction deadline; timed-out or broken connections are discarded, including when rollback or pool shutdown cannot complete. Temporary transport failures are retryable, while permanent SQL and business failures keep their original classification. The database layer never replays a statement or transaction. If a COMMIT response is lost, its outcome is unknown: maintenance locks and reads the original Task receipt before recording failure, and an already successful Task cannot be overwritten. Recovery retains the same Operation and checkpoint; it does not repeat completed model work or create a replacement receipt. Other callers must resolve uncertain writes using their own original receipt.

Cloudflare Test Inspector keeps its authenticated public website and reaches Memoia through Service Binding using the logical origin `https://test-memoia.luvel.app`. A standalone Docker Inspector uses reachable HTTP transport. Inspector and Luvel must select the same database/project after cutover; existing pages and optional Playground behavior are unchanged.

## Test cutover checklist

This checklist prepares a Test-only cutover; it does not authorize commits, shared migrations, resource changes or deployment. The release owner coordinates Memoia and Luvel; platform resources and permissions follow the existing human/Agent operating boundary. Do not touch Online or unrelated workspace changes.

### Resources and inputs

| Item | Required state before activation |
| --- | --- |
| Source | Record the actual source database/schema, Alembic revision (`0015_event_time` or `0016_source_cascade`), retained table inventory, Redis installation ID, effective model/configuration and unresolved Operations. Extra source tables are not implicitly covered by the copy tool. |
| Luvel Test Supabase | Record the actual project reference and database target. Memoia owns only `memoia`; preserve Luvel tables, extensions and migration ledger. Check the vector extension version/namespace without moving it. |
| Database roles | A migration identity owns Memoia DDL/ledger; a dedicated runtime identity has schema usage and required DML/extension permissions only. Do not expose `memoia` to the Data API or grant frontend `anon`/`authenticated` access. Budget Luvel and Memoia connections together. |
| Hyperdrive | Create or confirm a Memoia Test connection to that database using the runtime role. Actual query caching must be disabled. Record its real ID in `env.test.hyperdrive` as binding `HYPERDRIVE`; never reuse an Online ID. |
| Worker | `luvel-memoia-test`, with `workers.dev` and preview URLs disabled. Initial `MEMOIA_WRITES_ENABLED` and `MAINTENANCE_ENABLED` are both `false`. Keep the protected Inspector HTTP route; changing a domain target is a separately authorized routing action, not a way to stop writes. |
| Queue and Cron | `luvel-memoia-maintenance-test`; producer binding `MAINTENANCE_QUEUE`; exactly one consumer owned by `luvel-memoia-test`, batch size 1, concurrency 4, retries 3, existing declaration defaults for other settings. Schedule `* * * * *`. The publisher checks these resources but does not create or reconnect them. |
| Secrets/configuration | `ACCESS_TOKEN`, `OPENAI_API_KEY`, effective `OPENAI_BASE_URL` and any independent embedding/billing bindings from the table above. Keep project keys/configuration in copied PostgreSQL records. Map legacy connection/key fields to bindings; validate remaining `MEMOIA_CONFIG` fields. Do not extract values from business `.env` or print secrets. |
| Luvel callers | Server and Task Test bindings both target `luvel-memoia-test`; `MEMOIA_API_URL` and `MEMOIA_PROJECT_TOKEN` select the same service/project as Inspector. A configured Binding is the only transport path for that invocation; an error must not resend to the old HTTP database. |
| Actions | Set `MEMOIA_TEST_DEPLOY_ENABLED=true` as a repository variable (or an organization variable available to this repository), because the workflow reads it in the job-level condition. Keep the authorized account/token in GitHub `test` Environment Secrets. Luvel publication credentials need access to read the target Worker's metadata. Verify identities/scopes without retrieving secret values. |

**First registration is a prerequisite, not a bypass.** [The publisher](../../deploy/release.ts) reads an existing Worker's settings, Secrets, Queue and Cron before uploading. An absent Worker therefore cannot be created by running `deploy-test.yml`. The resource owner must first register a closed, non-business initial Worker and configure the resources above through an explicitly approved initialization procedure. If no such procedure has been agreed, stop here and resolve it; do not remove checks or manually deploy the business candidate around the gate. All subsequent Memoia business versions use the normal Actions path.

### Execution order and completion checks

For an explicitly approved fresh Test installation, use `init` and `bootstrap`, create new scoped project keys, and verify that all callers select that project. Skip historical copy and usage transfer; keep the old environment intact until normal-chain acceptance. After checking the target schema/project, restricted runtime role, Hyperdrive, Queue and absence of pending or unknown work, publish the enabled candidate once through normal Actions. There is no need to publish disabled business code first. Verify internal health and the protected Inspector before resuming callers. Old Luvel receipts and external IDs do not demonstrate memory coverage in the new project. Pause callers during their coordinated target/key switch, and do not start a global backfill as part of initialization. The sequence below covers the separate data-preserving cutover.

| Step | Action | Completion evidence |
| --- | --- | --- |
| 1. Freeze candidates | Freeze Memoia/Legato/SDK and Luvel source/package identities, OpenAPI and effective configuration. Verify Luvel's pending task migrations against its actual Test ledger before choosing its release; local numbering alone is insufficient. Reuse matching local evidence and run required checks for changed scope. | Candidate/package hashes, local test results, exact target identities, migration list and the agreed old-service pause/drain procedure. |
| 2. Prepare closed target | Complete resource preparation above. Initialize an empty Memoia target once; use `upgrade` for an initialized target. Do not `bootstrap` a data-copy target. Publish the disabled Memoia candidate through `deploy-test.yml` from current `test` HEAD. | Actual active version, both flags `false`, correct disabled-cache Hyperdrive, Queue/Cron and restricted database permissions. Health alone does not verify schema/data. |
| 3. Pause and drain source | Using the agreed existing maintenance controls, stop new Luvel/Inspector/other-client memory writes and old maintenance claims; let in-flight requests, models and SQL finish, then stop the old writers. Do not detach domains, discard tasks or change unrelated Cron/Queues. | No executing source writer/transaction and no flush owner. `copy` rejects even an expired non-null owner; unresolved ownership must be investigated, not cleared by blanket SQL. Preserve unowned pending/unknown work and original identities. |
| 4. Preserve source state | At the same quiescent point preserve actual source PostgreSQL and Redis recovery material, counts, receipts and original input expiry. Confirm the source model/1536 compatibility before copying. | Restricted recovery files and a source inventory. `snapshot.ts` only exports `memoia`; if the source is `public` or another schema, use the separately agreed manual backup covering that actual source. Do not claim the Memoia-only archive covered it. |
| 5. Copy memory | One operator runs `copy` into the initialized but data-empty target. The source stays quiescent. It verifies types, counts, digests and constraints and creates Legato tasks within one target transaction. | Confirm COMMIT and target records/receipts, not only per-table `verified` output, which occurs before COMMIT. Other Luvel schemas and ledgers remain unchanged. |
| 6. Transfer usage | After copying projects, run `usage-transfer.ts` into empty `usage_counters`. Preserve separate day/month buckets, bigint values and absolute expiries; compare the output file with committed target counters. | Required current-month counters are present and match. Missing/expired/unknown values block acceptance; do not substitute zero. A JSON file alone is not proof of SQL commit. |
| 7. Read-only acceptance | Keep both flags `false`. Verify copied project/user identities, Facts, Profile/Event, evidence, original Operations, Blobs, tombstones and task states using non-generating reads. Verify auth and write rejection. Take a target `memoia` snapshot after usage transfer and before enabling writes. | Memoia reads match the copied target/project. Actual Luvel Binding and Inspector HTTP readback follows their switch in step 8, before caller writes resume; do not point them at the empty target earlier. Search can call embedding, so any paid search is part of the separately agreed model acceptance. |
| 8. Activate | After read-only acceptance, publish a frozen candidate with both flags explicitly `true`, then deploy the compatible Luvel Server/Task and switch Inspector's HTTP target through their authorized paths. Keep affected callers paused until they reach the same target. Read back actual versions/bindings/flags before resuming new memory writes. | No old writer remains. Opening writes also enables Cron's expired-input cleanup; `MAINTENANCE_ENABLED=false` alone does not pause that cleanup. Inspect legitimate retained backlog and its expected cost before enabling maintenance. |
| 9. Normal-chain acceptance | Run the fixed normal sample below once. Only then retire the old service/Redis and keep the agreed recovery materials. | Original identities and first results demonstrate the chain; a deployed Worker, empty physical Queue or completed old receipt is not acceptance. |

The new Worker's flags do not pause the old deployment. A closed consumer may acknowledge notifications; PostgreSQL tasks/Blobs and reconciliation remain the recovery source. Configure enablement in the published candidate and verify actual values; a dashboard-only edit can drift from the next upload. Each Actions invocation must still target current `test` HEAD, including the later enablement candidate.

Commands below run from the Memoia repository root **only after execution is authorized**, with explicitly supplied task-specific connection variables and shell tracing disabled. They are examples of the checked CLI, not automatic environment discovery:

```sh
# Fresh target only; for an initialized target replace init with upgrade.
src/worker/node_modules/.bin/tsx src/worker/scripts/migrate.ts init --target "$MEMOIA_MIGRATION_TARGET_URL"
src/worker/node_modules/.bin/tsx src/worker/scripts/migrate.ts copy --source "$MEMOIA_MIGRATION_SOURCE_URL" --source-schema "$MEMOIA_MIGRATION_SOURCE_SCHEMA" --target "$MEMOIA_MIGRATION_TARGET_URL" --source-quiesced
src/worker/node_modules/.bin/tsx src/worker/scripts/usage-transfer.ts --redis-url "$MEMOIA_MIGRATION_REDIS_URL" --database-url "$MEMOIA_MIGRATION_TARGET_URL" --installation-id "$MEMOIA_MIGRATION_INSTALLATION_ID" --file "$MEMOIA_MIGRATION_USAGE_FILE" --source-quiesced
src/worker/node_modules/.bin/tsx src/worker/scripts/snapshot.ts export --source "$MEMOIA_MIGRATION_TARGET_URL" --file "$MEMOIA_MIGRATION_TARGET_ARCHIVE"
```

`bootstrap` is only for a fresh installation with no copied users/projects. These tools do not read application `.env`; connection strings, archives and model keys must not enter CI artifacts or public logs. Run only one copy/transfer process for the target.

### Normal-chain acceptance

Use a separately authorized dedicated Test account with current memory entitlements. Do not reuse a cleaned account or change thresholds, timezone, Cron or Gift to force the sample through. Freeze expected semantics and source/message identities before generation; use normal chat and the actual compression trigger, waiting for natural day-end when required.

1. **Luvel compression:** retain the original compression Task, fixed message IDs, encrypted summary/watermark result, `memory_store_logs` and provider import Task. Summary, watermark and memory intent must agree; a summary alone is insufficient.
2. **Synchronous Fact import:** confirm the original Memoia Operation/Blob, actual `source_id`, message identities, valid Facts/evidence/index and completed receipt. Verify completed raw copies are erased without printing input bodies. Lost responses query the original Operation; do not regenerate or use a new key.
3. **Automatic flush:** observe normal 30-second quiet/120-second sealing, Queue delivery and the same flush Task/Operation. Newly completed Blobs remain for the next sealed batch. Query running/unknown handles instead of starting duplicate flushes.
4. **Derived update and retrieval:** confirm the same user's Profile/Event commit together, complete supported content and consistent Fact relationships, then check normal `facts`/`events`/`profiles` responses and ID exclusions from Luvel and Inspector. Record actual model/tier, usage/cache counts, elapsed time and controlled Task/Operation trace IDs.
5. **Correction/deletion:** if included in the approved sample, correct one Fact in Inspector and delete one original Luvel message through normal APIs. Confirm original receipts, immediate Fact/evidence effects and subsequent flush updates; independently supported and unrelated content remains. Do not inject invalid IDs, alter tool results or manufacture failures in shared Test.
6. **Cleanup:** the account owner performs normal sample/account deletion; confirm Memoia forgetting/tombstones and no remaining runnable writes for that identity. Preserve minimal audit evidence; do not directly clear tables or another account's memories.

Short normal samples do not prove a real twelve-minute yield, fourteen-minute timeout, Flex fallback, cache hit or 256K compaction. Report only observed cases; retain local deterministic recovery evidence separately. No repeated paid runs to obtain a passing result, and no full backfill of unrelated users.

## Recovery

Stop and drain TS ingress and consumers before switching to an earlier compatible TypeScript release. It must support the same latest database schema and task state; preserve original receipts and unknown outcomes. Never restore an older snapshot over new writes. Archives restore only into an empty memoia schema for isolated recovery or verification; they are not a rollback of a live target. Before restoring, provision a compatible vector extension in the same namespace used by the archive and check the restore role's schema/type permissions; the archive contains only `memoia` and does not install external extensions. Restore checks the archive table of contents and rejects unsupported or non-memoia entries. Only restore trusted archives made by this tool, using a role restricted to Memoia DDL: table-of-contents filtering cannot prove that SQL inside a function or trigger has no external side effects.

| Interrupted step | Check before retry |
| --- | --- |
| `init` / `upgrade` | `init` is not idempotent. Inspect the real schema/ledger; once initialized, use `upgrade`. Unknown COMMIT must be resolved from the ledger before another attempt. |
| `copy` | It is one target transaction, not a concurrency lock. Retry only after confirming it did not commit, retained target tables remain empty and the source is still quiescent. Never replay a successful copy or clear unknown state to make it pass. |
| Usage transfer | The 0600 JSON is written before SQL commit. Read target counters first; retry only into empty counters with a new file path and still-quiescent source. There is no CLI for restoring counters from that JSON. |
| Snapshot | Export to a new path. Restore only into an isolated empty schema, without first running `init`; never over current writes. Existing local recovery exercises may be reused when their scope matches. |
| Publish / rollback | Read the actual active version, bindings and enablement first; a command failure does not prove that no switch occurred. Historical version flags may be `true`, so rollback alone does not establish a write pause. |

After target writes begin, only a compatible TS release may use that same latest database. Do not point callers back to the stale source or restart Python as a recovery dependency. If this first TS release has no compatible accepted predecessor, keep the affected path paused and fix forward rather than inventing an instant rollback.

Copy supports only known Alembic revisions 0015_event_time and 0016_source_cascade. The 0015 to 0016 change drops a redundant Fact-to-Blob foreign key and replaces the message-delete and blob-message trigger functions; it changes no columns. The target baseline contains those 0016 rules, and copy inserts into that baseline and validates its constraints without modifying the source. Earlier or unknown revisions are rejected.

## Verification evidence

Local checks include real PostgreSQL migration/constraint/lease tests, current API validators, simulated provider failures, final Agents SDK HTTP requests, and a built workerd Worker using a real Service Binding and local Hyperdrive bridge. The standalone SDK and Luvel adapter have their own tests. None of these asserts a real-provider cache hit, model quality improvement, actual 256K compaction or shared Test deployment.

Migration checks require a dedicated PostgreSQL admin URL with database creation and vector permissions via `MEMOIA_TEST_ADMIN_DATABASE_URL`. Set `MEMOIA_TEST_DATABASE_URL` for the regular database integration suite and use an isolated local Redis only for usage-transfer verification. A skipped check is not acceptance.

Run the [full local gate](../../deploy/README.md#本地验证和推送) for the frozen candidate as required; database cases need explicit isolated targets. [.github/workflows/verify.yml](../../.github/workflows/verify.yml) checks Worker types/build and SDK generation/build/types without publication; it does not run the full local PostgreSQL/Redis/business suite. [deploy-test.yml](../../.github/workflows/deploy-test.yml) publishes an authorized current `test` HEAD; it does not migrate shared databases or establish business acceptance.
