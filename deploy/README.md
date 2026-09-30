# Memoia 配置与发布

仓库维护模板/脚本，服务器不构建源码。test/online 使用相同路径，实际值由操作员填写。脚本可创建目录、设置配置权限、生成缺失模板；不生成密钥、不覆盖已有值。日常发布不得改写配置，online 保持关闭。

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

test 填 JIANIFY_ENV=test、COMPOSE_PROJECT_NAME=memoia-test、API_HOSTS=https://test-memoia.jianify.dev。online 填对应环境/project/域名，但发布入口仍拒绝 online。两台服务器的数据根均为 /opt/memoia/data。

填写数据库/Redis 密码、ACCESS_TOKEN、固定 PROJECT_ID、LLM/embedding 密钥和连接 URL。数据库固定为 `postgresql://jianify_app:<URL-encoded password>@jianify-postgres:5432/memoia`，连接公司私有网络中的 `memoia` 数据库；Redis 仍使用本 Compose 的 `redis` 服务名。共享应用登录角色也可连接公司的 `gatus` 数据库，因此这里不宣称按角色隔离两个库；应用只使用自己的数据库名。provider/endpoint/模型/维度/处理参数放在 api/config.yaml，密钥通过 .env 注入；示例模型仍需实际调用验收。

MEMOIA_IMAGE 可填初始候选总 manifest digest，不用 latest；所有应用入口仍要求显式传入 digest，覆盖仅限本次 Compose 进程，不改写 .env。PG 镜像由公司固定，Redis 模板在本仓库固定 digest。真实配置、密钥、备份和私钥不进入 Git/镜像/公开 artifact。

## 首次安装边界

本 Compose 只有 Redis、API；公司 PostgreSQL 在 `/opt/postgres` 独立管理，先部署并通过 `postgresctl.py status` 验证，不允许日常 Memoia 发布重建它。数据库网络 `jianify-data` 为外部私有网络，Redis 无主机端口、开启 AOF，认证 healthcheck 确认 PONG。API 仅 127.0.0.1:8000；宿主机 Tunnel 连接该地址，应用 Compose 不含 cloudflared。YAML 使用只读 bind，不允许缺失文件被自动建成目录。

首次启动由操作员使用 `deploy-memoia.sh init /opt/memoia IMAGE SOURCE_SHA RUN_ID COMPOSE_SHA256`。init-config 不等于安装或验收。init 必须确认无现有应用容器、Redis 数据目录和公司 `memoia` 数据库均为空、解析后的 Redis 挂载与数据库网络正确、公司 PostgreSQL 状态健康。启动后保留 pending，不能自动宣称业务通过；分别验证真实模型、embedding、Bearer 正反例、SDK 写入/flush/最终事件 ID/画像与事件/删除、重启持久性、容量和 IPv4/IPv6 无公网旁路，再 finalize。空库用现有初始化，没有可用 Alembic 链，不运行虚构 upgrade head。

已有 test 部署迁往公司 PostgreSQL 只做一次真实停写切换，不运行 `init`，也不增加隔离恢复演练。按以下顺序执行：

1. 推送含新部署脚本和 Compose 的 test 提交前，先将 GitHub **Repository Variable** `MEMOIA_TEST_DEPLOY_ENABLED` 设为 `false` 并核对（Settings → Secrets and variables → Actions → Variables）。`deploy-test` 的 job-level `if` 在读取 test Environment 配置之前求值，因此放在 Environment Variables 中不能控制这个门闩。test 推送仍会测试、构建和发布候选镜像；该门闩使 `deploy-test` 跳过。否则工作流会把新脚本传到仍使用旧 Compose 的服务器并调用 `prepare`，在切换前失败。跳过的 job 也不会传输新脚本，因此接纳阶段须单独将已审查的 `deploy-memoia.sh`、`infra-fingerprint.sh`、`schema-fingerprint.sh` 和 `recovery.py` 放入同一受保护的服务器候选目录。
2. 停止**旧 API 并保持关闭**作为唯一写入门闩，不需要额外配置 WAF。旧 PostgreSQL 此时必须继续运行，才能产生一致的逻辑 dump；它在备份成功、离机保存及核对后才停止。先核对服务器的旧 Compose、已验收镜像及实际运行脚本与固定源码 `54c0ba7` 一致，再按 [一次性补丁说明](cutover/README.md)生成独立候选，不覆盖旧脚本。使用候选的 `backup-cutover`：它先检查静止的 buffer／Redis 状态，正常停止旧 API，再复核状态、导出配套 PG／Redis、保存原格式清单和哈希，成功时确认旧 API 仍停止，**不会重新启动**。普通 `backup` 行为保持原样，不能用于本次迁库。

   在共享 `codex` 终端核对旧 API 容器已退出且无自动重启、旧 PG／Redis 仍运行，公网 Memoia API 已不能接收写入，所有有效写入方只经此 API；旧 Compose 的 PG／Redis 无公网端口。`MEMOIA_TEST_DEPLOY_ENABLED=false` 继续保持，迁移窗口禁止人工发布或启动旧 API。备份失败时先核对 API 实际状态：前置检查失败可能发生在停机之前，停机后的失败则保留 `pending-maintenance`；两种情况都不得假定已经停写并继续迁移。成功后离机保存完整备份，并核对哈希、逐表行数、旧实例和迁移期容量。旧清单不符合新版 `recovery.py restore-data` 的输入格式，不能交给新版恢复入口；保留旧脚本、旧 Compose、旧 PG 数据目录及配套恢复说明作为回退证据。若发现其他可直连旧库的写入者，停止切换，不能把 API 已停当作完整停写证明。
