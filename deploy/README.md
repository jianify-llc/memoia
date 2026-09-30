# Memoia 配置与发布

仓库维护模板/脚本，服务器不构建源码。test/online 使用相同路径，实际值由操作员填写。脚本可创建目录、设置配置权限、生成缺失模板；不生成密钥、不覆盖已有值。日常发布不得改写配置。本轮只验收 test；Online 工作流已准备，主机配置、凭据和恢复验收仍须另行完成。

Agent 操作远端服务器前，必须阅读相邻仓库 `../Jianify-LLC/ops/server/agent-operations.md` 的“Agent 可见运维”。共享终端及既有部署脚本的执行边界以该规范为准。

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

首次启动由操作员使用 `deploy-memoia.sh init /opt/memoia IMAGE SOURCE_SHA RUN_ID COMPOSE_SHA256`。init-config 不等于安装或验收。init 必须确认无现有应用容器、Redis 数据目录和公司 `memoia` 数据库均为空、解析后的 Redis 挂载与数据库网络正确、公司 PostgreSQL 状态健康。启动后保留 pending，不能自动宣称业务通过；分别验证真实模型、embedding、Bearer 正反例、SDK 写入/flush/最终事件 ID/画像与事件/删除、重启持久性、容量和 IPv4/IPv6 无公网旁路，再 finalize。空库用现有初始化，没有可用 Alembic 链，不运行虚构 upgrade head。

