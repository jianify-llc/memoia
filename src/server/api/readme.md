# Memoia Backend API

<!-- Modified for Memoia: internal package name and maintenance references. -->

The internal implementation lives in `memoia_server/`. This is an Apache-2.0 fork
of Memobase; HTTP contracts and the original Memobase SDKs remain unchanged.
Deployment and rollback boundaries are in the [release guide](../../../docs/guide/memoia-release.md).

Memobase is a user memory system designed for LLM Applications. It provides a FastAPI-based server that manages user profiles, memories, and various types of data blobs. Details of developing it in [here](./DEVELOPMENT.md).

## Core Components

### 1. API Layer (`api.py`)
- FastAPI application with versioned endpoints (`/api/v1`)
- Implements authentication middleware
- Main endpoints:
  - Health check
  - User management (CRUD operations)
  - Blob management
  - User profile management
  - Buffer management

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
SDK signatures, response fields and descending profile update ordering are unchanged.

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
- Redis: Caching and temporary storage
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
It sends `reasoning_effort=medium` and defaults to `max_completion_tokens=32768`
for business calls through the configured best/thinking model. An explicit native
`max_completion_tokens` overrides that default for the current request only.
Startup uses a separate 4096-token completion budget and asks for exactly `OK`;
empty, unexpected or incomplete probe results prevent startup. This shared request
boundary ignores historical `max_tokens` limits such as 16/1024; it removes `max_tokens`,
`temperature`, `top_p`, `logprobs` and `top_logprobs`. Keeping the old tiny limit
with reasoning enabled can truncate the completion before usable text is produced.

32768 is a generation **ceiling**, covering reasoning and visible output together,
not a per-call reservation or guaranteed visible output length. Actual usage and
latency require provider acceptance. Existing application telemetry tokenizes input
and visible output, not the provider's full reasoning-token usage; it is not a
provider billing record. GPT-6 Luna is the acceptance target; compatibility with
older models is no longer promised or tested. Business prompts and SDK/HTTP
contracts are unchanged. Reasoning effort is not a substitute
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
summary HTTP/flush path, startup limits and failure responses. Run it and the complete `tests/` suite
against disposable local PostgreSQL/Redis only. These checks do not establish
API-key/model access, extraction quality, latency, cost or real flush acceptance;
those require an explicitly configured provider acceptance run and a new image.

### Background user lease

The existing user/project/blob-type lock and queue names are unchanged. Each
background runner holds a 300-second renewable lease. A separate asyncio heartbeat
runs throughout the batch, including model waits, and atomically compare-and-expires
the owner token every one-third TTL. Renewal I/O is bounded to one-third TTL;
an error, timeout or owner mismatch blocks subsequent batches. Owner verification
and queue pop are also atomic; an old runner cannot consume the next owner's queue.
Normal exit, exceptions and cancellation stop/join the heartbeat before the
existing compare-and-delete release, without deleting a successor's lock.

Lease loss does not cancel or replay an admitted batch: external request cancellation
does not prove server-side cancellation. This is not a database fencing protocol;
Redis outages or event-loop stalls longer than TTL can still leave in-flight results
requiring reconciliation. Do not infer drain completion from a missing/expired lock.
The existing maximum processing duration is checked between batches, not a hard
deadline for an individual model request. Shutdown/release safety still requires
the drain and unknown-result checks in the release guide.

`tests/test_buffer_background.py` executes the real runner/Lua against disposable
Redis, with the processing boundary controlled by events. It verifies processing
longer than two TTLs does not admit a second executor, owner replacement cannot
renew/delete the successor or dequeue work, renewal errors stop later batches, and
cancellation leaves no heartbeat behind.

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