3. 公司 PG 管理员确认目标 `memoia` 库为空、`vector` 已安装。正常停止旧 PG，旧数据目录保持不动；Redis 保持运行，供新 API 使用。恢复旧 dump 时使用 `--no-owner --no-acl --no-comments --role=jianify_app`，确保新表及序列归应用账号所有；仅以 `postgres` 连接并加 `--no-owner` 会使新对象归 `postgres`，Memoia 随后无法正常写入。旧备份路径以本次 `backup-cutover` 的实际回执为准，示例命令在共享终端执行，不会输出连接密码：

   ```bash
   sudo -n sh -c 'docker compose --env-file /opt/postgres/.env -f /opt/postgres/compose.yaml \
     exec -T postgres pg_restore --exit-on-error --no-owner --no-acl --no-comments \
     --role=jianify_app -U postgres -d memoia < "$1"' \
     sh /opt/memoia/.deploy/backups/ACTUAL_BACKUP_ID/postgres.dump
   ```

   此命令没有使用 `--single-transaction`；如果恢复中途失败，继续保持 API 关闭，检查目标库、通过公司 PostgreSQL 管理入口恢复为空目标库，再从同一份已校验备份重试；不得在部分恢复的库上直接重跑。成功后逐表核对行数与旧备份清单一致、`vector` 存在，并确认 `public` 中表、视图和序列没有非 `jianify_app` 所有者。以下查询必须返回 `0`：

   ```bash
   sudo -n docker compose --env-file /opt/postgres/.env -f /opt/postgres/compose.yaml \
     exec -T postgres psql -X -U postgres -d memoia -Atc \
     "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S')
        AND pg_get_userbyid(c.relowner) <> 'jianify_app';"
   ```

   随后切换服务器 Compose／`.env`，用 `deploy-state` 中原已验收镜像启动连接新库的 API，验证真实业务读写、embedding 查询、Redis 持久状态与实际容量。此时重新开放 API 已是**新库的正式写入切点**，不可再用旧库快照覆盖它；不需要为了迁移本身另建 WAF 例外。API 健康检查只验证数据库连接和 Redis ping，启动还可能自动建表，不能替代逐表核对。接纳脚本不会核对旧备份哈希或逐表行数，以上证据须在启动新 API 前人工记录。受控 HTTPS SDK 探针应明确使用新 API，不能在旧 API 上执行。
4. 使用新候选脚本执行 `deploy-memoia.sh adopt-external-postgres /opt/memoia IMAGE SOURCE_SHA RUN_ID NEW_COMPOSE_SHA256`；IMAGE、SOURCE_SHA、RUN_ID 必须与切换前的 `deploy-state` 一致，Compose 哈希取服务器新文件。该入口只在当前镜像健康、运行时数据库连接与新配置一致、旧 PG 已停、公司 PostgreSQL 与 Redis 均合格时更新基线，保存旧记录并清除旧基础设施下的 `previous-accepted`。接纳和业务验收完成后，按后续发布需要重新开启自动部署。

普通 `prepare` 不会自动接受基础设施漂移。切换前的 PostgreSQL 数据目录只保留为受保护回退证据，不由 `init-config` 更改或清除；新库发生写入后，不能直接回退旧数据。

