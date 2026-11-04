# Memoia

Memoia is an Apache-2.0 memory service derived from [Memobase](https://github.com/memodb-io/memobase). Preserve [LICENSE](LICENSE) and [NOTICE](NOTICE).

The service is implemented in TypeScript with two deployment adapters: Cloudflare Workers with Supabase/Hyperdrive and Queue/Cron, or Docker with a Node API, a persistent maintenance worker and its own PostgreSQL/pgvector. Both use the same business code, authenticated API, SDK and Legato task state. Luvel uses Service Binding on Cloudflare and HTTP for a Docker deployment; Inspector uses authenticated HTTP. This branch contains no Python service or Python recovery runtime.

Messages synchronously produce supported Facts, indexes and durable Operation receipts. Fixed Blobs preserve each change batch. A flush seals completed Blobs; Queue delivery or database polling starts the same user-scoped AgentLoop to maintain Profile and Event together. Legato owns execution leases, safe checkpoints, retries and slice timing. PostgreSQL owns all memory and task state; Redis is needed only to import statistics from a prior installation.

Deleting a message immediately removes its Fact contribution. Profile/Event may remain readable until the original flush succeeds. Permanent forgetting immediately blocks reads and late writes. Unknown results are resolved through the original Operation rather than replaying input with a new identity.

- [Development and configuration](docs/development.md)
- [API and evidence contracts](docs/api.md), [OpenAPI](openapi.json)
- [TypeScript SDK](sdks/typescript/README.md)
- [MCP adapter](src/mcp/README.md)
- [Cloudflare and Docker deployment](deploy/README.md)
- [Data migration and recovery](docs/guide/typescript-worker-migration.md)
- [Behavioral test coverage](docs/guide/ts-contract-coverage.md)

Local contract and database tests establish their specific behaviors. Real-provider semantics/cache benefits, deployed Queue delivery and shared Test cutover require separate acceptance. No deployment has been performed for this candidate.
