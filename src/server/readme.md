# Memoia server

<!-- Modified for Memoia: source builds, compatible deployment identity, and release instructions. -->

This is the independently maintained server from [jianify/memoia](https://github.com/jianify/memoia),
derived from Memobase under Apache-2.0. The Python package is `memoia_server`;
client SDKs remain `memobase`. References to upstream features below remain applicable.

**Existing installations:** follow the [release and rollback guide](../../docs/guide/memoia-release.md).
Do not rename Compose resources, move data directories, or run development cleanup scripts on existing data.

<div align="center">
    <a href="https://memobase.io">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://assets.memodb.io/memobase-dark.svg">
      <img alt="Shows the Memobase logo" src="https://assets.memodb.io/memobase-light.svg" width="424">
    </picture>
  </a>
  <p><strong>Memoia, compatible with the Memobase API</strong></p>
  <p>
    <img src="https://img.shields.io/github/v/tag/memodb-io/memobase">
  </p>
</div>




## Get started

### Setup

[**config.yaml**](https://docs.memobase.io/references/full)

Memobase uses a single  `config.yaml` to initialize the server. It contains the configs of:

- LLM: `llm_base_url`, `llm_api_key`, `best_llm_model`,...
- Embedding: `enable_event_embedding`, `embedding_api_key`...
- Memory: `max_pre_profile_token_size`, `max_profile_subtopics`, `additional_user_profiles`...

By default, Memobase enables user profile and event memory with filter ability. That means running a Memobase server requires you to have below things:

- **LLM API**: You must fill the OpenAI API Key in `llm_api_key` of `config.yaml`.Or you can change `llm_base_url` to any OpenAI-SDK-Compatible service(via [vllm](https://github.com/vllm-project/vllm), [Ollama](../../assets/tutorials/ollama+memobase/readme.md),...). Alternatively, you can set `llm_api_key` and `llm_base_url` using environment variables `MEMOBASE_LLM_API_KEY` and `MEMOBASE_LLM_BASE_URL`
- **Embedding API**: Memobase supports OpenAI-Compatible SDK, [Jina Embedding](https://jina.ai/models/jina-embeddings-v3/) and [Ollama Embedding](https://docs.ollama.com/api#generate-embeddings). Memobase uses embedding API to retrieve related user events. If you don't have a embedding API, you can set `enable_event_embedding: false` in `config.yaml`

We have some example `config.yaml` in `examplel_config`:

- [`profile_for_assistant`](./api/example_config/profile_for_education),  [`profile_for_education`](./api/example_config/profile_for_education),  [`profile_for_companion`](./api/example_config/profile_for_companion)  are three similar configs in term of structure, but for different user cases.
- [`event_tag`](./api/example_config/event_tag) is a feature to tracking temporal attributes of users. [doc](https://docs.memobase.io/features/event/event_tag)
- [`only_strict_profile`](./api/example_config/only_strict_profile): disable all other features, only collect the profiles you design.
- [`jina_embedding`](./api/example_config/jina_embedding) uses Jina exmbedding for event search.
- [`ollama_embedding`](./api/example_config/ollama_embedding) uses Ollama exmbedding for event search.



**environment variables**

Check `./.env.example` for necessary vars. You can configure the running port and access token in here.  Also, anything in `config.yaml` can be override in env([doc](https://docs.memobase.io/references/full#environment-variable-overrides)), just starts with `MEMOBASE_`

### Launch

1. Make sure you have [docker-compose](https://docs.docker.com/compose/install/) installed.

2. Prepare the configs:

   ```bash
   cd src/server
   cp .env.example .env
   cp ./api/config.yaml.example ./api/config.yaml
   ```

   1. `.env` contains the service configs, like running port, secret token...
   2. `config.yaml` contains the Memobase configs, like LLM model, profile slots. [docs](https://docs.memobase.io/references/full)

3. For a **new local development installation**, run `docker compose build && docker compose up`.
   This builds your checked-out Memoia source. Published deployments instead use
   the digest-pinned API-only override described in the release guide.

Check out the [docs](https://docs.memobase.io/quickstart) of how to use Memobase client or APIs.



## Use a published Memoia API image

1. If you have existing PostgreSQL and Redis, only replace the API service.

2. Use a successful Memoia release's verified digest, not a mutable tag:

   ```bash
   # Set MEMOIA_IMAGE to the full digest reference from a successful release.
   docker pull "${MEMOIA_IMAGE:?Set the verified Memoia image digest}"
   ```

3. Setup your `config.yaml` and an `env.list` file, the `env.list` should look like [this](./api/.env.example):

4. For a new standalone API deployment, use absolute config paths and your verified digest:
   ```bash
   docker run --env-file /absolute/path/env.list -v /absolute/path/config.yaml:/app/config.yaml -p 8019:8000 "${MEMOIA_IMAGE:?Set the verified Memoia image digest}"
   ```



## Development

1. Prepare `.env` and `api/config.yaml` as above with **dedicated development data paths and ports**.
   Start dependencies with `docker compose up -d --wait memobase-server-db memobase-server-redis`.
   Do not use `script/up-dev.sh` on data you need: that inherited script deletes its development directories.
2. Open a new terminal window and `cd ./api`
3. Copy `api/.env.example` to `api/.env`, matching the dedicated database/Redis ports and credentials; install dependencies with `uv sync --frozen`.
4. Run `uv run --frozen pytest`. Tests write data: never point them at a shared or deployed database.
5. Launch Memoia Server in dev mode: `uv run --frozen -m fastapi dev api.py --port 8019`.

> `fastapi dev` has hot-reload, so you can just modify the code and test it without relaunch the service.



## Migrations

The `memobase_server` → `memoia_server` namespace release has **no database migration**.
The inherited schema-development procedure below is not an upgrade step for this release;
never autogenerate or apply schema changes against a deployed database as part of a rename.

Memobase may introduce breaking changes in DB schema, here is a guideline of how to migrate your data to latest Memobase:

1. Install `alembic`: `pip install alembic`

2. Modify `./api/alembic.ini`. Find the field called `sqlalchemy.url` in `alembbic.ini`, change it to your Postgres DB of Memobase

3. Run below commands to prepare the migration plan:

   ```bash
   cd api
   mkdir migrations/versions
   alembic upgrade head
   alembic revision --autogenerate -m "memobase changes"
   ```

4. ⚠️ Run the command `alembic upgrade head` again to migrate your current Memobase DB to the latest one.
