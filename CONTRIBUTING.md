# Contributing

Use Node.js 22 and pnpm 10.12.4. Install frozen dependencies in `src/worker`, `sdks/typescript` and `src/mcp`. Build the SDK before installing its local MCP consumer. No Python runtime or tools are required.

Read [AGENTS.md](AGENTS.md), [development](docs/development.md), the affected API contracts and the [migration guide](docs/guide/typescript-worker-migration.md). Preserve others' working-tree changes. Prefer small business functions and existing PostgreSQL/Legato primitives over additional orchestration layers.

The root `openapi.json` is the public contract. Run `pnpm --dir sdks/typescript generate` after changing it; commit the generated SDK and documentation together. Prompt sources live in `src/worker/prompts`; follow the company Prompt/cache contract. Do not edit model behavior as part of mechanical runtime maintenance.

Run the complete local gate using `src/worker/node_modules/.bin/tsx scripts/verify.ts full`. It creates its own local PostgreSQL and Redis, runs Worker/SDK/MCP and tool checks, and cleans only its own resources. Docker and PostgreSQL client tools are required. Missing integration prerequisites must fail rather than count as acceptance. Mocks do not establish model quality or cloud behavior.

Follow the [company branch/release policy](https://github.com/jianify-llc/Jianify-LLC/blob/main/docs/engineering/branch-release.md). Ordinary development/Test pushes and development PRs do not deploy. The Test push hook validates the exact clean candidate before syncing Test; publication and shared migrations require separate authorization. Details and commands are in [deploy/README.md](deploy/README.md).

Never read application environment files to obtain credentials for independent operations. Do not log prompt text, keys, message content or raw provider errors. Platform resource creation, permissions, routing and cutover remain explicit maintenance operations.
