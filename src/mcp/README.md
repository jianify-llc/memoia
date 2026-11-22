# Memoia MCP adapter

Optional TypeScript adapter for `save_memory`, `get_import_result`, `get_user_profiles` and `search_memories`, using the public Memoia SDK. It is a local integration client, separate from the Cloudflare Worker.

Install the TypeScript SDK dependencies and build it first, then run `pnpm install --frozen-lockfile` here. Supply `MEMOIA_API_URL`, `MEMOIA_PROJECT_TOKEN` and the UUID `MEMOIA_USER_ID` explicitly; no environment file is loaded automatically. Run `pnpm start` for localhost-only SSE (`/sse`, `/messages`), or `TRANSPORT=stdio pnpm start` for stdio. Stdout is reserved for the MCP protocol.

The operator owns the fixed user and project credential. Tools cannot select another user. `save_memory` requires a stable `idempotency_key`; preserve that key and the original message timestamp when resolving an unknown result through Memoia's Operation API. The tool stages the message and submits one Source flush. Use `get_import_result` with the original Operation ID and inspect the Blob result before treating Facts as saved. Automatic maintenance updates Profile/Event separately.
