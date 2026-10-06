# Memoia

Memoia is an independently maintained Apache-2.0 fork of [Memobase](https://github.com/memodb-io/memobase). Preserve [LICENSE](LICENSE), [NOTICE](NOTICE) and upstream attribution.

Memoia exposes one unversioned `/api` contract and one TypeScript SDK, `@jianify/memoia`. Server, Luvel and Inspector must upgrade together; there are no old-version aliases or legacy SDK compatibility guarantees. Historical database identities and data remain intact.

- [Server development](src/server/api/DEVELOPMENT.md)
- [API and memory architecture](src/server/api/API-DESIGN.md)
- [TypeScript SDK](sdks/typescript/README.md)
- [Deployment and recovery](deploy/README.md)
- [Release and coordinated legacy recovery](docs/guide/memoia-release.md)

Pure and isolated API tests prove contract behavior; real model extraction, recall quality and deployed recovery require separate acceptance. No exact temporal filtering or exhaustive event listing is promised.
