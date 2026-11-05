# Memoia deployment

One TypeScript service supports Cloudflare and Docker through separate runtime adapters. Cloudflare uses Supabase/Hyperdrive and Queue/Cron; independent Docker deployment uses its own PostgreSQL/pgvector and a persistent polling worker. Both retain the same API, task identities, leases, checkpoints and business commits. Switching runtime does not roll back database writes.

The build/start entry selects the adapter: Wrangler's `src/index.ts` uses the Cloudflare factory; Docker builds Node artifacts and starts `node-api.js` or `node-worker.js`. Business code does not detect platform globals or branch on a runtime-mode flag. The existing Actions release targets Cloudflare; Docker image publication/remote rollout is a separate, not-yet-added workflow, while local Docker builds use the root Dockerfile.

## Docker: independent PostgreSQL

The root Dockerfile produces a non-root Node 24 image containing the API, maintenance worker, migration CLI and SQL resources. `deploy/compose.yml` runs that image as `api` and `worker`, plus PostgreSQL 17 with pgvector and a persistent volume. PostgreSQL has no published host port; the API defaults to loopback port 8080. No Cloudflare account, Queue, Hyperdrive or Redis is required for this deployment.

Create the private `deploy/docker.env` from `deploy/docker.env.example` and fill the database password, matching URL-encoded `DATABASE_URL`, root `ACCESS_TOKEN` and model credentials. This file is ignored by Git and excluded from builds. Optional provider endpoints and supported `MEMOIA_CONFIG` use the same names and validation as Cloudflare. Do not reuse the example placeholders.

From the repository root, initialize only a new, empty installation:

```sh
docker compose --env-file deploy/docker.env -f deploy/compose.yml build api
docker compose --env-file deploy/docker.env -f deploy/compose.yml up -d postgres
docker compose --env-file deploy/docker.env -f deploy/compose.yml run --rm api sh -c 'node dist-node/scripts/migrate.js init --target "$DATABASE_URL"'
docker compose --env-file deploy/docker.env -f deploy/compose.yml run --rm api sh -c 'node dist-node/scripts/migrate.js bootstrap --target "$DATABASE_URL"'
docker compose --env-file deploy/docker.env -f deploy/compose.yml up -d api worker
curl --fail http://127.0.0.1:8080/api/healthcheck
```

For an existing installation, preserve its volume, stop and drain both application services, and explicitly run `upgrade` instead of `init`. Use an administrative database identity for migration; a restricted runtime identity needs only the required privileges on `memoia` tables/sequences and the vector extension. Keep initialization credentials out of normal application configuration once setup is complete. No process performs automatic migration or bootstrap. Restore using a compatible TS image and the latest database; never replace later writes with an older snapshot merely to change runtimes.

The worker polls durable PostgreSQL state every five seconds, selects at most its available execution slots (four by default), and invokes the same maintenance consumer as Cloudflare. It ignores Queue notification reservations while respecting task due time, user exclusivity and leases. Housekeeping seals due batches, reclaims expired leases and clears expired input even when execution slots are occupied. Queue/Cron and polling must not be enabled accidentally as separate installations against diverging databases; intentional shared-database consumers still rely on the same database fencing.

SIGTERM stops intake and waits for current HTTP work and bounded task slices. Compose gives sixteen minutes before forced termination. An interrupted process resumes through the original task/checkpoint and lease-recovery rules; it does not create another operation or reset retry counts. `restart: unless-stopped` restores processes after crashes or host restarts. Ordinary `compose down` preserves the database volume; remove volumes only when intentionally discarding an installation. Public access requires separately configured HTTPS/authenticated ingress; the template does not change domains, Tunnel or Access settings.

Node packaging and isolated PostgreSQL recovery are covered by local tests. The actual container verification and provider-substitute evidence are reported separately; they do not establish live model quality or Test deployment.

## Cloudflare Workers

Luvel Test 的 `luvel-memoia-test` 仅通过 Service Binding 调用，`https://test-memoia.luvel.app` 是 SDK 的逻辑 origin，不配置公网域名、路由或 workers.dev。Luvel 的健康探针也使用既有绑定。Inspector 独立部署在受 Access 保护的 `https://test-memoia-inspector.jianify.dev`，通过同一 SDK 和绑定访问 Memoia；独立 Docker 安装仍使用可达的 HTTP 地址。

Test CI 只需 Memoia 自身的 Individual Workers Editor，以及 Queues Read、Hyperdrive Read。发布器拒绝配置中的公网路由，并核对远端 workers.dev 和 preview URLs 均关闭；Custom Domains 及各域名路由由资源负责人在发布前后用既有管理权限只读核对，不为 CI 增加账户级 Access 或跨域扫描权限。

