# Memoia Backend API

<!-- Modified for Memoia: internal package name and maintenance references. -->

The internal implementation lives in `memoia_server/`. This is an Apache-2.0 fork
of Memobase; it now exposes one `/api` contract and the `@jianify/memoia` SDK.
Upstream HTTP routes and SDKs are retired. Consumers must upgrade together.
Deployment and rollback boundaries are in the [release guide](../../../docs/guide/memoia-release.md).

Source extraction only reads the current valid batch, never historical Facts.
Supported historical statements may conflict; only Profile/Event organize the
current understanding. Source has no cumulative Fact limit. Extraction deduplicates
conclusions inside the batch, not independent message support.
Maintenance stages each tool batch only after validating all its support. Unread
Fact IDs return a bounded error result for correction within the same Loop; all
rejected targets must be resolved before a plan can complete. No automatic lookup,
new task, retry budget or partial database commit is introduced. Related additions
prefer one discovery search; independent queries remain concurrent.
An undated confirmation still supports a fact when a dated message is deleted;
the removed message's event time must not survive. Repeated messages across Blobs
retain their original message identity and do not become independent evidence.
Structured validation checks the protocol and evidence references; real-model
acceptance separately checks whether extraction preserves all relevant support.

Memobase is a user memory system designed for LLM Applications. It provides a FastAPI-based server that manages user profiles, memories, and various types of data blobs. Details of developing it in [here](./DEVELOPMENT.md).

## Core Components

### 1. API Layer (`api.py`)
- FastAPI application with one unversioned `/api` contract
- Implements authentication middleware
- Main endpoints:
  - Health check
  - User management (CRUD operations)
  - Blob management
  - User profile management
  - Source import, retraction, provenance and operation recovery

### 2. Database Models (`models/`)
- Uses SQLAlchemy ORM
- Key models:
  - `User`: Core user entity
  - `GeneralBlob` / `BufferZone`: Historical inputs and their recovery/cleanup
  - Source / fixed Blob / Fact: Current input identity, processing batch and evidence-backed memory
  - `UserProfile`: User memory profiles
  - `UserEvent`: Derived stories linked to valid Facts

### 3. Controllers (`controllers/`)
- Business logic implementation
- Main modules:
  - `user`: User management
  - `blob`: Blob data handling
  - `buffer`: Historical Chat/Summary recovery through the current Fact importer
  - `profile`: User profile management
  - `source`: Synchronous Fact extraction, evidence deletion and operation receipts
  - `maintenance`: Fixed Blob flush and atomic Profile/Event maintenance

### 4. Connectors (`connectors.py`)
- Database connection management (PostgreSQL)
- Redis connection handling
- Health check implementations
- Connection pooling configuration

### 5. Environment & Configuration (`env.py`)
- Configuration management
- Logger setup
- Token encoder initialization
- Environment variables handling

### 6. LLM Integration (`llms/`)
- OpenAI API integration
- Token management
- Async completion handling
- Response formatting

### 7. Prompts System (`prompts/`)
- English/Chinese profile topic defaults and project overrides
- Shared completion parsing utilities
- Business prompts live with Fact extraction in `controllers/source.py` and the unified loop in `maintenance_agent.py`; the old extraction/merge/summary/roleplay chain is removed.

## Key Features

### Memory Management
- Long-term user profile storage
- Automatic memory merging and updating
- Buffer system for temporary storage
- Token-aware content management

### Profile reads and cache ownership

Memoia reads profiles directly from PostgreSQL, including HTTP reads and internal
AgentLoop tools. It does not cache profiles in Redis or
invalidate a server-side profile cache after writes. Reads reflect committed
database state; they do not wait for in-flight extraction to finish.

Redis coordinates user writes and stores approximate usage counters. PostgreSQL
owns the memory data, operation receipts and flush scheduling/recovery.

The obsolete `cache_user_profiles_ttl` YAML option and
`MEMOBASE_CACHE_USER_PROFILES_TTL` override are rejected, like other retired or unknown fields. Existing expiring
`user_profiles::{project_id}::{user_id}` keys are no longer read or written and
may expire naturally; no Redis cleanup or database migration is required.
Descending profile update ordering is preserved. The single API and SDK contracts
are defined by [API-DESIGN.md](API-DESIGN.md) and generated `openapi.json`.

`tests/test_profile_storage.py` verifies committed reads despite stale Redis data,
project/user isolation and profile CRUD/merge/user deletion without Redis commands.