init 记录 infra-config.sha256 和 schema.sha256；前者包含公司 PostgreSQL 只读配置指纹、Memoia Redis、外部网络与应用连接契约，后者只读取镜像内 ORM、建表连接层和迁移源码，不导入应用或连接 DB。Memoia 独立管理自己的服务生命周期；是否已有 Luvel 等消费者不作为日常发布资格，不再创建或读取 standalone-mode 标记。

## 日常发布

deploy-memoia.sh prepare/finalize 使用固定根目录、传入的 digest/SHA/run ID/Compose hash，sudo -n 运行，不依赖继承调用者秘密环境。

- 配置只读；MEMOIA_IMAGE 仅临时传入 Compose，不写 .env 或额外 image.env。
- .deploy 保存锁、pending、成功身份、公司 PG/本地 Redis 容器及宿主机 Tunnel 身份。失败保留待确认记录，后续发布阻断，不盲目清除/重放。
- 仅 --no-deps --no-build 更新 API；不重启基础设施，不跑 bootstrap、不调整 Swap。
- 切换前核对实际 API 镜像与 deploy-state 的已验收 digest；人工替换造成漂移或缺少成功记录时停止，不自动修改记录来接受漂移。prepare 和 restore-api 使用同一检查，init 不要求已有版本。
- 拉取及 OCI revision/schema 校验在停机前完成；旧 API 停止后必须 exit 0。超时强杀/非正常退出保留 pending，不继续启动候选。队列空或锁不存在不能替代退出判据。
- 当前只部署 test；旧 run/较新 HEAD/未完成的上次发布或维护/配置变化/Tunnel 未连接仍阻断。日常 prepare 和 restore-api 不查询 processing/failed buffer 或 Redis 锁队列，也不要求调用方先停写。
- 指纹包含公司 PG 脱敏配置指纹、Redis/挂载/连接、外部网络及完整 YAML 哈希，同维度的 provider、模型或 endpoint 变化也不能静默发布。配置变更单独维护；仅轮换 .env 中密钥不等于向量迁移。两阶段间配置或 PG 容器变化禁止提交成功。

.env 的 MEMOIA_IMAGE 是初始人工选择，后续实际版本以 .deploy/deploy-state 为准。不要直接用旧 .env 重建 API；恢复必须指定已验收 digest 并确认 schema/处理状态。finalize 保存 accepted/SHA；切到不同镜像时才更新 previous-accepted。相同版本重验不会覆盖真正的上一版本。

日常更新假定候选与现有 schema、持久化队列和处理状态兼容；拉取镜像后正常停止旧 API，再启动新 API，接受短暂不可用。正常退出不等于每个请求已向调用方返回最终结果；中断/超时的写入由业务链保留未知结果，不在部署脚本中清队列、重置状态或自动重放。数据库结构、embedding 身份或处理状态协议不兼容的变化走单独维护，不沿用普通发布入口。

## GitHub Actions

publish.yaml 沿用分支门禁：普通分支/PR 验证，test 双架构发布并匿名拉取，release/tag 复用成功 test Deployment 的同 SHA 总 digest。同仓库、同 SHA 的候选发布串行执行，不取消正在发布的 job；进入 job 后再次检查已有候选，避免 push 与手动运行同时覆盖候选标签。GHCR 需 Public；服务器没有 GitHub 写权限凭据。

首次安装/业务验收前，仓库级 `MEMOIA_TEST_DEPLOY_ENABLED` 保持关闭。test Environment 限 test 分支。GitHub Actions 直接连接服务器公网 SSH，不再经过 Cloudflare Tunnel 或依赖 Access Service Token；业务 HTTPS API 继续使用宿主机 Tunnel。

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

## 恢复及未完成项

旧嵌套目录 /opt/jianify/memoia 不作为兼容入口，脚本不会自动搬移配置或数据。服务器若有已运行的旧部署，先单独核对停写、在途处理、挂载和记录，再安排路径维护；不能直接启动第二套服务使用同一数据。仅修改源码不能代表服务器路径已切换；Tokyo 测试服务器已单独完成空部署目录移动与宿主机 Tunnel 路径切换，应用仍待配置和启动，详见 Jianify-LLC 的 ops/server/validation/2026-09-26-split-layout.md。

