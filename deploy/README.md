# Memoia image-only deployment

This directory is the deployment configuration source of truth. The same
`compose.yml` is used for `memoia-test` and, after a separate approval, for
`memoia-online`. No server builds source. Real `.env`, tunnel credentials, model
keys, database files, Redis files, backups, and SSH keys never enter Git or
public Actions artifacts.

## Release gates

当前 CI 与本地验证见[统一入口](../docs/guide/ci-local.md)。普通 push 不启动 Actions；Test 只手动 AMD64 构建，正式标签仍使用原生双架构与 online 审批。main PR/合并队列/手动 Verify 的 verify 仅执行真实候选镜像构建、身份及包导入。

**本分支仍是旧发布实现，不能作为当前平台发布操作手册。** 其 Dockerfile 未打包 migrations/alembic.ini；现有 workflow 引用的 deploy-memoia.sh、schema-fingerprint.sh、recovery.py、schema-maintenance.py 和 docker-compose.yml 在本分支不存在。工作流在镜像发布或任何 SSH/上传前显式拒绝缺实现的路径。本次仅切换 CI/hook，不补业务部署或新数据库实现；须待相应源码正常归档后才具备发布能力。

下面旧独立 PostgreSQL/目录/Tunnel 安装步骤仅说明本分支原始实现，不代表现役 Test 服务器状态，也不能用于重新安装或恢复现役服务。镜像构建成功不等于允许执行这些步骤。

## First installation: operator procedure

The test host is the Tokyo Lightsail instance `jianify-test-jp1`
(`ap-northeast-1`). Verify its instance identity, OS, CPU architecture, memory,
disk, actual SSH host key, Docker Engine and Compose v2 **on the host** before
using these steps. An instance name is sufficient for this procedure; no AWS
ARN is required. Do not trust `ssh-keyscan` alone to authenticate the host key.
Keep public SSH restricted until the Tunnel SSH route and an independent
recovery path are tested; only then close both IPv4 and IPv6 public SSH ingress.

1. Create a dedicated deploy user with tightly scoped Docker access. Docker
   group membership is effectively root access: restrict the authorized key,
   keep the key out of the repository, and review the host's access policy.
2. Create `/opt/memoia/test` owned by the deploy user and
   `/opt/memoia/test/data/{postgres,redis}` on the intended persistent disk.
   Confirm the **absolute** mount paths and free capacity. Do not move them on
   application upgrades. PostgreSQL/Redis have independent lifecycles.
3. Copy the accepted commit's `compose.yml`, `deploy-api.sh` and
   `infra-fingerprint.sh` here. Copy
   `.env.example` to `.env` and `image.env.example` to `image.env`; replace every
   placeholder, set `MEMOIA_IMAGE` to the accepted manifest digest, and use
   unique test-only secrets. URL-encode DB/Redis passwords in connection URLs.
   Restrict `.env` to mode `0600`; restrict the directory and backups likewise.
   Keep the Tunnel run token here, **not** in Actions.
4. Create a separate remotely managed `memoia-test` Tunnel. Route
   `test-memoia.jianify.dev` to `http://memoia:8000` without interactive Access;
   bearer authentication remains in Memoia. Route
   `ssh-test-memoia.jianify.dev` to `ssh://host.docker.internal:22` and put a
   Cloudflare Access Service Auth policy on **only** that SSH application.
   `cloudflared` is a container, so `localhost:22` would reach the container,
   not host `sshd`. Ensure `sshd` actually listens on the Docker host-gateway
   address. Test an interactive recovery path before relying on CI SSH.
5. Run `docker compose --env-file .env --env-file image.env -f compose.yml
   config --quiet`, then `docker compose ... up -d --wait` from this directory.
   Inspect resolved mounts and container image digests. Database/Redis/API have
   no host-published ports. Check both Lightsail and host IPv4/IPv6 firewalls.
   After confirming the intended configuration, run
   `bash infra-fingerprint.sh /opt/memoia/test > infra-config.sha256` in the
   protected deployment directory. This hash includes infrastructure and
   connection identities without storing their plaintext in the record.