### Authentication
- Bearer token authentication
- Configurable access control
- Middleware-based security

### Data Processing
- Async operation support
- Batch processing capabilities
- Synchronous Fact extraction and direct retrieval
- Unified asynchronous Profile/Event maintenance

## Dependencies
- FastAPI: Web framework
- SQLAlchemy: Database ORM
- Redis: Renewable user-write coordination and approximate usage counters
- Pydantic: Data validation
- Tiktoken: Token management
- Rich: Enhanced logging

## Configuration
Key configuration options in `config.yaml`:
- Token size limits
- LLM settings
- Language preferences
- Model selection

### GPT-6 Luna compatibility

The one-shot OpenAI Responses adapter recognizes the exact model ID `gpt-6-luna`.
It defaults to `reasoning.effort=high` and `max_output_tokens=32768`
for business calls through the configured model. An explicit native
`max_output_tokens` overrides that default for the current request only.
Startup uses a separate 4096-token completion budget and asks for exactly `OK`;
empty, unexpected or incomplete probe results prevent startup. This shared request
boundary no longer accepts historical Chat Completions parameters or history;
it removes Luna's unsupported `temperature`, `top_p`, `logprobs` and `top_logprobs`. Keeping a tiny output limit
with reasoning enabled can truncate the completion before usable text is produced.

Projects can independently override `llm_model` and `reasoning_effort` in their
configuration YAML; omitted fields inherit service defaults `gpt-6-luna / high`.
This applies to Fact extraction and the unified Profile/Event AgentLoop. One-shot calls
use Responses with `store=false`; the maintenance tool loop uses `store=true` and
SDK-native response chaining within each execution. Neither silently lowers a project's
reasoning setting. Embeddings keep their separate API.
The optional Inspector Playground has its own runtime model configuration.

### Prompt caching and numerical usage

The two business generation paths use different cache policies, without an application cache:

