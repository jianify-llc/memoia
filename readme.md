# Memoia

Memoia is an Apache-2.0 memory service derived from [Memobase](https://github.com/memodb-io/memobase). Preserve [LICENSE](LICENSE) and [NOTICE](NOTICE).

The TypeScript service supports Cloudflare Workers with Hyperdrive, Queue and Cron, and Docker with a Node API, a persistent worker and PostgreSQL/pgvector. Both deployments use the same business code, authenticated API, SDK and Legato tasks. Luvel and Inspector can use Service Binding or authenticated HTTP according to their deployment.

Each session uses one Blob. Message imports append to that Blob and return a staged Operation receipt. A Fact flush fixes the append IDs for one extraction task. The task saves Facts and indexes, clears temporary input, and completes the receipt together. Later appends stay in the same Blob for a later Fact flush.

Background maintenance seals a bounded batch of committed Fact changes. One user-scoped AgentLoop maintains Profile and Event. Queue delivery on Cloudflare and database polling in Docker run the same Legato tasks, with leases, checkpoints, retries and execution slices. PostgreSQL stores the memory and task state. Redis is used only to import historical usage counters during migration.

Deleting a message immediately removes its Fact contribution. Profile/Event may remain readable until the original flush succeeds. Permanent forgetting immediately blocks reads and late writes. Unknown results are resolved through the original Operation rather than replaying input with a new identity.

- [Development and configuration](docs/development.md)
- [API and evidence contracts](docs/api.md), [OpenAPI](openapi.json)
- [TypeScript SDK](sdks/typescript/README.md)
- [MCP adapter](src/mcp/README.md)
- [Cloudflare and Docker deployment](deploy/README.md)
- [Data migration and recovery](docs/guide/typescript-worker-migration.md)
- [Behavioral test coverage](docs/guide/ts-contract-coverage.md)

Local contract and database tests verify the covered behaviors. Real-provider semantics, cache behavior and deployed endpoints need environment-specific validation.