2026-09-30，Test 已完成旧独立 PostgreSQL 到公司共享实例 `memoia` 数据库的一次性停写切换；旧 PostgreSQL 已停止，当前 API 连接公司数据库，自动测试发布已重新启用。此后按下文日常发布流程操作，不重跑 `backup-cutover` 或 `adopt-external-postgres`，也不以旧库快照覆盖新写入。一次性候选与旧版补丁见[历史切换说明](cutover/README.md)，实际迁移、数据及业务验收见[公司监控切换记录](https://github.com/jianify/Jianify-llc/blob/main/ops/monitoring/test-cutover.md)。

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

## GitHub Actions

`verify.yaml` 提供共用 CI；`deploy-test.yaml` 只处理普通分支/PR 验证以及 `test` push 的双架构发布、匿名拉取和自动部署；`deploy-online.yaml` 对指向 `release` 的 PR 只做测试和单架构构建、不发布镜像，对 `release` push 独立验证并构建候选，在当前 `release` HEAD 的 `v*` 标签上复用该 SHA 的候选 digest，等待 `online` Environment 指定审核人批准后部署。不同 SHA 不宣称 Test 与 Online 是同一镜像。同仓库、同 SHA 的候选发布串行执行，不取消正在发布的 job；进入 job 后再次检查已有候选，避免并发覆盖候选标签。GHCR 需 Public；服务器没有 GitHub 写权限凭据。Online 的 Secrets、主机和恢复路径尚未配置/验收，因此本轮不得批准 Online 部署。

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

日常 smoke 只验收基础部署：健康、Bearer 正反例及探针用户创建/读取/删除。Deployment 状态与 Actions summary 明确记录此范围，不代表完整记忆业务通过。首次部署、修改记忆处理或模型/embedding 配置时，使用已有 verify-sdk.py 工具单独完成核心闭环并记录候选 digest；不在每次普通发布中自动运行全套真实模型探针，也不新增通用排空机制。

reverify-test 用同 digest，只证明部署通道；A→B 更新和 B→A 恢复需要两个不同兼容 digest，未完成不得宣称通过。

## 恢复与备份

旧嵌套目录 `/opt/jianify/memoia` 不作为兼容入口，脚本不会从该处自动搬移配置或数据。2026-09-26 的空目录及 Tunnel 路径维护记录只是当时的阶段证据；截至 2026-09-30，Test API 已在 `/opt/memoia` 运行，并完成实际发布和业务探针验收。后续恢复不能启动旧目录中的另一套服务共用当前数据。

首次失败无旧镜像可回滚，保留数据/诊断、停止候选 API。不用旧快照覆盖新数据。兼容 API 恢复沿用正常停止/启动流程，不检查调用方是否停写；不兼容处理协议、schema/embedding 变化和配套数据恢复单独迁移演练。

`restore-api /opt/memoia IMAGE SOURCE_SHA RUN_ID COMPOSE_SHA256` 只接受 previous-accepted 中的上一已验收版本，要求当前配置、schema 和持久化处理协议兼容；按同一服务停止/启动流程切换，随后公网验收并 finalize。恢复不会降低 run 高水位，也不恢复旧数据库快照。恢复不是失败后的自动动作。

`backup /opt/memoia` 不依赖 standalone-mode，但仍要求当前已验收、无 pending/处理中或失败 buffer/锁队列。这是配套备份的静止切点要求，不是日常发布门禁。正常停 API、复查静止切点后从公司 PostgreSQL 容器只导出 `memoia` 数据库，再同步 Redis SAVE 并确认 OK；API 停止期间业务写入不可用，不另查消费者身份。配套数据、配置、哈希、表行数、固定 PG 镜像身份与持久 Redis 探针保存在 .deploy/backups/唯一目录。公司实例备份不能代替这份 PG／Redis 配套恢复。仅切点成功才恢复同一 API；失败保留 pending-maintenance 与停写状态，人工核查，不自动重试。备份含秘密，必须保护并导出服务器外，不能放公开 artifact。

`restore-data /opt/memoia BACKUP_DIRECTORY /opt/memoia/rehearsals/restore-UNIQUE` 只接受完整校验通过的本地配套备份及从未存在的目标目录；空但已存在的目录也拒绝。使用备份记录的 PG 镜像临时启动独立 PostgreSQL，给予它隔离网络内的 `jianify-postgres` 别名，绝不接入正式 `jianify-data`；Redis 和 API 同样使用独立 project/network/config/data，显式 --project-name 防止 .env 的正式 project 名覆盖隔离身份。不挂 Tunnel，不映射任何主机端口，检查解析后的连接目标及实际挂载。先关闭 AOF 加载 RDB，验证持久探针及 PG 表行数；再启用 AOF、等重写完成、正常停止、按正式 AOF 配置重启后再次验证，最后启动隔离 API 并验证健康。失败保留隔离数据供排查；不覆盖、清空或恢复当前业务库。

入口与自动测试不能代替真实验收。2026-09-30 测试环境数据库切换已记录配套备份、迁移后业务读写和实际容量；隔离恢复工具保留，不额外重复演练。镜像版本更新／恢复与远端 Actions 的验收仍按各自发布规则执行；Online 主机、Secrets、备份与恢复未验收，不能把工作流就绪误写为生产可发布。

## 自动验证

ShellCheck/actionlint/Bash 语法仅静态验证。test_workflow.py 解析真实 workflow 并执行部署步骤的原始 shell，mock SSH/git/smoke 等外部命令，覆盖直连参数、缺失配置、非法输入、旧提交、SSH 失败和凭据清理。发布边界测试在一次性 Linux 容器 mock 外部系统；recovery 测试覆盖隔离身份与 RDB→AOF 顺序。均不连接真实 DB/Cloudflare/GitHub，不代替真实业务/恢复验收。

`verify-sdk.py create|verify|cleanup|inspect|no-event|verify-auth HTTPS_ORIGIN RECEIPT` 使用仓库内未改名 SDK，token 仅从 stdin 读取。create 验证小批量显式 flush、大批量插入自动完成、最终事件 ID、画像与真实 embedding 搜索；verify 不重放写入；cleanup 仅操作属于探针的已知事件和用户；inspect 只读核查未知结果。no-event 是条件探针，真实模型不保证问候语一定生成空摘要；有效事件会使该探针不通过，而不是服务协议失败，已知 ID 必须保存并人工核查，不能放宽业务校验。合法 event_id:null、空摘要和 parser 拒绝空 JSON 另有自动协议测试。receipt 先于每次外部写入持久记录阶段，任何未知结果保留且拒绝重跑。不把 blob ID 当 event ID。实际响应异常或 timeout 后先核查，不能通过删除 receipt 开始新一轮重放。

2026-09-27 首次真实验收发现人工 .env 的数据根误写成 dat，备份的实际挂载检查正确阻断；已通过单独停写备份和目录维护校正，SDK 原事件仍可读。必须核验解析和运行时挂载，不能只核验模板或预建空目录；日常发布不能自动搬数据。详见 validation 记录。
