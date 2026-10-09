# Memoia Backend API

<!-- Modified for Memoia: internal package name and maintenance references. -->

The internal implementation lives in `memoia_server/`. This is an Apache-2.0 fork
of Memobase; it now exposes one `/api` contract and the `@jianify/memoia` SDK.
Upstream HTTP routes and SDKs are retired. Consumers must upgrade together.
Deployment and rollback boundaries are in the [release guide](../../../docs/guide/memoia-release.md).

Source extraction deduplicates factual conclusions, not independent message support.
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
  - `GeneralBlob`: Stores various types of data
  - `BufferZone`: Temporary storage for processing
  - `UserProfile`: User memory profiles
- Supported Blob Types:
  - Chat
  - Document
  - Image
  - Code
  - Transcript

### 3. Controllers (`controllers/`)
- Business logic implementation
- Main modules:
  - `user`: User management
  - `blob`: Blob data handling
  - `buffer`: Buffer zone operations
  - `profile`: User profile management
- Modal processing:
  - Chat processing
  - Profile merging and extraction

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
- Template management for LLM interactions
- Profile extraction and merging logic
- Multilingual support (English/Chinese)
- Summary generation

## Key Features

### Memory Management
- Long-term user profile storage
- Automatic memory merging and updating
- Buffer system for temporary storage
- Token-aware content management

### Profile reads and cache ownership

Memoia reads profiles directly from PostgreSQL, including HTTP reads and internal
extraction, merging and organization. It does not cache profiles in Redis or
invalidate a server-side profile cache after writes. Reads reflect committed
database state; they do not wait for in-flight extraction to finish.

Consumers own any profile-cache TTL and invalidation policy. Luvel's existing
consumer-side KV cache is not changed by this server behavior. Redis remains in
use for background queues, renewable leases, authentication, telemetry and other
existing non-profile functions.

The obsolete `cache_user_profiles_ttl` YAML option and
`MEMOBASE_CACHE_USER_PROFILES_TTL` override are ignored. Existing expiring
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
- Automatic profile summarization
- Multi-modal data handling

## Dependencies
- FastAPI: Web framework
- SQLAlchemy: Database ORM
- Redis: Renewable user-write coordination and approximate usage counters
- Pydantic: Data validation
- Tiktoken: Token management
- Rich: Enhanced logging

## Configuration
Key configuration options in `config.yaml`:
- System prompt
- Buffer flush interval
- Token size limits
- LLM settings
- Language preferences
- Model selection

### GPT-6 Luna compatibility

The OpenAI Chat Completions adapter recognizes the exact model ID `gpt-6-luna`.
It defaults to `reasoning_effort=high` and `max_completion_tokens=32768`
for business calls through the configured best/thinking model. An explicit native
`max_completion_tokens` overrides that default for the current request only.
Startup uses a separate 4096-token completion budget and asks for exactly `OK`;
empty, unexpected or incomplete probe results prevent startup. This shared request
boundary ignores historical `max_tokens` limits such as 16/1024; it removes `max_tokens`,
`temperature`, `top_p`, `logprobs` and `top_logprobs`. Keeping the old tiny limit
with reasoning enabled can truncate the completion before usable text is produced.

Projects can independently override `llm_model` and `reasoning_effort` in their
configuration YAML; omitted fields inherit service defaults `gpt-6-luna / high`.
This applies to Fact extraction and both serial maintenance stages. The maintenance
tool loop uses Responses with `store=false`, since Luna Chat Completions only supports
tool calling at `none`; it never silently lowers a project's reasoning setting.
The optional Inspector Playground has its own runtime model configuration.

32768 is a generation **ceiling**, covering reasoning and visible output together,
not a per-call reservation or guaranteed visible output length. Actual usage and
latency require provider acceptance. Existing application telemetry tokenizes input
and visible output, not the provider's full reasoning-token usage; it is not a
provider billing record. GPT-6 Luna is the acceptance target; compatibility with
older models is no longer promised or tested. This model parameter policy does not change business prompts. Reasoning effort is not a substitute
for low sampling temperature or a guarantee of deterministic extraction.
See [OpenAI parameter guidance](https://developers.openai.com/api/docs/guides/latest-model#gpt-6-astra-update-api-and-model-parameters)
and [Chat Completions limits](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).

Refusal, absent/non-text content, truncation, content filtering and any completion
state other than `stop` are errors. Normally completed `""` and whitespace strings
are returned unchanged; the summary business layer treats these as successful
no-event results. Missing optional usage metadata does not discard valid text.
JSON mode routes empty/whitespace output to a parser failure (`UNPROCESSABLE_ENTITY`),
not an empty object. The legacy fallback for non-empty malformed text remains:
some malformed text can still become `{}`. This is **not** strict schema validation
and this patch does not introduce Structured Outputs or guarantee determinism.

`tests/test_openai_model_llm.py` exercises the installed OpenAI SDK through a
mock HTTP transport, including request serialization, JSON mode, the actual empty
summary processing path, startup limits and failure responses. Run it and the complete `tests/` suite
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