Memoia 使用 TypeScript Worker。普通 push 不触发发布；Test 仅在明确验收时手动运行 `deploy-test.yml`，并要求所选 SHA 仍是当前 `test` HEAD。Online 使用当前 `release` HEAD 上的 `vMAJOR.MINOR.PATCH` 标签，先运行完整验证并构建固定制品，发布 Job 等待 GitHub `online` Environment 审批，审批后再次确认标签及 HEAD 并校验制品。`MEMOIA_TEST_DEPLOY_ENABLED` 必须为 `true` 才执行 Test 发布。两环境的 Cloudflare token 和 account ID 分别由对应 GitHub Environment 的 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 提供，不共享凭据。

## 本地验证和推送

安装 Node、pnpm 10.12.4、Docker 和 PostgreSQL 客户端工具，分别在 `src/worker`、`sdks/typescript` 和 `src/mcp` 执行 `pnpm install --frozen-lockfile`。`pg_dump` 和 `pg_restore` 必须在 PATH 中，或通过 `MEMOIA_TEST_PG_TOOLS` 指定它们所在目录。完整验证：

```sh
src/worker/node_modules/.bin/tsx scripts/verify.ts full
src/worker/node_modules/.bin/tsx scripts/test-push.ts install
src/worker/node_modules/.bin/tsx scripts/test-push.ts push
```

完整验证启动本批独立 pgvector PostgreSQL 和 Redis，初始化测试数据库，运行 Worker、SDK 和 MCP 的测试、类型检查及构建；依赖或数据库不可用即失败。结果不是线上部署或真实模型验收。推送要求干净工作区、远端 Test 为候选祖先；检查成功且候选不变后才推送。hook 检查目标 SHA 与基线，直接推送 Test 被拒绝。无需上传平台、数据库或模型凭据。取消与失败时清理本批容器。

## 资源与发布

Test 的资源清单、首次注册、停写迁移顺序、命令及完整链路通过条件统一见 [Test 切换清单](../docs/guide/typescript-worker-migration.md#test-cutover-checklist)。首次 Worker 注册须先按确认的资源初始化流程完成；现有发布器要求目标及绑定已存在，不承担自动创建，不能通过删检查或手工发布业务候选绕过门禁。

`src/worker/wrangler.jsonc` 的环境配置是发布输入，需明确环境 Worker 名称和现有 Hyperdrive ID，关闭 workers.dev 与 preview URLs；Hyperdrive 必须禁用缓存。环境必须声明并预先配置 `ACCESS_TOKEN` 和 `OPENAI_API_KEY`；发布仅读取密钥名称及类型，不读取或创建密钥。域名及 Queue consumer 的实际连接由人员维护。配置中的 consumer 和 Cron 声明用于与云端只读比对，缺失或漂移阻断发布。Test 候选在新库、专属 Hyperdrive 和 Queue 核对后将写入与维护开关均设为 `true`，实际启用须在正常 Actions 发布后读回确认；Online 配置尚未完成。绑定存在不表示密钥、数据迁移或业务验收已完成，负责人仍需逐项核实。不要以部署脚本创建或重绑资源。环境配置和 Cloudflare 权限、Secrets、数据库兼容性需在真实部署前单独核验。

发布由 `deploy/release.ts` 调用锁定的 Wrangler 4.155.0，使用 `versions upload --no-x-provision` 上传，读取该版本的 Hyperdrive、Queue 和开关绑定，确认后切换 100% 流量，再读回活动版本与绑定；不会更新 consumer 或 Cron。Online 使用审批前生成、绑定源码和配置的制品以及单独传递的 manifest SHA256，审批后校验全部文件并通过 `--no-bundle` 上传，不再构建源码。失败后先核对平台实际状态，不假定已回滚。部署凭据只注入发布步骤，入口使用本批空 env 文件，不读取业务 `.env`。实际发布、平台资源、业务和模型验收与本地检查分别记录。

## 版本恢复

已明确授权并确认数据库和队列兼容后，使用 `deploy/release.ts rollback test|online <Worker-Version-UUID>` 恢复指定 Worker 版本。恢复前核对当前环境的 Hyperdrive 和 Queue 归属、consumer、Cron 及缓存；目标版本的 Hyperdrive 和 Queue 必须属于同一环境，开关必须是合法的 `true`／`false`，可以保留历史值。切流后再次核对实际活动版本和绑定。数据库结构与数据恢复须另行评估，版本恢复不会撤销数据库变更。
