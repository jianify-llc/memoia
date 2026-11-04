# Memoia TypeScript runtime

Cloudflare Worker and Node/Docker adapters share one TypeScript service. Local checks do not imply deployment or Test acceptance.

The Worker serves the existing `/api` contract. Luvel's original Task calls Fact imports synchronously through the SDK's injected `fetch`; only unified maintenance uses Memoia's Queue. PostgreSQL `memoia` owns Operations, receipts, fixed Blobs, leases and all memory; Queue messages carry only identities.

## Local checks

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
pnpm build:node
```

Supply local test connection strings explicitly through `MEMOIA_TEST_DATABASE_URL`. Never source application `.env` to run migration tools. Integration tests must use a dedicated empty database; shared Test is outside local checks.

Deployment configuration `test` names the Worker `luvel-memoia-test` and its queue `luvel-memoia-maintenance-test`. Consumption starts disabled. Hyperdrive must be bound using a Memoia-only database role with query caching disabled; resource IDs and provider credentials are supplied only through the authorized deployment workflow. No domain is detached to pause writes.

Docker independently runs PostgreSQL/pgvector, `node dist-node/node-api.js` and `node dist-node/node-worker.js`. Node polls the same durable tasks and uses the same Legato execution and recovery code. It does not require Cloudflare bindings or Redis. Schema initialization, bootstrap and upgrades are explicit operator commands; restarting either process does not initialize or migrate a database. See [Docker deployment](../../deploy/README.md#docker-independent-postgresql).

The full ownership, configuration, cutover and rollback procedure is in [the migration guide](../../docs/guide/typescript-worker-migration.md). The candidate verification workflow performs no deployment.

## Migration and recovery

For a fresh installation, initialize an empty database and then create the root project and billing:

```sh
pnpm exec tsx scripts/migrate.ts init --target "$TARGET_DATABASE_URL"
pnpm exec tsx scripts/migrate.ts bootstrap --target "$TARGET_DATABASE_URL"
```

For an existing initialized database, apply pending migrations with `pnpm db:migrate "$TARGET_DATABASE_URL"` (or `pnpm exec tsx scripts/migrate.ts upgrade --target "$TARGET_DATABASE_URL"`). Upgrade checks each existing ledger hash and timestamp against the known journal prefix, serializes concurrent upgrades and applies all pending entries in one transaction. It rejects missing or inconsistent ledgers; `init` is only for an empty target.

Bootstrap is repeatable and preserves existing root credentials, configuration and billing. It defaults to unlimited billing; pass `--usage-token-limit-active N` to set an initial positive free allowance. Root authentication uses the separately configured `ACCESS_TOKEN`.

For an existing installation, initialize an empty target, then copy the quiescent source; do not bootstrap before copying:

```sh
pnpm exec tsx scripts/migrate.ts init --target "$TARGET_DATABASE_URL"
pnpm exec tsx scripts/migrate.ts copy --source "$SOURCE_DATABASE_URL" --source-schema "$SOURCE_SCHEMA" --target "$TARGET_DATABASE_URL" --source-quiesced
```

Transfer legacy usage only after both source and destination writers are stopped:

```sh
pnpm exec tsx scripts/usage-transfer.ts --redis-url "$SOURCE_REDIS_URL" --installation-id "$SOURCE_INSTALLATION_ID" --database-url "$TARGET_DATABASE_URL" --file "$USAGE_SNAPSHOT_FILE" --source-quiesced
```

See `scripts/snapshot.ts` for explicit-target recovery. Preserve original IDs, revisions, operation states, input expiry, tombstones, Fact support and vector dimensions. Redis day and month counters are migrated separately with their remaining expiry. A point-in-time source snapshot requires a quiescent source until cutover.

Recovery requires stopping and draining TS writers and consumers, then using a compatible TS release with the same latest database. Never overwrite new writes with an old snapshot. Archives contain only the memoia schema and restore into an empty memoia schema with vector already installed in its original namespace.

Local request captures prove serialization, not provider cache hits, semantic quality or 256K compaction. Those require separately authorized real-provider acceptance.