6. Verify pgvector, tables, embedding dimension, real LLM and embedding calls,
   HTTPS, correct and incorrect bearer behavior, persistence across restart,
   disk/memory/OOM, and a dedicated account's event/profile lifecycle. Health
   alone is not acceptance. The current empty database uses the application's
   initialization code; there is no usable Alembic migration chain to run.
7. While no external writer is connected, create the host-only
   `/opt/memoia/test/standalone-mode` marker. It gates automatic API updates.
   **Remove it before attaching Luvel or any other write producer.** Further
   automated updates then fail closed until cross-system pause/drain is built
   and accepted; never leave the marker as a false assertion of quiescence.
8. Configure the GitHub `test` Environment, set the repository variable
   `MEMOIA_TEST_DEPLOY_ENABLED=true`, and run `reverify-test` on the accepted
   `test` SHA to verify one real Actions-driven
   API update. Check that PG, Redis and Tunnel container IDs and data mounts did
   not change. Preserve the prior accepted API digest for recovery.

The checked-in `.env.example` pins multi-architecture PostgreSQL+pgvector,
Redis and cloudflared image digests. Upgrading any of them, changing the
Compose file, schema, embedding dimension, mount path or Tunnel routing is an
explicit infrastructure or migration procedure, **not** a routine API release.

## GitHub and Cloudflare minimum access

Repository Actions must be enabled, `GITHUB_TOKEN` must have `packages:write`
for publication and `deployments:write` for the post-acceptance test record.
Link the GHCR package to this repository and set it Public. Restrict the `test`
Environment to the `test` branch. Store these Environment values:

- Secrets: `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` for a Service Auth
  token accepted by the **test SSH Access application only**;
  `DEPLOY_SSH_PRIVATE_KEY` for the dedicated deploy user;
  `DEPLOY_SSH_KNOWN_HOSTS` obtained by independently checking the host key;
  `MEMOIA_TEST_BEARER_TOKEN` matching the test API token.
- Variable: `DEPLOY_USER`.

The runner's SSH ProxyCommand uses the pinned cloudflared image and the Access
service token. It never disables SSH host-key checking. The server gets no
GitHub write token and pulls public GHCR anonymously. No Cloudflare management
API token is required on the server; Tunnel/DNS/Access creation is a separate
least-privilege administrative step. An eventual `online` Environment must use
independent keys, tokens, host key and ref restrictions, and must remain disabled
until its host is verified.

Before closing public SSH, prove that the **pinned client version** can use the
service token non-interactively. A [reported cloudflared 2026.6.0 regression](https://github.com/cloudflare/cloudflared/issues/1674)
caused SSH Access to fall back to browser login; the pinned 2026.9.0 client has
not been verified in this environment. Keep the recovery path until this is
tested end to end.

## Update and recovery boundaries

`deploy-api.sh` uses a host `flock`, checks that the current Compose bytes match
the candidate, refuses an older Actions run, checks processing/failed buffers
and Redis lock/queue prefixes, and records a pending identity before touching
the API. Only `memoia` is stopped/recreated using `--no-deps --no-build`.
PostgreSQL, Redis and cloudflared container IDs must remain unchanged. If the
runner smoke fails, `pending-deploy` remains and later automation is blocked;
inspect and reconcile before clearing it. Empty queues or expired locks alone
do not prove no in-flight work; the host-only standalone marker is valid only
while no external writer exists.
The protected host `deploy-state` records the source SHA, manifest digest,
Compose hash and `.env` hash, without revealing secret values.

Initial installation has no previous Memoia image to roll back to. For later
compatible API upgrades, preserve the previous digest and configuration. Stop
writes and classify in-flight/unknown work before restoring an older API image.
Never overwrite newly created data with an older snapshot. PostgreSQL and Redis
backups must represent one quiescent point, be exported off-host, and be
restored in an isolated environment before calling recovery tested. Do not use
`docker compose down -v`, reset unknown states, clear Redis, or blindly replay
an uncertain flush. Schema or embedding changes require a separate versioned
migration and restoration rehearsal; routine deployment must block them.
