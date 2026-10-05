# Memoia release and recovery

For the **new empty Lightsail test installation and current branch/release
workflow**, use [the image-only deployment guide](../../deploy/README.md).
The instructions below describe a legacy Memobase deployment upgraded in place;
do not use its old Compose override for a fresh Memoia installation.

Routine compatible releases of the current Lightsail stack use the service-owned
stop/start flow in that deployment guide. They do not depend on a `standalone-mode`
marker, external consumers being absent, or buffer/Redis queues being empty.
The detailed drain below applies to coordinated legacy/incompatible migrations and
paired data backups, not every ordinary API update. Normal process exit alone does
not prove that every in-flight caller received its final event IDs.

Memoia is an independently maintained Apache-2.0 fork of
[Memobase](https://github.com/memodb-io/memobase). Preserve its license, copyright,
and source history. GitHub fork detachment is a separate administrative operation,
not a prerequisite for building, releasing, or deploying Memoia.

## Compatibility and ownership

The namespace release changes the internal Python package to `memoia_server`, its
imports, packaging, tests, and build inputs. It does not rename SDK packages or
change `/api/v1`, bearer authentication, `errno`/`errmsg`/`data`, record IDs, database
tables, Redis keys, `MEMOBASE_*` variables, telemetry keys, or deployed identities.
There is no schema migration for this release. Original Memobase author and license
metadata remain; source files carry relocation/change notices.
The image includes the original license and the fork's attribution in
`/app/LICENSE` and `/app/NOTICE`; a test keeps the packaged license identical to
the repository's preserved upstream license.

Flush consumers must distinguish existing wire semantics: default background mode
returns `data: null` for admitted work, not event IDs; `wait_process=true` returns
`data: [{event_id, add_profiles, update_profiles, delete_profiles}]`. An empty
buffer returns `data: []`; a completed extraction with no memory can return an item
with `event_id: null` and empty profile arrays. Do not interpret all of these as a
successfully persisted event, or parse the field as `id`. The SDK's boolean `flush`
helper intentionally discards this payload; applications tracking events must use
the existing raw request API and explicitly validate the synchronous response.

The existing API/controller is the only writer of memory processing state. The
database owns buffer status and memory records; Redis owns queue/lock state, not
proof of completed processing. Luvel owns its returned event-ID tracking and
deletion jobs. This release introduces no second queue, dual writer, or automatic
retry/recovery state machine. A successful source rename is not evidence that a
previously interrupted flush is safe to replay.

## Build and record a release

The [`verify` workflow](../../.github/workflows/verify.yml)
builds an AMD64 candidate image without publication for `main` pull requests, merge queues and explicit manual checks. It checks source identity, Python import and migration source presence; full API/SDK and isolated migration tests run locally before Test pushes. `deploy-test.yml` handles explicit manual Test batches (AMD64);
`deploy-online.yml` handles version tags at Release HEAD on native AMD64/ARM64
runners. Neither is triggered by a `main` or `release` branch push. Promoting
code to `release` and deploying online remain separate decisions. A successful
build does not replace an ARM64 runtime test or the full API/SDK acceptance test.

A successful publication uploads `release.json` and `manifest.json` and displays
the digest in the job summary. The release identity includes the exact commit,
image digest and tags. Never relabel an upstream image and call it modified Memoia:
only a build from the maintained source contains these changes.

Before deployment, add to the private deployment record:

- New and old API image digests, source commits, release artifacts, target architecture.
- Resolved Compose project name, services, container IDs, ports, environment/config
  version, `PROJECT_ID`, and all absolute bind-mount source paths. Keep secrets out
  of Git and public Actions artifacts; record a protected config backup/reference.
- PostgreSQL and Redis image identities, backup locations/checksums, and the tested
  restore procedure. They remain upstream images, not Memoia rebuilds.

Inspect actual containers' Compose labels and mounts, not only the repository
defaults. Preserve the existing Compose project, `memobase-server-*` service/container
identities and actual data directories. Do not change relative-path resolution by
running a different checkout directory. Prefer verified absolute data/config paths.
Never start two PostgreSQL instances against the same data directory, or two API
versions consuming the same queues.

## Maintenance window and flush drain

1. Rehearse on isolated restored data with both old and new images. Disable external
   producers and scheduled jobs there; never connect the rehearsal to live queues.
2. Close Luvel memory-write entry points and pause queue consumption, cron triggers,
   automatic retries and other SDK callers. Keep the **old API** running until
   already-admitted calls, synchronous flushes, background flushes, and Luvel event-ID
   tracking writes have completed. Block new callers; do not simply kill the API.
3. Inspect the entire deployment scope: `buffer_zones` counts grouped by `project_id`
   and `status`, queued buffer IDs, active lock holders, API requests and process
   logs, plus Luvel's outstanding calls and tracking. Use Redis `SCAN` on the exact
   `memobase:user_buffer_queue:{PROJECT_ID}:*` / `memobase:user_lock:{PROJECT_ID}:*`
   prefixes, not a global blocking key scan. Protect record identifiers in logs.
4. Reconcile every `processing` or `failed` item and every queued/in-flight batch.
   Queue pop occurs **before** processing, and database status is committed before
   queue insertion: an empty queue, expired lock, or successful HTTP response alone
   is not completion evidence. `done` also does not prove Luvel received event IDs.
   Drain any required remaining work serially through its original business path,
   including event-ID persistence. Classify untouched `idle` buffers for later
   processing; do not flush them all merely to make the count zero.
5. Unknown outcomes, unclassified failures, missing event tracking, or an executor
   that cannot be proven stopped **block the upgrade**. A timeout is not permission
   to kill it, reset statuses, remove locks, clear Redis, or replay unknown work.
   Resolve with the old version and retain evidence before resuming this procedure.
6. After all execution is quiescent, normally stop the old API and keep producers
   paused. Take a supported consistent PostgreSQL backup (for example logical
   `pg_dump`, including necessary roles/settings) and a completed Redis persistence
   snapshot while no application writers run. Capture both as the same quiescent
   cut, and verify that the backups restore in isolation. Copying a running PG data
   directory is not a backup. Back up deployment configuration with restricted access.

## Replace only the API image

Use the checked-in [image override](../../src/server/docker-compose.image.yml)
with the **existing deployment's** base Compose file, project identity, environment,
and working directory. The override does not rename services or replace DB/Redis.
Set `MEMOIA_IMAGE` to the complete verified `ghcr.io/jianify/memoia@sha256:…` value (the currently accepted namespace; use `ghcr.io/jianify-llc/memoia@sha256:…` only after that image is published and verified);
do not use `latest`. The inherited base Compose pins AMD64; an ARM64 installation
must preserve its existing platform override and select the ARM64 manifest.

After the preceding drain, normal API stop, backup and mount checks:

```bash
# Run from the existing deployment directory, preserving any existing -p/--env-file options.
docker compose -f docker-compose.yml -f docker-compose.image.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.image.yml pull memobase-server-api
docker compose -f docker-compose.yml -f docker-compose.image.yml up -d --no-deps --no-build memobase-server-api
```

Do not run a full-stack restart, development cleanup script, or `down -v` as an
upgrade shortcut. Inspect the running API's resolved image and unchanged mounts.
While producers remain paused, validate health/auth, existing users/profiles/events,
and an isolated test user's write → flush → returned event IDs → read/context →
delete event/user chain with the unchanged Memobase SDK. Verify Luvel event tracking
and deletion routing before reopening traffic.

## Recovery boundaries

- **Before reopening business writes:** stop the candidate API. If it touched data,
  restore the matching PostgreSQL/Redis/config backups and old image together using
  the rehearsed recovery procedure; do not restart old and new APIs concurrently.
  Any acceptance-test data is disposable and must be accounted for.
- **After reopening:** pause producers and drain/reconcile again before returning
  to the old digest. Namespace-only releases keep the same schema and data contract,
  so retain current data. Never restore the pre-release snapshot over new writes.
  If data compatibility or processing outcomes are uncertain, stop and repair
  forward; do not invent blind replay or claim image rollback restores lost work.
- A later Luvel entitlement-column migration is a separate release. Its old
  Server/Task/App binaries require the matching old schema and migration journal;
  this API image rollback is not a substitute for that coordinated recovery.

## Acceptance and remaining external evidence

Local tests must use owned disposable PostgreSQL/Redis instances, never shared
test/production services. Cover package imports, unchanged authentication/envelope,
routes, queue/lock identities, existing API/controller tests, and returned event IDs.
Compare database model definitions and persisted namespaces against the pre-rename
revision. A local image build and mocked LLM tests do not establish GHCR publication,
real provider behavior, restored production data compatibility, flush recovery, or
deployment success; record each of those separately after its actual rehearsal.

Only after Memoia and Luvel have separately passed acceptance may GitHub fork
detachment be considered. Recheck current eligibility and affected community data,
obtain confirmation of the irreversible operation, and retain repository URL,
history, license, and an `upstream` remote. Never substitute repository deletion.
