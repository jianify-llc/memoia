# Memoia 配置与发布

仓库维护模板/脚本，服务器不构建源码。test/online 使用相同路径，实际值由操作员填写。脚本可创建目录、设置配置权限、生成缺失模板；不生成密钥、不覆盖已有值。日常发布不得改写配置。本轮只验收 test；Online 工作流已准备，主机配置、凭据和恢复验收仍须另行完成。

Agent 操作远端服务器前，必须阅读相邻仓库 `../Jianify-LLC/ops/server/agent-operations.md` 的“Agent 可见运维”。共享终端及既有部署脚本的执行边界以该规范为准。

## 本地检查与明确 Test 验收

分支、Actions 与 hook 规则以[公司规范](https://github.com/jianify-llc/Jianify-LLC/blob/main/docs/engineering/branch-release.md)为准。普通开发分支／Test／release push 及开发 PR 不运行 Actions；归档到 main 的 PR／merge queue 保留 Verify。Test 只有明确验收批次才手动启动，Online 的版本标签、digest 与审批门禁保持不变。

```bash
python3 scripts/test_push.py install
python3 scripts/verify_local.py --mode quick
python3 scripts/verify_local.py --mode full --base <远端Test基线SHA>
python3 scripts/verify_local.py --mode full
# 提交自己的改动后，在准确提交的干净 worktree 中同步 Test：
python3 scripts/test_push.py push
# 仅在负责人明确要求 Test 验收后运行，不是日常 push 的后续步骤：
gh workflow run deploy-test.yml --ref test --repo jianify-llc/memoia
```

本地业务检查使用 `scripts/verify_local.py`，默认 `full`；Actions 只构建镜像并核对身份，不运行此入口。各模式职责：

| 模式 | 业务验证 | 工具验证 |
| --- | --- | --- |
| quick | 固定的纯计算/mock Python、OpenAPI、SDK 生成与 Node 测试；测试进程禁止真实网络、数据库和模型连接 | 始终不启动数据库、Redis 或部署夹具，不代替推送前 full |
| full --base | API、SDK、manifest/lock、构建配置等影响同一部署单元时，运行完整 API、隔离迁移/schema、OpenAPI、Node/Workers SDK；只改文档或工具不无条件运行全套业务 | 按可靠 base 选择 hook、部署、legacy；schema 维护工具改动保留定向隔离数据库检查 |
| full（无 base） | 全部业务验证 | 全部工具、历史迁移和部署夹具 |

`push` 入口取得远端 Test 精确 SHA 后调用 `full --base`。基线缺失、不可读取、不是候选提交的祖先，或手动检查的工作区有未提交改动时扩大到全量；不使用历史成功记录或上一条提交猜基线。文档改动使用 Git 差异检查，hook 改动运行工具回归；部署探针依赖的 `src/client/memobase/` Python SDK 改动也执行业务和部署工具验证。业务 full 使用本批独占 PostgreSQL/Redis。依赖按所选范围要求 Python 3、uv/Python 3.12、Node、pnpm 10.12.4、ShellCheck、curl 和 Docker。依赖下载和公开词表准备不属于离线测试。

quick 每次固定运行 `scripts/verify_local.py` 的离线名单，包含来源提取/证据质量、项目模型配置和 Agents Loop 的纯计算与 MockTransport 回归，以及时间解析、渲染、校验和时区锚定回归；不按业务文件差异跳过。`test_temporal_evidence.py` 同时包含数据库测试，因此只列入其中六个离线测试节点；存储、检索和撤回等集成行为由本地 full 验证。新增有价值的离线回归时同步维护此名单，并在网络禁令下验证。

本地使用排除业务 `.env`、真实 `config.yaml` 的临时源码与不含凭据的 Git 对象；业务子进程使用环境白名单，不继承平台/部署密钥。部署夹具与虚构业务连接配置分层，数据库只用本批独占 PostgreSQL/Redis 随机回环端口。JUnit/覆盖率写入忽略的 `.local-ci-results/<批次>/`，不是检查缓存。部署夹具使用官方 SHA-256 校验的 jq 1.8.1，容器无网络；依赖下载仅保留无认证代理。总预算 20 分钟；只清理本批资源，失败/超时/取消/清理异常均不得报告通过。

环境白名单保留 pnpm 的工具目录 `PNPM_HOME`，保持本地 package store 路径一致；不传递 registry、平台或业务凭据。Actions 不再安装宿主机业务依赖，Docker 的 GHA 缓存按用途/架构区分，导出明确使用 `mode=min`。

Test 长检查先于 Git 连接，hook 按目标 ref 验证本次提交和远端基线；源码／基线改变即重新检查。直接 Test push、force push、删除 Test、脏树或手工复用内部证明均不允许。安装入口遇到已有 hook 管理器停止，不覆盖。仓库文件存在不代表 hook 已安装，也不代表默认分支的手动 workflow 已注册；这些须在合入后核对，不以创建一个 Actions run 验证普通触发规则。

手动 Test 流程在镜像 Job 首先核对选择的是当前 test 提交，后续 stale-deployment 检查继续保留。`MEMOIA_TEST_DEPLOY_ENABLED` 仍决定是否执行真实部署；手动启动并不绕过这个门禁、GHCR 匿名拉取或正常恢复要求。

### 既有工作流的切换顺序

1. 按仓库授权合入 workflow、脚本和 hook；默认分支须包含 `workflow_dispatch` Test 入口，Test 分支保留匹配部署契约。入口注册不要求把未验收应用代码提前合入 main。
2. 只读检查实际工作流源码：Test 无 `push` 触发，Verify 不含普通开发／Test PR 和归档后的重复 push 触发；检查 hook 安装及项目依赖。
3. 确认新源码后执行 `gh workflow enable deploy-test.yml --repo jianify-llc/memoia`。禁止恢复旧 `on: push` 版本。启用本身不创建 run；只有获授权的验收批次才执行上面的手动命令。

本地通过、默认分支入口注册、Test 真实发布分别验收；仅注册入口不能证明候选脚本、迁移或业务已上线。

## Redis 运行边界

Usage 的 `usage_complete=false` 表示已记录的模型调用存在未知用量，总量仅是已记录小计；未知调用按同一日/月 TTL 保留，不估算或扣费。统计读取故障返回 503，不返回零。Redis 写入失败只告警，不重放模型；这些计数与完整性标记都不是财务账本，停机期间未写入、数据丢失或过期仍可能无法重建。

数据库结构指纹只包含 ORM 与 Alembic 配置/迁移，不包含 Redis/连接池实现。旧指纹仅通过已接纳的固定 digest 镜像校验，并比较新旧镜像的同一结构指纹；普通发布完整验收后才更新基线表示。真实 ORM/迁移变化仍必须进入 schema maintenance，不因指纹格式调整绕过迁移门禁。

Redis 只用于用户写入租约与轻量统计，Blob/Operation/flush 排队由 PostgreSQL 负责。API 和 Worker 各自默认最多 32 个连接、连接超时 1 秒、命令超时 2 秒（环境变量见 `.env.example`）；不自动重放 Redis 命令。统计故障不能触发模型重试，Usage 故障明确不可用，缺失供应商用量单独标为未知；计数不是财务账本。

Compose 明确使用 `noeviction`，保留 AOF 和配套恢复；不批量清理历史 Redis key。内存上限必须按实际峰值及余量单独确定，本轮未臆测容量。Redis 启动命令变化影响基础设施指纹，不能通过普通镜像发布偷换服务器配置；需另行授权维护与验收。本地模板不代表 Test 已应用。

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

Luvel 使用固定 SDK 调用 `POST /api/users/{user_id}/search`，JSON body 接收 query、总预算及 Fact/Event/Profile ID 排除，返回三个独立数组。本人画像独立 GET profiles；原 `/context` 保留字符串契约兼容，不复制新检索协议。查询只在正文，错误、日志、Trace 不回显正文。Fact 回执完成不等于 Profile/Event 维护完成；SDK 按回执的固定水位查询维护进度。Memoia、Luvel 和 Inspector 应协调验收，部署与真实业务验收分别记录。

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

本 Compose 包含 Redis、API 和独立 `maintenance` Worker。后两者使用同一 immutable digest、只读配置和项目凭据；Worker 无主机端口，通过 `python -m memoia_server.maintenance_worker` 启动，每进程最多并行处理两个不同用户，同一用户最多一个统一 AgentLoop，Profile/Event 与 flush 回执原子提交。健康检查验证 heartbeat 的时效与 PID 存活，不代表维护任务或真实模型已验收。公司 PostgreSQL 在 `/opt/postgres` 独立管理，日常发布不能重建；API 仅 127.0.0.1:8000，宿主机 Tunnel 仍连接该地址。应用 Compose 不含 cloudflared，Redis 无主机端口、开启 AOF；配置缺失时不能自动建成目录。

首次启动由操作员使用 `deploy-memoia.sh init /opt/memoia IMAGE SOURCE_SHA RUN_ID COMPOSE_SHA256`。init-config 不等于验收。init 确认无既有应用容器、Redis 数据与 Memoia 数据库为空，先启动 Redis，再用候选镜像显式执行 Alembic 和 `check_schema()`；成功后一起启动 API／Worker。迁移失败保留 pending，不启动候选。业务验收要分别确认 Fact 回执、独立事实检索、Profile／Event 达到回执水位、删除和真实模型工具调用；健康检查不能代替这些验收。

2026-09-30，Test 已完成旧独立 PostgreSQL 到公司共享实例 `memoia` 数据库的一次性停写切换；旧 PostgreSQL 已停止，当前 API 连接公司数据库，Test 发布入口已重新启用（本次规范推广后须明确手动验收）。此后按下文日常发布流程操作，不重跑 `backup-cutover` 或 `adopt-external-postgres`，也不以旧库快照覆盖新写入。一次性候选与旧版补丁见[历史切换说明](cutover/README.md)，实际迁移、数据及业务验收见[公司监控切换记录](https://github.com/jianify-llc/Jianify-llc/blob/main/ops/monitoring/test-cutover.md)。

init 记录 infra-config.sha256 和 schema.sha256；前者包含公司 PostgreSQL 只读配置指纹、Memoia Redis、外部网络与应用连接契约，后者只读取镜像内 ORM、Alembic 配置和迁移源码，不包含连接池或 Redis 运行代码，不导入应用或连接 DB。Memoia 独立管理自己的服务生命周期；是否已有 Luvel 等消费者不作为日常发布资格，不再创建或读取 standalone-mode 标记。

## 日常发布

deploy-memoia.sh prepare/finalize 使用固定根目录、传入的 digest/SHA/run ID/Compose hash，sudo -n 运行，不依赖继承调用者秘密环境。

- 配置只读；MEMOIA_IMAGE 仅临时传入 Compose，不写 .env 或额外 image.env。
- .deploy 保存锁、pending、成功身份、公司 PG/本地 Redis 容器及宿主机 Tunnel 身份。失败保留待确认记录，后续发布阻断，不盲目清除/重放。
- 仅 --no-deps --no-build 更新 API 与 Worker；不重启基础设施、不跑 bootstrap、不调整 Swap。
- 切换前核对两个进程的实际镜像、连接配置与 deploy-state；人工替换、Worker 缺失或漂移均阻断。prepare 和 restore-api 使用同一检查。
- 拉取及 OCI revision/schema 校验在停机前完成；API／Worker 都正常退出后才启动同一候选 digest。强杀或非正常退出保留 pending；两个进程分别健康且无 OOM／重启，才能 finalize。队列空不能替代退出判据。
- 旧 run/较新环境分支 HEAD/未完成的上次发布或维护/配置变化/Tunnel 未连接仍阻断。test 检查 `test` HEAD，online 检查 `release` HEAD。日常 prepare 和 restore-api 不查询 processing/failed buffer 或 Redis 锁队列，也不要求调用方先停写。
- 指纹包含公司 PG 脱敏配置指纹、Redis/挂载/连接、外部网络及完整 YAML 哈希，同维度的 provider、模型或 endpoint 变化也不能静默发布。配置变更单独维护；仅轮换 .env 中密钥不等于向量迁移。两阶段间配置或 PG 容器变化禁止提交成功。

.env 的 MEMOIA_IMAGE 是初始人工选择，后续实际版本以 .deploy/deploy-state 为准。不要直接用旧 .env 重建 API；恢复必须指定已验收 digest 并确认 schema/处理状态。finalize 保存 accepted/SHA；切到不同镜像时才更新 previous-accepted。相同版本重验不会覆盖真正的上一版本。

日常更新假定候选与现有 schema、持久化队列和处理状态兼容；拉取镜像后正常停止旧 API／Worker，再启动同 digest 的新 API／Worker，接受短暂不可用。正常退出不等于每个请求已向调用方返回最终结果；中断/超时由业务链查询回执或接管过期租约，不在部署脚本中清队列、重置状态或自动重放。数据库结构、embedding 身份或处理状态协议不兼容的变化走单独维护，不沿用普通发布入口。

## Schema 维护与来源模型升级

现有 v1 库升级 v2 是显式维护，不是普通 `prepare`。当前 Alembic 链依次为 `0001_v1_baseline`、`0002_sources_v2`、`0003_profile_history`、`0004_key_scopes_search`、`0005_user_tombstones`、`0006_source_blob_messages`、`0007_event_time_evidence`、`0008_serial_maintenance`、`0009_blob_flush`。0001 严格接纳匹配的完整 v1 库；漂移须停止调查，不重建历史数据。0005 增加永久用户墓碑；0006 建立 Blob／消息归属约束、保留 legacy 来源并清除完成输入原文，未完成输入暂留 7 天。0008 建立 Fact 独立检索，导入 completed 改为 Fact 提交；0009 将旧维护进度/变更/失败转为固定 Blob 和可恢复 flush Operation 后移除任务表。旧执行租约不延续，不重新抽取已清除正文。不可兼容的协议须协调升级，不能普通更新或恢复旧 API。不要 stamp 或手填 schema 指纹。迁移范围见[服务端迁移说明](../src/server/api/migrations/README)与[数据及恢复契约](../src/server/api/API-DESIGN.md)。

首次增加 Worker 也走这次显式 schema 维护：旧 API／Redis／数据库／网络契约必须与已验收基线相同，且没有旧 Worker。备份策略只允许在旧配套恢复证明上增加同镜像 Worker，不放宽配置或基础设施校验；迁移暂存新的 Worker 指纹，只有两个进程及业务验收通过才接纳。普通 prepare／finalize 仍拒绝拓扑漂移。

本轮 `migrate-schema`／`finalize-schema` 仅允许 Test。操作顺序：

1. 暂停外部写入，核对旧任务、processing／failed buffer、用户锁／队列及未知写入；确认结果，不清空状态来制造“无在途”。
2. 通过下述 `backup` 取得 PostgreSQL＋Redis 配套切点，导出受保护的离机副本；用 `restore-data` 在隔离环境恢复，成功后由工具写 `restore-verified.json`，不能手工编造回执。
3. 保存 root:root 0600 的候选维护证据，在 `.deploy` 下引用对应备份目录和隔离恢复目录；保留停写直到本次迁移及业务验收完成。
4. 执行 `migrate-schema /opt/memoia IMAGE SOURCE_SHA RUN_ID COMPOSE_SHA256 PREFLIGHT_JSON`。校验候选 revision／Test HEAD、高水位、配置、备份及恢复回执，审计静止状态并记录 pending 后，正常停止所有既有应用写入进程。复查旧状态，再从候选镜像执行 `alembic upgrade head`＋`check_schema()`，随后启动同 digest 的 API／Worker；PG、Redis、宿主机 Tunnel 均不重启。
5. 完成鉴权、幂等查询／重放、删除消息、画像历史过滤、真实模型／embedding 与统一 flush 原子提交验收，保存受保护证据。执行 `finalize-schema /opt/memoia IMAGE SOURCE_SHA RUN_ID COMPOSE_SHA256 BUSINESS_JSON`，才更新 schema 和应用身份。普通 finalize 不能接纳 pending-maintenance；普通 prepare 仍拒绝 schema 指纹变化。

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

这两项人工确认不能替代脚本审计、备份校验和恢复证明。`BUSINESS_JSON` 使用相同 image/source_sha/run_id，附 `checks`：`authentication`、`source_replay`、`retract`、`profile_history`、`model`、`embedding`、`flush`，只有真实通过才能为 true；另附非空 `evidence_files`，每项是 `.deploy` 下 root:root 0600 证据文件的 `path` 和实际 `sha256`。模型 stub／本地测试不能填作真实调用通过。

开发阶段 Test 数据明确可丢弃、且操作员单独授权不可恢复迁移时，`PREFLIGHT_JSON` 可显式使用 `data_policy: "disposable-test"`，省略备份／恢复目录和外部停写确认；身份与 `unknown_results_resolved: true` 仍必填。该策略不创建备份，不承诺恢复，记录 `backup_sha256: null`；仅接受 `memoia-test`／test 配置，仍正常停止既有 API／Worker、前后审计未完成处理、保留失败诊断及执行真实业务验收。不清空旧任务或未知结果。默认仍为 `backup-required`，不能自动判断数据不重要或将此例外用于 Online。

迁移失败保留 pending、旧指纹和诊断，不自动清标记重入或启动可能不兼容的旧 API。成功后旧 accepted/schema 进入 `.deploy/schema-archives/RUN_ID`，不再作为普通 restore-api 的恢复目标；run 高水位不下降。已产生需保留的新数据时不能用旧快照覆盖当前库。需要特殊恢复时先确认数据库实际 revision 和兼容性，交付前向修复或隔离恢复方案。

## GitHub Actions

`verify.yml` 仅在 main PR/merge queue 或明确手动运行中构建 AMD64 镜像，不推送，检查源码身份、Python 导入和迁移源码存在；不安装宿主机业务依赖或启动业务 DB/Redis。手动 `deploy-test.yml` 在同一镜像 Job 核对当前 test → AMD64 构建/身份/schema 指纹/匿名拉取 → 受门禁控制的部署；无独立业务 Verify、无 QEMU。历史多架构镜像可复用，但 AMD64、源码和 schema 必须通过验证。`release` push 不运行 Actions。

只有当前 release HEAD 的稳定 `v*` tag 才进入 Online：tag 身份检查 → AMD64/ARM64 原生 runner 各构建一次 → 校验架构、源码、真实 schema 指纹 → 汇总并核对同一 manifest digest → online 审批 → 部署该 digest；审批后不重建。已存在版本只校验/复用；注册表错误不能当作不存在。平台回执限定当前 run，失败重跑仅替换该架构回执，汇总仍检查 SHA/digest/schema。不同 SHA 不假设 Test/Online 镜像相同。GHCR 必须 Public，服务器不持有 GitHub 写权限。Online 主机/凭据/恢复和真实模型验收仍独立，不因 CI 通过而自动视为完成。

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

需要显式 schema 维护时，手动 Test 工作流选择 `deploy=false`：仍完成镜像发布、源码／架构／匿名拉取校验及候选记录，但不访问部署 Environment、不调用普通 prepare/finalize，也不标记成功 Deployment。随后使用同一 SHA／run／digest 的候选走上述维护入口；缺省 `deploy=true` 仍为普通部署。

日常 smoke 只验收基础部署：健康、Bearer 正反例及探针用户创建/读取/删除。Deployment 状态与 Actions summary 明确记录此范围，不代表完整记忆业务通过。首次部署、修改记忆处理或模型/embedding 配置时，使用已有 sdk-probe.mjs 工具单独完成核心闭环并记录候选 digest；不在每次普通发布中自动运行全套真实模型探针，也不新增通用排空机制。

同 digest 重跑只证明部署通道；A→B 更新和 B→A 恢复需要两个不同兼容 digest，未完成不得宣称通过。

## 恢复与备份

旧嵌套目录 `/opt/jianify/memoia` 不作为兼容入口，脚本不会从该处自动搬移配置或数据。2026-09-26 的空目录及 Tunnel 路径维护记录只是当时的阶段证据；截至 2026-09-30，Test API 已在 `/opt/memoia` 运行，并完成实际发布和业务探针验收。后续恢复不能启动旧目录中的另一套服务共用当前数据。

首次失败无旧镜像可回滚，保留数据/诊断、停止候选 API／Worker。不用旧快照覆盖新数据。兼容应用恢复沿用正常停止/启动流程，不检查调用方是否停写；不兼容处理协议、schema/embedding 变化和配套数据恢复单独迁移演练。

`restore-api /opt/memoia IMAGE SOURCE_SHA RUN_ID COMPOSE_SHA256` 只接受 previous-accepted 中的上一已验收版本，要求当前配置、schema 和持久化处理协议兼容；按同一服务停止/启动流程切换，随后公网验收并 finalize。恢复不会降低 run 高水位，也不恢复旧数据库快照。恢复不是失败后的自动动作。

`backup /opt/memoia` 要求当前已验收、无 pending／处理中或失败 buffer／锁队列、v2 未完成操作及有效维护执行租约；待处理任务可保留。这是配套备份的静止切点，不是日常发布门禁。正常停止 API／Worker、复查状态后只导出公司实例的 `memoia` 数据库，再同步 Redis SAVE；切点成功才恢复同一 digest 的两个进程，失败保留 pending-maintenance 和停写状态，不自动重试。配套数据、配置、哈希、行数、固定 PG 身份与持久 Redis 探针保存在 `.deploy/backups/唯一目录`。备份含秘密，需受保护并导出服务器外，不能放公开 artifact；公司实例备份不能代替这份 PG／Redis 配套恢复。

备份仍由操作员手动触发，不新增定时任务。备份与 schema 维护共用只读静止检查：明确识别 0006 前的 Source 状态模型和 0006 后的 Blob 状态模型，分别阻断处理中操作及处理／重建中的批次；字段缺失、两种模型混杂或未知结构直接失败，不清理任务或跳过检查。`test_schema_adoption.py` 在真实隔离 PostgreSQL 上覆盖迁移前后模型、处理／重建状态和结构漂移，不能替代真实配套备份与恢复演练。

`restore-data /opt/memoia BACKUP_DIRECTORY /opt/memoia/rehearsals/restore-UNIQUE` 只接受校验完整的配套备份及从未存在的目标目录。使用备份 PG 镜像，PG／Redis／API／Worker 全部使用独立 project/network/config/data，不接正式 `jianify-data`、不挂 Tunnel、不映射主机端口。旧 API-only 备份只恢复原拓扑。先加载 RDB 核对 Redis 探针及 PG 行数，再启用 AOF、正常停止重启并复查；最后启动备份中的应用进程，验证健康、镜像、挂载和实际连接。隔离 API／Worker 的独立 ingress 可调用模型，保留的待处理任务可能恢复执行，须使用获授权配置；不能断网却声称真实模型恢复通过。全部成功才写 root:root 0600 的 `restore-verified.json`，绑定备份哈希、digest、行数、隔离身份、API／Worker 容器 ID 及 AOF 重启证明。失败不写成功回执，保留隔离数据，不覆盖当前业务库。

入口与自动测试不能代替真实验收。2026-09-30 测试环境数据库切换已记录配套备份、迁移后业务读写和实际容量；隔离恢复工具保留，不额外重复演练。镜像版本更新／恢复与远端 Actions 的验收仍按各自发布规则执行；Online 主机、Secrets、备份与恢复未验收，不能把工作流就绪误写为生产可发布。

## 自动验证

ShellCheck/actionlint/Bash 语法仅静态验证。test_workflow.py 解析真实 workflow 并执行部署步骤的原始 shell，mock SSH/git/smoke 等外部命令，覆盖直连参数、缺失配置、非法输入、旧提交、SSH 失败和凭据清理。发布边界测试在一次性 Linux 容器 mock 外部系统；recovery 测试覆盖隔离身份与 RDB→AOF 顺序。均不连接真实 DB/Cloudflare/GitHub，不代替真实业务/恢复验收。

### TypeScript SDK 真实探针

`sdk-probe.mjs PATH_TO_UNPACKED_SDK/dist/index.js` 只加载固定 `@jianify/memoia` 0.9.1 已构建产物，不安装依赖或重新打包。stdin 是 JSON：`origin` 为 HTTPS origin（服务器本机也允许 loopback HTTP），`token` 为独立项目 Bearer，`deadline_ms` 是整体预算，默认 360000、上限 900000；地址和 token 不放 argv／日志。输入输出保存为 root:root 0600 受保护文件。两消息专用来源必须确认消息／Blob／证据的 next_*_offset 全为 null，不能用部分页证明完整性。Fact 回执确认后单次调用 flush 并查询原操作；核对固定 Blob 归属和两类派生结果，未知回执不重发，不自动恢复失败直到凑绿。

导入／删除 completed 只确认 Fact。探针先验证无需 Event 的 Fact 召回，再单次 flush 并查询该原 Operation，确认固定 Blob 集合完成后才检查画像／Event／历史。超时、失败或退避中的原错误均验收失败，保留原 Operation 和批次，不自动重导入或调用维护恢复；新 flush 的成功不能替代原批次验收。

探针使用随机 UUID 新用户，固定输入含姓名、长期饮食喜好及有明确人物／时间／地点的做饭经历；非空 Event 的验收不要求模型从静态喜好编造故事。验证 Bearer 正反例、隐式创建用户、固定 key／operation 查询、来源证据、Fact 召回、非空画像／Event 和维护版本的画像历史。首次已明确 completed 后只进行一次同正文／key 的幂等重放，必须返回原操作／Fact 水位；重新读取来源、画像和完整事件列表，确认身份和数量不增长。依次删除两条消息，每次等待固定回执水位后验证剩余证据和失效内容过滤。业务检查通过后调用 v2 `forgetUser`，严格确认同 UUID／`forgotten: true`；仅在确认后重复一次同 UUID 的 DELETE。再以预先记录的新 key 单次尝试迟到导入，必须得到 SDK `MemoiaError` HTTP 410／`user_forgotten`／`retryable: false`／`outcome: rejected`，其它拒绝或意外接纳均不通过。

除已确认完成的导入回放和已确认提交的遗忘重复这两项明确测试外，每个 mutation 最多发送一次。导入仍 processing 或丢失 ACK 未确认时只按固定 key 查询，绝不重发正文、自动调用 retryOperation 或重置身份；遗忘、遗忘重复或迟到导入的未知结果直接失败，不发送后续 mutation，也不自动清理。迟到导入若意外返回 operation，保留全部已知 operation/source/event/profile IDs，不因为它已 completed 或 failed 就把验收记为通过。

正常路径已永久遗忘本次随机用户，最后仅通过读取确认不存在；进入遗忘阶段后未知结果停止后续写入。遗忘前的已知失败仅对本批随机用户用同一正式 SDK 永久遗忘清理，并严格确认回执。CLI stdout 是逐行 JSON：每个写入前的 `kind: boundary`／`stage: *.before` 记录先保存 UUID、固定 key 和累积已知票据；收到回执后再追加 `*.receipt`、`*.rejected` 或 `*.unknown` 检查点，最后一条 `kind: result` 是最终结果。内容仅含布尔检查、UUID／幂等键、阶段和计数，不包含 token、URL 或正文。`runProbe` 的可选异步 `checkpoint` 回调默认无操作，返回对象不变；提供回调时必须等待保存完成，回调拒绝就停止后续写入，包括失败清理。

真实验收应把 CLI stdout 直接追加到已创建的受保护普通文件；CLI 等待每行写完，并仅在 stdout FD 确为普通文件时执行 fsync，再越过写入边界。管道、终端或 Docker stdout 转发只能证明本进程完成流写入，不证明接收端已持久化，不用于进程退出保护验收。不要用 `>` 覆盖旧失败证据。最终验收读取最后一个 `kind: result`，不把中间 `success: false` 的 boundary 当作最终结果；只有 `*.before` 没有确认回执时，保守视为未知，不自动重放。任一业务检查失败、结果未知、检查点保存失败或清理无法确认，进程均退出非零；保留 user_id、import_key、late_import_key 和所有已知 ID 供核查，不通过重跑新用户替代核查。若进程在首个边界前退出、没有输出，需从服务端操作记录和日志核查，不能宣称已经清理。独立加载修订探针时应记录脚本 SHA 与固定 SDK 包 SHA；不把尚未进入镜像的探针修订宣称为该镜像源码的一部分。

可使用本机受支持 Node，或复用已验收的 Inspector Node 镜像执行。容器必须把 stdout 重定向到单独挂载的证据普通文件，而不是依赖 Docker stdout 转发；脚本与 SDK 仍只读，凭据仅走 stdin。例如操作员确认下面的实际唯一路径和 digest 后运行：

```bash
sudo -n sh -c '
  umask 077
  mkdir -m 700 /opt/memoia/.deploy/sdk-probe-UNIQUE
  : > /opt/memoia/.deploy/sdk-probe-UNIQUE/evidence.ndjson
  exec docker run --rm -i --read-only --user 0:0 --network host \
    --mount type=bind,source=/opt/memoia/.deploy/candidates/RUN_ID/sdk-probe.mjs,target=/probe.mjs,readonly \
    --mount type=bind,source=/opt/memoia/.deploy/candidates/RUN_ID/sdk/package,target=/sdk,readonly \
    --mount type=bind,source=/opt/memoia/.deploy/sdk-probe-UNIQUE/evidence.ndjson,target=/receipt.ndjson \
    --entrypoint sh ghcr.io/jianify/memoia-inspector@sha256:已验收的镜像digest \
    -c "exec node /probe.mjs /sdk/dist/index.js >> /receipt.ndjson" \
    < /opt/memoia/.deploy/sdk-probe-input.json
'
```

只有真实服务未使用模型 mock、实际配置启用事件 embedding 且供应商调用证据吻合时，才能把导入／搜索成功记为模型与 embedding 通过；单独 `embedding_search=true` 不证明服务启用了向量调用。脚本级测试 `node --test deploy/tests/test_sdk_probe.mjs` 使用假 SDK／本机 HTTP 边界，验证探针自己的重放、deadline、过滤、清理、脱敏、检查点拒绝停写和进程退出留证行为，不是业务验收。旧 SDK 探针已退役；现有探针只覆盖正式协议。

2026-09-27 首次真实验收发现人工 .env 的数据根误写成 dat，备份的实际挂载检查正确阻断；已通过单独停写备份和目录维护校正，SDK 原事件仍可读。必须核验解析和运行时挂载，不能只核验模板或预建空目录；日常发布不能自动搬数据。详见 validation 记录。

时间证据版本使用 0007 与 SDK 0.4：只新增可空事件时间和原时区字段，不自动回填或撤销既有事实。发布前按隔离迁移、契约与召回证据验收；旧 API 镜像不能当作删除已保存时间证据的回退方式。
