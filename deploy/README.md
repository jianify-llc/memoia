# Memoia 配置与发布

仓库维护模板/脚本，服务器不构建源码。test/online 使用相同路径，实际值由操作员填写。脚本可创建目录、设置配置权限、生成缺失模板；不生成密钥、不覆盖已有值。日常发布不得改写配置。本轮只验收 test；Online 工作流已准备，主机配置、凭据和恢复验收仍须另行完成。

Agent 操作远端服务器前，必须阅读相邻仓库 `../Jianify-LLC/ops/server/agent-operations.md` 的“Agent 可见运维”。共享终端及既有部署脚本的执行边界以该规范为准。

## 本地检查与明确 Test 验收

分支、Actions 与 hook 规则以[公司规范](https://github.com/jianify-llc/Jianify-LLC/blob/main/docs/engineering/branch-release.md)为准。普通开发分支／Test／release push 及开发 PR 不运行 Actions；归档到 main 的 PR／merge queue 保留 Verify。Test 只有明确验收批次才手动启动，Online 的版本标签、digest 与审批门禁保持不变。

```bash
python3 scripts/test_push.py install
python3 scripts/verify_local.py --mode quick --base <远端Test基线SHA>
python3 scripts/verify_local.py --mode full
# 提交自己的改动后，在准确提交的干净 worktree 中同步 Test：
python3 scripts/test_push.py push
# 仅在负责人明确要求 Test 验收后运行，不是日常 push 的后续步骤：
gh workflow run deploy-test.yml --ref test --repo jianify-llc/memoia
```

本地与云端共用 `scripts/verify_local.py`；默认 `full`。各模式职责：

| 模式 | 业务验证 | 工具验证 |
| --- | --- | --- |
| quick | 明确列出的纯计算/mock Python、OpenAPI、SDK 生成与 Node 测试；测试进程禁止真实网络、数据库和模型连接 | 按可靠 base 选择 hook、部署、legacy 和 schema；schema 改动才增加隔离数据库检查 |
| full | 全部 API、迁移、schema、OpenAPI、Node/Workers SDK | 全部工具和部署夹具 |
| publish | 固定的完整业务验证；只用于明确发布批次 | 不推断历史基线，不运行工具回归 |
| pr | 完整业务验证 | 按 PR/merge queue 的 base 选择；基线缺失/不可读取时扩大检查 |

`push` 入口取得远端 Test 精确 SHA 后调用 quick；普通业务 diff 不要求 Docker。无可靠 base 的 quick 会扩大检查，不能当成纯离线检查。依赖为 Python 3、uv/Python 3.12、Node、pnpm 10.12.4；工具/集成模式按需要求 ShellCheck、curl、Docker。依赖下载和公开词表准备不属于离线测试。

本地使用排除业务 `.env`、真实 `config.yaml` 的临时源码；云端 `--checkout` 要求干净 checkout，直接验证候选，不再复制源码。Git 历史提前获取，checkout 不保留凭据；业务子进程使用环境白名单，不继承平台/部署密钥。部署夹具与虚构业务连接配置分层，数据库只用本批独占 PostgreSQL/Redis 随机回环端口。JUnit/覆盖率写入忽略的 `.local-ci-results/<批次>/`，不是检查缓存。部署夹具使用官方 SHA-256 校验的 jq 1.8.1，容器无网络；依赖下载仅保留无认证代理。总预算 20 分钟；只清理本批资源，失败/超时/取消/清理异常均不得报告通过。

Test 长检查先于 Git 连接，hook 按目标 ref 验证本次提交和远端基线；源码／基线改变即重新检查。直接 Test push、force push、删除 Test、脏树或手工复用内部证明均不允许。安装入口遇到已有 hook 管理器停止，不覆盖。仓库文件存在不代表 hook 已安装，也不代表默认分支的手动 workflow 已注册；这些须在合入后核对，不以创建一个 Actions run 验证普通触发规则。

手动 Test 流程在 Verify／镜像构建前核对选择的是当前 test 提交，后续 stale-deployment 检查继续保留。`MEMOIA_TEST_DEPLOY_ENABLED` 仍决定是否执行真实部署；手动启动并不绕过这个门禁、GHCR 匿名拉取或正常恢复要求。

### 既有工作流的切换顺序

1. 按仓库授权合入 workflow、脚本和 hook；默认分支须包含 `workflow_dispatch` Test 入口，Test 分支保留匹配部署契约。入口注册不要求把未验收应用代码提前合入 main。
2. 只读检查实际工作流源码：Test 无 `push` 触发，Verify 不含普通开发／Test PR 和归档后的重复 push 触发；检查 hook 安装及项目依赖。
3. 确认新源码后执行 `gh workflow enable deploy-test.yml --repo jianify-llc/memoia`。禁止恢复旧 `on: push` 版本。启用本身不创建 run；只有获授权的验收批次才执行上面的手动命令。

本地通过、默认分支入口注册、Test 真实发布分别验收；仅注册入口不能证明候选脚本、迁移或业务已上线。

## GitHub Organization 与镜像归属

源码仓库为 `jianify-llc/memoia`，历史 Test 镜像仍在 `ghcr.io/jianify/memoia`。工作流使用 `github.repository` 发布新候选到 `ghcr.io/jianify-llc/memoia`；须确认 package 关联仓库、Actions 写权限及匿名拉取。Test 验证 AMD64；Online 验证 AMD64/ARM64。仓库可见性不等于 package 可见性。

部署与 schema 指纹脚本仅接受上述两个 namespace 的完整 digest；恢复仍须匹配已验收记录及源码身份。不要把旧 digest 的 owner 字符串改成新 owner；不要删除旧 package，直到历史 digest、新镜像发布、服务器拉取及恢复链路均已确认。以下旧 namespace 示例代表现有镜像，实际部署地址以验收记录为准。

```text
/opt/jianify/
├── .env                         宿主机环境与 Tunnel token，Jianify-LLC 管理
└── server/                      初始化与检查脚本

/opt/postgres/                   Jianify-LLC 管理，共享 PG17/pgvector 与 jianify-data 私有网络

/opt/memoia/                     root:root 0700
├── docker-compose.yml           操作员维护，与验收模板匹配
├── .env                         root:root 0600
├── api/config.yaml              root:root 0600，只读挂载到 /app/config.yaml
├── data/redis/                   固定绝对路径，容器管理数据权限
└── .deploy/                     root:root 0700，运行记录/候选脚本
```

## 上下文接口的隐私边界

Luvel 读取上下文使用 `POST /api/v1/users/context/{user_id}`，在 JSON body 传 `chats_str` 和 `customize_context_prompt`，沿用现有 Bearer 鉴权及响应结构。GET 仅供既有其它客户端兼容；Luvel 不能在 POST 失败时回退到把聊天内容放进 URL 的 GET。上线须先发布 Memoia POST，再切 Luvel 调用。验收正常、非法输入、超时和服务端异常时，入口日志、反向代理 URL 及 Trace 不得出现聊天正文或模板。

历史 GET URL 已可能进入 Cloudflare Workers Logs／Traces、Tunnel／代理访问日志或外部日志目的地；POST 切换不会清除这些记录。发布前核对各目的地的访问角色、导出设置及实际保留期限；有定向清理能力才按受影响时间及路径限定清理，否则限制访问并记录到期时间。实际账号和其它日志目的地须现场核实。

## 准备配置

在主机上使用完整受控的 deploy 目录：

```bash
sudo bash deploy-memoia.sh init-config /opt/memoia
sudoedit /opt/memoia/.env
sudoedit /opt/memoia/api/config.yaml
```

init-config 仅准备 /opt/memoia 下的目录、权限和缺失模板，不启动容器，也不创建或修改 /opt/jianify。已有文件只校正权限、不覆盖值；已有数据目录不 chown/chmod。不递归改动整个应用目录。

test 填 JIANIFY_ENV=test、COMPOSE_PROJECT_NAME=memoia-test、API_HOSTS=https://test-memoia.jianify.dev。online 填 JIANIFY_ENV=online、COMPOSE_PROJECT_NAME=memoia-online 及对应域名；两台服务器的数据根均为 /opt/memoia/data。Online 的首次安装、配置和恢复验收不由标签工作流代替。

填写数据库/Redis 密码、ACCESS_TOKEN、固定 PROJECT_ID、LLM/embedding 密钥和连接 URL。数据库固定为 `postgresql://jianify_app:<URL-encoded password>@jianify-postgres:5432/memoia`，连接公司私有网络中的 `memoia` 数据库；Redis 仍使用本 Compose 的 `redis` 服务名。共享应用登录角色也可连接公司的 `gatus` 数据库，因此这里不宣称按角色隔离两个库；应用只使用自己的数据库名。provider/endpoint/模型/维度/处理参数放在 api/config.yaml，密钥通过 .env 注入；示例模型仍需实际调用验收。

MEMOIA_IMAGE 可填初始候选总 manifest digest，不用 latest；所有应用入口仍要求显式传入 digest，覆盖仅限本次 Compose 进程，不改写 .env。PG 镜像由公司固定，Redis 模板在本仓库固定 digest。真实配置、密钥、备份和私钥不进入 Git/镜像/公开 artifact。

## 首次安装边界

本 Compose 只有 Redis、API；公司 PostgreSQL 在 `/opt/postgres` 独立管理，先部署并通过 `postgresctl.py status` 验证，不允许日常 Memoia 发布重建它。数据库网络 `jianify-data` 为外部私有网络，Redis 无主机端口、开启 AOF，认证 healthcheck 确认 PONG。API 仅 127.0.0.1:8000；宿主机 Tunnel 连接该地址，应用 Compose 不含 cloudflared。YAML 使用只读 bind，不允许缺失文件被自动建成目录。

首次启动由操作员使用 `deploy-memoia.sh init /opt/memoia IMAGE SOURCE_SHA RUN_ID COMPOSE_SHA256`。init-config 不等于安装或验收。init 必须确认无现有应用容器、Redis 数据目录和公司 `memoia` 数据库均为空、解析后的 Redis 挂载与数据库网络正确、公司 PostgreSQL 状态健康。先启动 Redis，再用候选 API 镜像显式执行 `python -m alembic upgrade head` 和 `check_schema()`，成功后才启动 API；迁移失败保留 pending，不启动候选 API。启动后分别验证真实模型、embedding、Bearer 正反例、SDK 写入/flush/最终事件 ID/画像与事件/删除、重启持久性、容量和 IPv4/IPv6 无公网旁路，再 finalize，不能仅凭健康检查宣称业务通过。

2026-09-30，Test 已完成旧独立 PostgreSQL 到公司共享实例 `memoia` 数据库的一次性停写切换；旧 PostgreSQL 已停止，当前 API 连接公司数据库，Test 发布入口已重新启用（本次规范推广后须明确手动验收）。此后按下文日常发布流程操作，不重跑 `backup-cutover` 或 `adopt-external-postgres`，也不以旧库快照覆盖新写入。一次性候选与旧版补丁见[历史切换说明](cutover/README.md)，实际迁移、数据及业务验收见[公司监控切换记录](https://github.com/jianify-llc/Jianify-llc/blob/main/ops/monitoring/test-cutover.md)。

init 记录 infra-config.sha256 和 schema.sha256；前者包含公司 PostgreSQL 只读配置指纹、Memoia Redis、外部网络与应用连接契约，后者只读取镜像内 ORM、建表连接层和迁移源码，不导入应用或连接 DB。Memoia 独立管理自己的服务生命周期；是否已有 Luvel 等消费者不作为日常发布资格，不再创建或读取 standalone-mode 标记。

## 日常发布

deploy-memoia.sh prepare/finalize 使用固定根目录、传入的 digest/SHA/run ID/Compose hash，sudo -n 运行，不依赖继承调用者秘密环境。

- 配置只读；MEMOIA_IMAGE 仅临时传入 Compose，不写 .env 或额外 image.env。
- .deploy 保存锁、pending、成功身份、公司 PG/本地 Redis 容器及宿主机 Tunnel 身份。失败保留待确认记录，后续发布阻断，不盲目清除/重放。
- 仅 --no-deps --no-build 更新 API；不重启基础设施，不跑 bootstrap、不调整 Swap。
- 切换前核对实际 API 镜像与 deploy-state 的已验收 digest；人工替换造成漂移或缺少成功记录时停止，不自动修改记录来接受漂移。prepare 和 restore-api 使用同一检查，init 不要求已有版本。
- 拉取及 OCI revision/schema 校验在停机前完成；旧 API 停止后必须 exit 0。超时强杀/非正常退出保留 pending，不继续启动候选。队列空或锁不存在不能替代退出判据。
- 旧 run/较新环境分支 HEAD/未完成的上次发布或维护/配置变化/Tunnel 未连接仍阻断。test 检查 `test` HEAD，online 检查 `release` HEAD。日常 prepare 和 restore-api 不查询 processing/failed buffer 或 Redis 锁队列，也不要求调用方先停写。
- 指纹包含公司 PG 脱敏配置指纹、Redis/挂载/连接、外部网络及完整 YAML 哈希，同维度的 provider、模型或 endpoint 变化也不能静默发布。配置变更单独维护；仅轮换 .env 中密钥不等于向量迁移。两阶段间配置或 PG 容器变化禁止提交成功。

.env 的 MEMOIA_IMAGE 是初始人工选择，后续实际版本以 .deploy/deploy-state 为准。不要直接用旧 .env 重建 API；恢复必须指定已验收 digest 并确认 schema/处理状态。finalize 保存 accepted/SHA；切到不同镜像时才更新 previous-accepted。相同版本重验不会覆盖真正的上一版本。

日常更新假定候选与现有 schema、持久化队列和处理状态兼容；拉取镜像后正常停止旧 API，再启动新 API，接受短暂不可用。正常退出不等于每个请求已向调用方返回最终结果；中断/超时的写入由业务链保留未知结果，不在部署脚本中清队列、重置状态或自动重放。数据库结构、embedding 身份或处理状态协议不兼容的变化走单独维护，不沿用普通发布入口。

## Schema 维护与 v2 升级

现有 v1 库升级 v2 是显式维护，不是普通 `prepare`。当前 Alembic 链依次为 `0001_v1_baseline`、`0002_sources_v2`、`0003_profile_history`、`0004_key_scopes_search`、`0005_user_tombstones`、`0006_source_blob_messages`、`0007_event_time_evidence`。0001 严格接纳匹配的完整 v1 库；漂移须停止调查，不重建历史数据。0005 增加永久用户墓碑；0006 将旧批次保留为 legacy 来源，建立 Blob／消息归属约束并清除完成输入原文，未完成输入暂留 7 天。0006 为不可逆原文清理及 v2/0.3 协议调整，调用方必须协调升级，不能走普通 API 更新或恢复旧 API。不要 stamp 或手填 schema 指纹绕过维护。迁移范围见[服务端迁移说明](../src/server/api/migrations/README)与[数据及恢复契约](../src/server/api/V2-DESIGN.md)。

本轮 `migrate-schema`／`finalize-schema` 仅允许 Test。操作顺序：

1. 暂停外部写入，核对旧任务、processing／failed buffer、用户锁／队列及未知写入；确认结果，不清空状态来制造“无在途”。
2. 通过下述 `backup` 取得 PostgreSQL＋Redis 配套切点，导出受保护的离机副本；用 `restore-data` 在隔离环境恢复，成功后由工具写 `restore-verified.json`，不能手工编造回执。
3. 保存 root:root 0600 的候选维护证据，在 `.deploy` 下引用对应备份目录和隔离恢复目录；保留停写直到本次迁移及业务验收完成。
4. 执行 `migrate-schema /opt/memoia IMAGE SOURCE_SHA RUN_ID COMPOSE_SHA256 PREFLIGHT_JSON`。脚本校验候选 revision／Test HEAD、高水位、现有配置、备份哈希及真正恢复回执，先审计静止状态，记录旧 accepted/schema、pending-maintenance、候选指纹，再正常停止旧 API。停止后复查旧状态，才从候选镜像显式 `alembic upgrade head`＋`check_schema()`，随后仅启动 API；PG、Redis、宿主机 Tunnel 均不重启。
5. 实际完成鉴权、幂等查询／重放、消息撤回、画像历史过滤、真实模型和 embedding 验收，保存受保护的证据文件。执行 `finalize-schema /opt/memoia IMAGE SOURCE_SHA RUN_ID COMPOSE_SHA256 BUSINESS_JSON`，才更新已验收 schema 和 API 身份。普通 finalize 不能接纳 pending-maintenance；普通 prepare 仍拒绝 schema 指纹变化。

`PREFLIGHT_JSON` 格式（身份必须对应同一候选，不含秘密）：

```json
{
  "image": "ghcr.io/jianify/memoia@sha256:实际总manifest",
  "source_sha": "实际40位SHA",
  "run_id": "实际Actions运行ID",
  "writers_paused": true,
  "unknown_results_resolved": true,
  "backup_directory": "/opt/memoia/.deploy/backups/实际备份ID",
  "restore_directory": "/opt/memoia/rehearsals/restore-实际恢复ID"
}
```

这两项人工确认不能替代脚本前后两次的状态审计、备份校验和恢复证明。`BUSINESS_JSON` 使用相同 image/source_sha/run_id，附 `checks` 对象，键为 `authentication`、`source_replay`、`retract`、`profile_history`、`model`、`embedding`，各项只有真实通过才能为 true；另附非空 `evidence_files` 数组，每项为 `.deploy` 下 root:root 0600 证据文件的 `path` 和实际 `sha256`。模型 stub／本地测试不能填作真实调用通过。

开发阶段 Test 数据明确可丢弃、且操作员单独授权不可恢复迁移时，`PREFLIGHT_JSON` 可显式使用 `data_policy: "disposable-test"`，省略备份／恢复目录和外部停写确认；身份与 `unknown_results_resolved: true` 仍必填。该策略不创建备份，不承诺恢复，记录 `backup_sha256: null`；仅接受 `memoia-test`／test 配置，仍正常停止 API、前后审计未完成处理、保留失败诊断及执行真实业务验收。不清空旧任务或未知结果。默认仍为 `backup-required`，不能自动判断数据不重要或将此例外用于 Online。

迁移失败保留 pending、旧指纹和诊断，不自动清标记重入或启动可能不兼容的旧 API。成功后旧 accepted/schema 进入 `.deploy/schema-archives/RUN_ID`，不再作为普通 restore-api 的恢复目标；run 高水位不下降。已产生需保留的新数据时不能用旧快照覆盖当前库。需要特殊恢复时先确认数据库实际 revision 和兼容性，交付前向修复或隔离恢复方案。

## GitHub Actions

`verify.yml` 验证 main PR/merge queue，并供发布调用，不构建 Memoia Docker 镜像。手动 `deploy-test.yml` 核对当前 test → publish 验证 → AMD64 发布/匿名拉取 → 受门禁控制的部署；无 QEMU。历史多架构镜像可复用，但 AMD64、源码和 schema 必须通过验证。`release` push 不运行 Actions。

只有当前 release HEAD 的稳定 `v*` tag 才进入 Online：publish 验证 → AMD64/ARM64 原生 runner 各构建一次 → 校验架构、源码、真实 schema 指纹 → 汇总并核对同一 manifest digest → online 审批 → 部署该 digest；审批后不重建。已存在版本只校验/复用；注册表错误不能当作不存在。平台回执限定当前 run，失败重跑仅替换该架构回执，汇总仍检查 SHA/digest/schema。不同 SHA 不假设 Test/Online 镜像相同。GHCR 必须 Public，服务器不持有 GitHub 写权限。Online 主机/凭据/恢复和真实模型验收仍独立，不因 CI 通过而自动视为完成。

首次安装/业务验收前，仓库级 `MEMOIA_TEST_DEPLOY_ENABLED` 保持关闭；当前测试环境已完成初装，该门闩按实际状态启用。test Environment 限 test 分支，online Environment 限 `v*` 标签并配置 Required Reviewer。GitHub Actions 直接连接服务器公网 SSH，不再经过 Cloudflare Tunnel 或依赖 Access Service Token；业务 HTTPS API 继续使用宿主机 Tunnel。

test Environment 配置：

- Environment Secrets：DEPLOY_HOST 填服务器公网 IPv4 或直接解析到该主机的 DNS hostname；DEPLOY_PORT 填实际 SSH 端口；DEPLOY_USER 填专用 github 账号。三者必须填写，不从 Variables 读取，也不使用公开的端口默认值。
- 其余 Environment Secrets：DEPLOY_SSH_PRIVATE_KEY、DEPLOY_SSH_KNOWN_HOSTS、MEMOIA_TEST_BEARER_TOKEN。CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET 不再被工作流读取，已有值可由操作员移除。
- 部署凭据设置入口为 Settings → Environments → test → Environment secrets；非敏感部署门闩 `MEMOIA_TEST_DEPLOY_ENABLED` 的设置入口为 Settings → Secrets and variables → Actions → Variables，必须使用仓库级 Variable。已有与凭据同名的 Variables 不会被新工作流使用，迁移完成后可移除。环境限制继续保留，首次安装与专用密钥/业务验收完成前不得打开门闩。
- IP 不是认证凭据，但部署目标不必在公开代码或日志中展示。Secrets 避免明文存储目标值并提供日志遮罩；遮罩不能代替权限、可信工作流和防火墙，也不能保证所有变形后的值自动隐藏。具体语义见 [GitHub Secrets 官方说明](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)。
- 独立部署公钥由操作员配置到 /home/github/.ssh/authorized_keys，github:github 0700/0600；专用私钥不复用 Lightsail PEM 或本机 GitHub 账号私钥。服务运行 token 仍只在 /opt/jianify/.env，与 SSH 部署凭据分离。
- DEPLOY_SSH_KNOWN_HOSTS 必须匹配新的直连目标：端口 22 使用 `host key-type public-key`，其它端口使用 `[host]:port key-type public-key`。从可信渠道核验主机指纹后配置；不能沿用仅包含 Tunnel hostname 的记录，也不在 CI 中盲目信任 ssh-keyscan 结果。
- 公网 SSH 端口必须在 Lightsail IPv4/IPv6 规则和主机防火墙中允许 runner 到达；不能只放行个人电脑 IP，也不关闭公网 SSH。若使用域名，它必须直接解析到服务器，不能使用 Cloudflare HTTP 代理或仍指向 Tunnel 的 SSH hostname。普通 GitHub 托管 runner 没有此项目专用的固定出口地址，接受公网入口风险并维护密钥、sshd 登录策略和系统安全更新；地址范围及允许列表边界见 [GitHub 官方说明](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#ip-addresses)。

Actions 只上传脚本到 .deploy/candidates，不覆盖 Compose/.env/YAML。sudo -n 执行，公网 smoke 成功再 finalize 和写成功 Deployment。SSH 使用严格 host key 校验、专用 identity、连接超时/保活，不读取 runner 的 SSH 配置或启用代理；成功与失败退出均清理临时私钥/known_hosts。仍须使用专用部署密钥实际验证非交互 SSH + sudo，并完成远端 Actions 验收；人工 ubuntu + PEM 直连不能代替它。

需要显式 schema 维护时，手动 Test 工作流选择 `deploy=false`：仍完成 Verify、镜像发布、源码／架构／匿名拉取校验及候选记录，但不访问部署 Environment、不调用普通 prepare/finalize，也不标记成功 Deployment。随后使用同一 SHA／run／digest 的候选走上述维护入口；缺省 `deploy=true` 仍为普通部署。

日常 smoke 只验收基础部署：健康、Bearer 正反例及探针用户创建/读取/删除。Deployment 状态与 Actions summary 明确记录此范围，不代表完整记忆业务通过。首次部署、修改记忆处理或模型/embedding 配置时，使用已有 verify-sdk.py 工具单独完成核心闭环并记录候选 digest；不在每次普通发布中自动运行全套真实模型探针，也不新增通用排空机制。

同 digest 重跑只证明部署通道；A→B 更新和 B→A 恢复需要两个不同兼容 digest，未完成不得宣称通过。

## 恢复与备份

旧嵌套目录 `/opt/jianify/memoia` 不作为兼容入口，脚本不会从该处自动搬移配置或数据。2026-09-26 的空目录及 Tunnel 路径维护记录只是当时的阶段证据；截至 2026-09-30，Test API 已在 `/opt/memoia` 运行，并完成实际发布和业务探针验收。后续恢复不能启动旧目录中的另一套服务共用当前数据。

首次失败无旧镜像可回滚，保留数据/诊断、停止候选 API。不用旧快照覆盖新数据。兼容 API 恢复沿用正常停止/启动流程，不检查调用方是否停写；不兼容处理协议、schema/embedding 变化和配套数据恢复单独迁移演练。

`restore-api /opt/memoia IMAGE SOURCE_SHA RUN_ID COMPOSE_SHA256` 只接受 previous-accepted 中的上一已验收版本，要求当前配置、schema 和持久化处理协议兼容；按同一服务停止/启动流程切换，随后公网验收并 finalize。恢复不会降低 run 高水位，也不恢复旧数据库快照。恢复不是失败后的自动动作。

`backup /opt/memoia` 不依赖 standalone-mode，但仍要求当前已验收、无 pending/处理中或失败 buffer/锁队列，以及无 v2 处理中操作或处理／重建中的批次。这是配套备份的静止切点要求，不是日常发布门禁。正常停 API、复查静止切点后从公司 PostgreSQL 容器只导出 `memoia` 数据库，再同步 Redis SAVE 并确认 OK；API 停止期间业务写入不可用，不另查消费者身份。配套数据、配置、哈希、表行数、固定 PG 镜像身份与持久 Redis 探针保存在 .deploy/backups/唯一目录。公司实例备份不能代替这份 PG／Redis 配套恢复。仅切点成功才恢复同一 API；失败保留 pending-maintenance 与停写状态，人工核查，不自动重试。备份含秘密，必须保护并导出服务器外，不能放公开 artifact。

备份仍由操作员手动触发，不新增定时任务。备份与 schema 维护共用只读静止检查：明确识别 0006 前的 Source 状态模型和 0006 后的 Blob 状态模型，分别阻断处理中操作及处理／重建中的批次；字段缺失、两种模型混杂或未知结构直接失败，不清理任务或跳过检查。`test_schema_adoption.py` 在真实隔离 PostgreSQL 上覆盖迁移前后模型、处理／重建状态和结构漂移，不能替代真实配套备份与恢复演练。

`restore-data /opt/memoia BACKUP_DIRECTORY /opt/memoia/rehearsals/restore-UNIQUE` 只接受完整校验通过的本地配套备份及从未存在的目标目录；空但已存在的目录也拒绝。使用备份记录的 PG 镜像临时启动独立 PostgreSQL，给予它隔离网络内的 `jianify-postgres` 别名，绝不接入正式 `jianify-data`；Redis 和 API 同样使用独立 project/network/config/data，显式 --project-name 防止 .env 的正式 project 名覆盖隔离身份。不挂 Tunnel，不映射任何主机端口，检查解析后的连接目标及实际挂载。DB 和 Redis 使用 internal 网络；只有隔离 API 可通过自己的独立 ingress 网络外连模型，启动时仍需真实模型／embedding 检查，不能完全断网却宣称应用恢复通过。先关闭 AOF 加载 RDB，验证持久探针及 PG 表行数；再启用 AOF、等重写完成、正常停止、按正式 AOF 配置重启后再次验证，最后启动隔离 API 并验证健康及实际连接／网络。全部完成才写 root:root 0600 的 restore-verified.json，绑定备份 manifest 哈希、API digest、表行数、project、挂载、连接身份及 AOF 重启证明，供 schema 维护读取。失败不写成功回执，保留隔离数据供排查；不覆盖、清空或恢复当前业务库。

入口与自动测试不能代替真实验收。2026-09-30 测试环境数据库切换已记录配套备份、迁移后业务读写和实际容量；隔离恢复工具保留，不额外重复演练。镜像版本更新／恢复与远端 Actions 的验收仍按各自发布规则执行；Online 主机、Secrets、备份与恢复未验收，不能把工作流就绪误写为生产可发布。

## 自动验证

ShellCheck/actionlint/Bash 语法仅静态验证。test_workflow.py 解析真实 workflow 并执行部署步骤的原始 shell，mock SSH/git/smoke 等外部命令，覆盖直连参数、缺失配置、非法输入、旧提交、SSH 失败和凭据清理。发布边界测试在一次性 Linux 容器 mock 外部系统；recovery 测试覆盖隔离身份与 RDB→AOF 顺序。均不连接真实 DB/Cloudflare/GitHub，不代替真实业务/恢复验收。

`verify-sdk.py create|verify|cleanup|inspect|no-event|verify-auth HTTPS_ORIGIN RECEIPT` 使用仓库内未改名 SDK，token 仅从 stdin 读取。create 验证小批量显式 flush、大批量插入自动完成、最终事件 ID、画像与真实 embedding 搜索；verify 不重放写入；cleanup 仅操作属于探针的已知事件和用户；inspect 只读核查未知结果。no-event 是条件探针，真实模型不保证问候语一定生成空摘要；有效事件会使该探针不通过，而不是服务协议失败，已知 ID 必须保存并人工核查，不能放宽业务校验。合法 event_id:null、空摘要和 parser 拒绝空 JSON 另有自动协议测试。receipt 先于每次外部写入持久记录阶段，任何未知结果保留且拒绝重跑。不把 blob ID 当 event ID。实际响应异常或 timeout 后先核查，不能通过删除 receipt 开始新一轮重放。

### v2 TypeScript SDK 真实探针

`v2-sdk-probe.mjs PATH_TO_UNPACKED_SDK/dist/index.js` 只加载固定 `@jianify/memoia` 0.5.0 已构建产物，不安装依赖、不构建源码、不重新打 SDK 包。stdin 是一个 JSON 对象：`origin` 为 HTTPS origin（服务器本机也允许 loopback HTTP），`token` 为独立项目 Bearer，`deadline_ms` 为整体等待预算，默认 360000、上限 900000；地址和 token 不放 argv 或日志。输入与输出都应保存为 root:root 0600 的受保护文件，不进入公开 artifact。探针的专用两消息来源必须确认消息、Blob、证据的 next_*_offset 全为 null，不能以部分页证明重放或删除完整性。

探针使用随机 UUID 的专用新用户，分别验证缺失／错误 Bearer、首次导入隐式创建用户、固定幂等键和 operation ID 的结果查询、来源证据、非空画像、事件搜索、真实画像历史。只有首次导入已明确 completed 后，才进行一次显式幂等重放：以完全相同正文和 key 再 POST，必须立即返回同一已完成操作及 source/event IDs，重新读取来源、画像和专用用户的完整事件列表，确认身份和数量不增长。随后撤回一条消息验证剩余证据，撤回另一条验证画像／来源证据／历史内容／事件不再返回失效内容。历史审计行可以保留，但其失效画像内容不能返回。原有业务检查全部通过后，调用 v2 `forgetUser`，严格确认同 UUID／`forgotten: true` 提交回执；只有这次回执确认后，才明确重复一次同 UUID 的 DELETE 验证幂等。随后使用预先记录的新 key／external ID 单次尝试迟到导入，必须是 SDK `MemoiaError` 的 HTTP 410／`user_forgotten`／`retryable: false`／`outcome: rejected`，普通 404、鉴权失败或意外接纳均不通过。

除已确认完成的导入回放和已确认提交的遗忘重复这两项明确测试外，每个 mutation 最多发送一次。导入仍 processing 或丢失 ACK 未确认时只按固定 key 查询，绝不重发正文、自动调用 retryOperation 或重置身份；遗忘、遗忘重复或迟到导入的未知结果直接失败，不发送后续 mutation，也不自动清理。迟到导入若意外返回 operation，保留全部已知 operation/source/event/profile IDs，不因为它已 completed 或 failed 就把验收记为通过。

正常路径已永久遗忘本次随机用户，最后仅通过读取确认不存在；进入遗忘阶段后绝不退回 v1 普通 DELETE 掩盖失败。遗忘前的已知失败仍可用原有 v1 普通删除清理探针用户，但不构成永久遗忘证明。CLI stdout 是逐行 JSON：每个写入前的 `kind: boundary`／`stage: *.before` 记录先保存 UUID、固定 key 和累积已知票据；收到回执后再追加 `*.receipt`、`*.rejected` 或 `*.unknown` 检查点，最后一条 `kind: result` 是最终结果。内容仅含布尔检查、UUID／幂等键、阶段和计数，不包含 token、URL 或正文。`runProbe` 的可选异步 `checkpoint` 回调默认无操作，返回对象不变；提供回调时必须等待保存完成，回调拒绝就停止后续写入，包括失败清理。

真实验收应把 CLI stdout 直接追加到已创建的受保护普通文件；CLI 等待每行写完，并仅在 stdout FD 确为普通文件时执行 fsync，再越过写入边界。管道、终端或 Docker stdout 转发只能证明本进程完成流写入，不证明接收端已持久化，不用于进程退出保护验收。不要用 `>` 覆盖旧失败证据。最终验收读取最后一个 `kind: result`，不把中间 `success: false` 的 boundary 当作最终结果；只有 `*.before` 没有确认回执时，保守视为未知，不自动重放。任一业务检查失败、结果未知、检查点保存失败或清理无法确认，进程均退出非零；保留 user_id、import_key、late_import_key 和所有已知 ID 供核查，不通过重跑新用户替代核查。若进程在首个边界前退出、没有输出，需从服务端操作记录和日志核查，不能宣称已经清理。独立加载修订探针时应记录脚本 SHA 与固定 SDK 包 SHA；不把尚未进入镜像的探针修订宣称为该镜像源码的一部分。

可使用本机受支持 Node，或复用已验收的 Inspector Node 镜像执行。容器必须把 stdout 重定向到单独挂载的证据普通文件，而不是依赖 Docker stdout 转发；脚本与 SDK 仍只读，凭据仅走 stdin。例如操作员确认下面的实际唯一路径和 digest 后运行：

```bash
sudo -n sh -c '
  umask 077
  mkdir -m 700 /opt/memoia/.deploy/v2-probe-UNIQUE
  : > /opt/memoia/.deploy/v2-probe-UNIQUE/evidence.ndjson
  exec docker run --rm -i --read-only --user 0:0 --network host \
    --mount type=bind,source=/opt/memoia/.deploy/candidates/RUN_ID/v2-sdk-probe.mjs,target=/probe.mjs,readonly \
    --mount type=bind,source=/opt/memoia/.deploy/candidates/RUN_ID/sdk/package,target=/sdk,readonly \
    --mount type=bind,source=/opt/memoia/.deploy/v2-probe-UNIQUE/evidence.ndjson,target=/receipt.ndjson \
    --entrypoint sh ghcr.io/jianify/memoia-inspector@sha256:已验收的镜像digest \
    -c "exec node /probe.mjs /sdk/dist/index.js >> /receipt.ndjson" \
    < /opt/memoia/.deploy/v2-probe-input.json
'
```

只有真实服务未使用模型 mock、实际配置启用事件 embedding 且供应商调用证据吻合时，才能把导入／搜索成功记为模型与 embedding 通过；单独 `embedding_search=true` 不证明服务启用了向量调用。脚本级测试 `node --test deploy/tests/test_v2_sdk_probe.mjs` 使用假 SDK／本机 HTTP 边界，验证探针自己的重放、deadline、过滤、清理、脱敏、检查点拒绝停写和进程退出留证行为，不是业务验收。原 v1 SDK 探针继续保留，v2 不替代旧契约回归。

2026-09-27 首次真实验收发现人工 .env 的数据根误写成 dat，备份的实际挂载检查正确阻断；已通过单独停写备份和目录维护校正，SDK 原事件仍可读。必须核验解析和运行时挂载，不能只核验模板或预建空目录；日常发布不能自动搬数据。详见 validation 记录。

时间证据版本使用 0007 与 SDK 0.4：只新增可空事件时间和原时区字段，不自动回填或撤销既有事实。发布前按隔离迁移、契约与召回证据验收；旧 API 镜像不能当作删除已保存时间证据的回退方式。