首次失败无旧镜像可回滚，保留数据/诊断、停止候选 API。不用旧快照覆盖新数据。兼容 API 恢复沿用正常停止/启动流程，不检查调用方是否停写；不兼容处理协议、schema/embedding 变化和配套数据恢复单独迁移演练。

`restore-api /opt/memoia IMAGE SOURCE_SHA RUN_ID COMPOSE_SHA256` 只接受 previous-accepted 中的上一已验收版本，要求当前配置、schema 和持久化处理协议兼容；按同一服务停止/启动流程切换，随后公网验收并 finalize。恢复不会降低 run 高水位，也不恢复旧数据库快照。恢复不是失败后的自动动作。

`backup /opt/memoia` 不依赖 standalone-mode，但仍要求当前已验收、无 pending/处理中或失败 buffer/锁队列。这是配套备份的静止切点要求，不是日常发布门禁。正常停 API、复查静止切点后从公司 PostgreSQL 容器只导出 `memoia` 数据库，再同步 Redis SAVE 并确认 OK；API 停止期间业务写入不可用，不另查消费者身份。配套数据、配置、哈希、表行数、固定 PG 镜像身份与持久 Redis 探针保存在 .deploy/backups/唯一目录。公司实例备份不能代替这份 PG／Redis 配套恢复。仅切点成功才恢复同一 API；失败保留 pending-maintenance 与停写状态，人工核查，不自动重试。备份含秘密，必须保护并导出服务器外，不能放公开 artifact。

`restore-data /opt/memoia BACKUP_DIRECTORY /opt/memoia/rehearsals/restore-UNIQUE` 只接受完整校验通过的本地配套备份及从未存在的目标目录；空但已存在的目录也拒绝。使用备份记录的 PG 镜像临时启动独立 PostgreSQL，给予它隔离网络内的 `jianify-postgres` 别名，绝不接入正式 `jianify-data`；Redis 和 API 同样使用独立 project/network/config/data，显式 --project-name 防止 .env 的正式 project 名覆盖隔离身份。不挂 Tunnel，不映射任何主机端口，检查解析后的连接目标及实际挂载。先关闭 AOF 加载 RDB，验证持久探针及 PG 表行数；再启用 AOF、等重写完成、正常停止、按正式 AOF 配置重启后再次验证，最后启动隔离 API 并验证健康。失败保留隔离数据供排查；不覆盖、清空或恢复当前业务库。

入口与自动测试不能代替真实验收。这次测试环境数据库切换记录一次配套备份、迁移后业务读写和实际容量即可；隔离恢复工具保留，不额外重复演练。原有镜像版本更新／恢复与远端 Actions 的验收仍按各自发布规则执行；online 保持关闭。

## 自动验证

ShellCheck/actionlint/Bash 语法仅静态验证。test_workflow.py 解析真实 workflow 并执行部署步骤的原始 shell，mock SSH/git/smoke 等外部命令，覆盖直连参数、缺失配置、非法输入、旧提交、SSH 失败和凭据清理。发布边界测试在一次性 Linux 容器 mock 外部系统；recovery 测试覆盖隔离身份与 RDB→AOF 顺序。均不连接真实 DB/Cloudflare/GitHub，不代替真实业务/恢复验收。

`verify-sdk.py create|verify|cleanup|inspect|no-event|verify-auth HTTPS_ORIGIN RECEIPT` 使用仓库内未改名 SDK，token 仅从 stdin 读取。create 验证小批量显式 flush、大批量插入自动完成、最终事件 ID、画像与真实 embedding 搜索；verify 不重放写入；cleanup 仅操作属于探针的已知事件和用户；inspect 只读核查未知结果。no-event 是条件探针，真实模型不保证问候语一定生成空摘要；有效事件会使该探针不通过，而不是服务协议失败，已知 ID 必须保存并人工核查，不能放宽业务校验。合法 event_id:null、空摘要和 parser 拒绝空 JSON 另有自动协议测试。receipt 先于每次外部写入持久记录阶段，任何未知结果保留且拒绝重跑。不把 blob ID 当 event ID。实际响应异常或 timeout 后先核查，不能通过删除 receipt 开始新一轮重放。

2026-09-27 首次真实验收发现人工 .env 的数据根误写成 dat，备份的实际挂载检查正确阻断；已通过单独停写备份和目录维护校正，SDK 原事件仍可读。必须核验解析和运行时挂载，不能只核验模板或预建空目录；日常发布不能自动搬数据。详见 validation 记录。