The [company Prompt/cache contract](https://github.com/jianify-llc/Jianify-LLC/blob/main/docs/engineering/llm-prompt-cache.md) owns the shared rules. Memoia maps its two paths as follows:

- Fact extraction (Responses): fixed developer instructions followed by escaped XML source material in a separate developer message, not a fabricated User turn. Its only explicit breakpoint is on fixed instructions; explicit mode, no cache key or top-level instructions. Strict output schema uses native `text.format`, then existing Pydantic business validation. Project/model/reasoning configuration remains authoritative.
- Unified AgentLoop (Responses through Agents SDK): the complete fixed rules live in the single English source `memoia_server/prompts/maintenance.md`, including Profile/Event behavior, XML meaning, data trust and time interpretation. `Agent.instructions` loads that file; every HTTP request sends the same full `instructions`, including tool continuations, tier fallback and calls after native compaction. Fixed rules are not duplicated in `input` or dependent on compressed history. The first Developer contains escaped `project_context` data with one explicit breakpoint when supported; separate `maintenance_batch` XML follows. The SDK's `auto_previous_response_id` sends these dynamic Developer messages once, then only incremental tool results linked to the last validated response. Implicit caching continues within the chain. The key is SHA-256 of compact UTF-8 JSON `["memoia","flush",project_id,user_id,operation_id]`. This server-scoped Operation identity survives rounds, tier fallback and recovery; a different flush gets a different key. Lease owners, attempts, watermarks, request IDs and timestamps never select it. The key does not replace database ownership checks; the pinned SDK forwards it through `extra_args`.
- Startup completion probes are classified separately; embeddings are not generation calls. Inspector's optional Playground is a separate caller and is not configured by these policies.

Responses chain IDs stay in the current execution, without a Conversations object,
SDK session or database checkpoint. Flex fallback retries the same parent and input;
failed responses do not advance the chain. Business recovery starts a fresh chain
from current database context and retains existing retry/commit protections. Native
`context_management` compaction uses 256,000 tokens (decimal, not 262,144); no manual input pruning or
encrypted reasoning replay is needed in this stateful path. Status, refusal, tool
arguments/call IDs and compaction payload validation still run before tool dispatch.
`store=true` retains provider-side responses (normally 30 days); local raw-input cleanup
does not delete those provider records. External tracing remains disabled. See
[Responses state](https://developers.openai.com/api/docs/guides/conversation-state) and
[native compaction](https://developers.openai.com/api/docs/guides/compaction#server-side-compaction).

Only an HTTP 400/404 with `code=previous_response_not_found` on a request that
actually carries a parent (and no conflicting error parameter) becomes
`MAINTENANCE_PARENT_UNAVAILABLE`. The run ends without committing its staged plan;
the same flush Operation uses its existing 5/15/60-minute backoff and four-attempt
budget to start a fresh chain from current database state. There is no in-loop
full replay, new flush, or Fact re-import. Other 400/404 errors remain provider
rejections except the explicit `conversation_locked` case below; unknown gateway
error formats are not guessed from message text.

Each AgentLoop execution has one 900-second deadline, including tools, SDK backoff
and any Flex-to-Standard fallback. It has no turn or total request-count limit:
the pinned SDK accepts `max_turns=None`, and the adapter counts attempts only for
diagnostics. The prompt asks for relevant reads, batched independent work and prompt
completion without redundant confirmation. Time bounds elapsed execution, not a fixed
token cost. Each model response is still limited to 32768 output tokens.
Profile/Event reads include current supporting Facts once per page, linked by
`fact_ids`, within the 64 KiB read-page budget. Entry text and all support IDs remain
complete; support that does not fit can be fetched with the existing Fact reader.
Complete entries take priority over this optional evidence.
Search also shares each returned Fact once across its three result collections.
Its three bounded pages can total about 192 KiB plus scores and JSON framing;
the 64 KiB page limit is not a combined search-result limit.
Returned entries and supporting Facts already register their versions: updates
need no redundant exact-ID read. `read_memory` handles exact IDs, paging and literal,
case-insensitive substring filters within one field (for example a known name or topic);
it does not split a multi-keyword query. `search_memory` handles semantic/keyword
discovery. Reuse existing complete results before querying again; neither tool is a
mandatory confirmation step for the other. Search hydrates the three result collections concurrently using
private SQL sessions and joins all reads before returning a failure; staged-state
and final commit checks remain unchanged.
Read changes before choosing queries: additions prefer discovery, not two routine linked scans.
Deletion/evidence/time changes still require complete linked paging, not ranked search alone;
mixed batches need both kinds of coverage and should reuse results. An old added change may
already have derived entries when its flush recovers, so discovery uses current memory;
if that Fact is now absent, linked pages still locate stale entries without guessing a query.
With both `ids` and `query` null, the reader lists only entries linked to this batch's
changed Facts. An empty page is not a global absence check: discover related existing
entries before creating a new one unless suitable entries have already been returned.
The SDK limits each Loop to four concurrent function-tool calls, queuing the rest
within the same model turn. Independent tools remain parallel; overlapping staged
writes retain their target locks. Model calls remain serial. This limit is distinct
from `MAINTENANCE_CONCURRENCY` (default two active user Loops per Worker process):
additional users wait in PostgreSQL, not in an extra queue or a per-user Worker.
HTTP waits have a 600-second
timeout so Flex is not cut off after two minutes; the outer deadline can cancel
them earlier. The HTTP client's generic retries remain disabled. Agents SDK retains
its three `conversation_locked` retries for the current model call.
Only after those retries fail, its existing retry hook permits one replay in Standard
with the same parent and input. Every new model call starts with Flex; only a validated
successful response resets the tier, so retries of the same call keep their selected
tier. The response chain, instructions and cache key do not change on a tier switch;
cache hits or savings across tiers still require provider measurement. A terminal
lock failure in Standard becomes `MAINTENANCE_CONVERSATION_LOCKED` for original Operation
recovery. HTTP 408, transport timeouts, 429 and 5xx use the existing immediate tier
fallback. All actual HTTP attempts and SDK backoff share the same 900-second
deadline; no tools or staged plans are replayed by a tier switch.
Operation heartbeats renew independently
during model waits, without holding a database transaction. The deadline does not
cover the subsequent embedding/commit steps, which retain their own bounds.

Time is scenario-specific: Fact extraction is historical and sends no current clock. Each
source message carries its original recording instant and optional IANA `time_zone`;
the server derives `local_recorded_date` only when that historical zone is known.
Unknown zones or relative anchors remain uncertain. Recording time, memory
creation/update time and the event's supported occurrence period are distinct.

AgentLoop's fixed Prompt explains those distinctions; its initial Developer data includes
`reference_time` with `current_date` (`YYYY-MM-DD`), `time_zone` and
`time_zone_source=service_default`. Memoia currently has no validated current-user
timezone field: the reference uses configured `use_timezone`, or explicit UTC if
unset/invalid, never a zone guessed from user metadata or an old source message.
Invalid-zone fallback is local to this reference; it does not change global configuration
validation or original message timezone/evidence rules. Capture it
once per execution and reuse it across tool rounds and Flex fallback. A new execution
may refresh the date/default zone; time never enters the flush cache key. This is
run-local context, not new persistence, an event-time anchor or a promise to resolve
the user's local 'today'. Existing `event_time` evidence remains authoritative.

The local HTTP contract tests use the pinned Agents SDK with simulated Responses,
including a compaction item, to verify full instructions on every request and
incremental native tool outputs without history replay. They also cover output
validation, retries and numeric usage. This proves request construction, not real
256,000-token compaction quality or cache savings; those require separate provider validation.

Prefixes shorter than the provider's minimum cacheable length may not be cached; do not pad instructions to manufacture hits. Compaction or changes to tools, instructions, model or reasoning can reduce reuse. Cache entries expire at the provider, not in Redis. See [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

New cache options and breakpoints require both a known GPT-5.6/GPT-6/GPT-6.1 model (including dated names) and endpoint support. Native HTTPS `api.openai.com/v1` enables the contract automatically; custom gateways require strict boolean `llm_prompt_cache_options: true`. `false` disables it everywhere. Unknown/older models never opt in, even when declared true. Undeclared gateways use compatibility mode: no options, breakpoint or key is sent, and their implicit caching defaults cannot be claimed disabled. Safe capability diagnostics report only the path and enabled boolean; no endpoint, key or material is logged. Do not change a deployed configuration without separate approval.

Both generation HTTP clients disable generic SDK retries: Fact failures return to Operation recovery; AgentLoop uses the bounded tier fallback and Agents Runner lock retries described above. Reported failed usage is observed, while absent usage stays unknown. Shared model initialization suppresses OpenAI transport request-body DEBUG logs independently of AgentLoop imports. The retired generic JSON parser is removed; Fact extraction still uses its strict Pydantic contract and AgentLoop its validated tools.

One-shot Responses observes actual input/output/cache usage before output and schema validation. Refused, failed, incomplete or missing text output is not success; valid JSON with no facts remains legal. Startup keeps its isolated budget and exact-OK check. One-shot requests use `truncation=disabled` and the existing 120-second timeout; cancellation propagates without replay. The unused legacy history branch and Chat Completions production endpoint are removed, not retained as a fallback. Configured gateways must support Responses independently of the optional new cache fields. See [official migration guidance](https://developers.openai.com/api/docs/guides/migrate-to-responses).

Numerical logs and existing Prometheus counters distinguish `kind=fact_extraction`, `agent_loop`, `startup_probe` and other completions, with model, requested tier and provider-reported actual tier (`unknown` if absent). `llm_cache_read_tokens_total` and `llm_cache_write_tokens_total` use raw `cached_tokens`/`cache_write_tokens` before SDK usage normalization. Missing, invalid or inconsistent cache counters increment `llm_cache_usage_unknown_total`; they are not substituted with zero. Unknown-cache responses are excluded from both cache-token counters, so aggregate cache ratios are incomplete when this counter is nonzero. Existing input/output quota accounting is unchanged. Failed Loop responses and tier-switch attempts are included; unreported usage remains unknown. Telemetry failure does not reject a valid completion or replay a model call. No source text, tool payloads or model output are logged.

For cost acceptance, compare comparable tasks' calls/turns, latency, input/output, cache reads/writes and **actual** model/tier prices, including failures. Read/write counts are disjoint subsets of total input:

```text
ordinary_input = input_tokens - cached_tokens - cache_write_tokens
cost = (ordinary_input * input_price + cached_tokens * cache_read_price
        + cache_write_tokens * cache_write_price + output_tokens * output_price) / 1_000_000
```

Cache writes are not an extra full charge added on top of all input tokens. Use current provider prices, not a generic fixed rate. Missing usage or actual tier prevents a precise per-call cost comparison; provider billing remains authoritative. SDK serialization and fixture usage tests prove the request/observation contract, not real cache hits or savings.

32768 is a generation **ceiling**, covering reasoning and visible output together,
not a per-call reservation or guaranteed visible output length. Actual usage and
latency require provider acceptance. Telemetry records returned provider usage;
missing usage is marked unknown, and approximate Redis statistics are not a
provider billing record. GPT-6 Luna is the acceptance target; compatibility with
older models is no longer promised or tested. This model parameter policy does not change business prompts. Reasoning effort is not a substitute
for low sampling temperature or a guarantee of deterministic extraction.
See [OpenAI parameter guidance](https://developers.openai.com/api/docs/guides/latest-model#gpt-6-astra-update-api-and-model-parameters)
and [Chat Completions limits](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).

Refusal, absent/non-text content, truncation, content filtering and any completion
state other than `stop` are errors. Normally completed `""` and whitespace strings
are returned unchanged by the shared completion adapter. Fact extraction separately
requires a valid structured result; `facts: []` is a legitimate empty extraction.
Missing optional usage metadata does not discard valid text.
JSON mode routes empty/whitespace output to a parser failure (`UNPROCESSABLE_ENTITY`),
not an empty object. The legacy fallback for non-empty malformed text remains:
some malformed text can still become `{}`. This is **not** strict schema validation
and is not used to validate current Fact extraction or AgentLoop mutations.

`tests/test_openai_model_llm.py` exercises the installed OpenAI SDK through a
mock HTTP transport, including request serialization, JSON mode, empty completions,
startup limits and failure responses. Run it and the complete `tests/` suite
against disposable local PostgreSQL/Redis only. These checks do not establish
API-key/model access, extraction quality, latency, cost or real source-import acceptance;
those require an explicitly configured provider acceptance run and a new image.

### Redis boundaries

PostgreSQL owns fixed Blobs, Operations, flush scheduling and recovery. Redis only
coordinates user writes and stores approximate day/month usage counters. The old
`buffer_background` queue and Doubao context cache are removed; historical Buffer
cleanup remains. Old Redis keys are not bulk-deleted: TTL keys expire naturally,
and persistent queues require a separate inventory against unfinished DB records.

`UserLease` atomically acquires, renews and releases its owner token. Acquisition
and release are bounded to 3 seconds; renewal is bounded to one-third TTL or
3 seconds. Redis failure or owner mismatch invalidates authority. Cancellation
joins the heartbeat; an old owner cannot release its successor. The existing SQL
generation/version fence remains the final commit authority. Loops only acquire
the write lease for their short final commit, not while waiting for the model.

Usage increments and TTLs share a transaction pipeline with no implicit retries.
Unknown acknowledgements may lose statistics but must not replay model calls.
Actual provider tokens are used, including reasoning usage; missing metadata is
unknown (`llm_usage_unknown_total`), not zero or a text-token estimate. Usage totals
therefore cover known usage only, not a precise billing ledger. Statistics read
failure returns unavailable; existing project quota debits are retained separately.

`tests/test_redis_boundaries.py` covers bounded failures, cancellation, owner-only
release and real Redis counters/TTLs; source and maintenance tests cover SQL fencing,
unknown-result recovery and raw-input cleanup against isolated PostgreSQL/Redis.

## Development Guidelines
1. Use async/await for database operations
2. Implement proper error handling using Promise pattern
3. Follow token limits for profile management
4. Use proper typing with Pydantic models
5. Implement health checks for services
6. Handle multilingual support where needed

## Error Handling
- Uses custom Promise pattern
- HTTP status codes mapping
- Structured error responses
- Validation error handling

This documentation provides a high-level overview of the Memobase system. For specific implementation details, refer to the individual module documentation and code comments.


## Query execution and provider failures

Fact retrieval starts lexical SQL and query embedding concurrently. The lexical branch creates and closes its own SQLAlchemy Session in a worker thread, returning only plain candidate identifiers; ORM objects and Sessions never cross threads. Semantic ranking and evidence hydration then run in the existing retrieval Session. RRF weights, candidate limits, user/project isolation and full-evidence token budgets are unchanged.

Query embedding has one 8-second deadline, with no OpenAI SDK query retries; cancellation ends its async HTTP wait. Embedding HTTP clients use a 10-second ordinary request timeout. Document generation keeps its existing explicit operation/recovery policy. Temporary network failures, rate limiting, server errors or query deadlines retain lexical retrieval. Explicit 400/401/403/404/422 provider rejection is a configuration error returned as controlled 422, rather than pretending lexical fallback repaired an invalid configuration. Provider bodies and query text are not included in ordinary error logs.

Tests use actual isolated PostgreSQL plus an intercepted embedding transport to prove lexical execution overlaps embedding waiting, deadline cancellation and status classification. They do not prove real provider latency, extraction or retrieval quality.
