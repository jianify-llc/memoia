# 日本测试环境首次验收记录

本记录按已取得证据逐步补充；没有列为通过的步骤不得推断已完成。online 部署保持关闭。服务器 IP、密钥、真实配置和备份不放入公开仓库。

## 候选 A / 已通过

- 源码：683cbd0d78becf56827b14c95967bb655add4f7e。
- Actions：36252080792，完整服务测试、双架构构建、匿名拉取、源码标识均成功；应用自动部署当时关闭。
- 总 manifest：ghcr.io/jianify/memoia@sha256:5eae3b18b497a4c37fcef491da4e213f416155da67c02938432bcc6dd19f1dad，linux/amd64 + linux/arm64。
- 目标主机实际匿名拉取并启动；容器 healthy、OOM=false、RestartCount=0。Luna 和 text-embedding-3-large/1536 的真实启动检查完成，HTTPS health 为 200。
- SDK 小批量显式 flush：16.97 秒；大批量 insert 自动处理：17.51 秒。两个最终事件 ID，12 条画像；真实查询 embedding 搜索返回两个事件。跟踪的不是 blob ID。
- 正确 token 可调用；缺失/错误 Bearer 被 HTTP401 拒绝。
- API 正常停止 exit0，重启后原事件、画像、搜索可读。PostgreSQL pgvector=0.8.6，已存向量实际1536维。
- API 仅宿主机127.0.0.1:8000监听，DB/Redis无宿主机端口；IPv4公网8000/5432/6379均不可达。主机有IPv6，监听记录不含业务/DB/Redis IPv6入口；独立公网IPv6探针尚未记录。
- 容器内存读数：API约186MiB、PG约32MiB、Redis约8MiB；主机约1.9GiB RAM、4GiB Swap、49GiB空闲磁盘。一次低负载检查不是容量压测。
- 独立 github SSH密钥、严格host-key校验和sudo -n实测通过；六个test Environment Secrets已设置，test分支限制已设置。远端Actions部署通道仍待验收。

## 独立路径维护

实际.env将数据根误写为/opt/memoia/dat，备份的实际挂载检查阻断，未宣称该次备份成功。已在无外部写入者、处理/失败buffer及Redis锁队列为空的边界，正常停止API、取得pg_dump及同步Redis SAVE快照，再停止PG/Redis并将数据目录改至固定/opt/memoia/data；原空data目录与原配置保留在受保护维护记录内，没有清空或覆盖业务库。

SDK复验原两个事件、12条画像及搜索均通过；实际PG/Redis挂载已校正。Tunnel MainPID=23138、启动时间2026-09-26T12:45:40Z保持不变。此处基础设施容器重建属于显式路径维护，不是日常API更新验收。

新初始化门禁检查解析后的数据路径，以及API连接是否匹配本地PG/Redis服务、DB/角色/密码；不再仅核验模板和预建空目录。

## 空摘要探针边界

真实“Hello!”输入产生了有效事件，并未返回空摘要；不将它宣称为live event_id:null通过。只读核查确认事件ID及全部buffer为空，没有重放insert/flush。空摘要adapter/业务无事件、空JSON parser失败和完成状态严格拒绝由自动协议测试覆盖，未为启动或验收放宽正式校验。

## 尚待完成

配套备份20260926T173109Z-f7b3a3a1已成功取得并复制到操作员本机受保护目录，全部文件0600、哈希与manifest一致。隔离project memoia-restore-20260927-a无主机业务端口/无Tunnel路由：PG表行数与备份一致；Redis先从新RDB加载持久探针，启用AOF等待重写完成，正常停止并以AOF配置重启后探针仍在；隔离API真实查询原用户、两个事件、12条画像和真实embedding搜索均通过。演练后已停止隔离栈，保留数据和诊断，未覆盖当前业务库。

问候语探针事件和账号已通过SDK删除并验证不可查询；核查及清理均使用已知最终事件ID，无insert/flush重放。保留原两事件探针用于后续跨镜像持久性验证。

## 候选 B / 自动更新与恢复

- 源码79a99b989e34779fcfb7525c0c5279649b9497b2；Actions36259960988成功，真实直连SSH、严格host key、github用户、sudo -n、API更新及公网鉴权/CRUD验收后才记录Deployment成功。
- 总manifest：ghcr.io/jianify/memoia@sha256:70b566a63999d6e1cf45e235d20b21b396936e2d32394fc02cac3d7408fcf2af；两架构匿名拉取及源码标识通过。
- A→B后原事件/画像/真实embedding搜索不变；显式B→A恢复后再次通过相同业务读取并finalize，部署run高水位未下降。随后reverify-test Actions36260669595复用B镜像、不重新构建，部署及验收成功。
- 日常API更新和显式恢复中，PG/Redis容器身份及数据挂载、Tunnel进程未变化；源结构指纹一致。真实过期run在切换前被拒绝；未知状态、强杀、OOM、配置漂移等失败门禁由隔离脚本行为测试覆盖，不宣称所有故障都在真实主机注入。
- 真实服务器重启后boot ID改变，Docker/Swap/Tunnel自动恢复，当前Tunnel活动连接4；旧cloudflared容器仍停止且restart=no，隔离恢复栈未意外启动。原两个事件、12条画像及真实embedding搜索再次通过，无OOM。
- 最后通过SDK删除原探针事件及账号，确认不可查询。配套离机备份和隔离恢复已通过，未覆盖业务数据。
- 开始Luvel对接前，MEMOIA_TEST_DEPLOY_ENABLED已关闭，standalone-mode已归档；online保持关闭。外部写入接入后，普通自动发布仍失败关闭，跨系统停写排空需要后续独立建设。

## 验收边界

Memoia独立测试部署、自动更新及兼容API恢复已通过；Luvel实际业务联调另行验收。真实合法无事件未由问候语探针产生，仅协议测试覆盖。未做容量压测、独立公网IPv6探针或所有故障的主机注入。初始化脚本的重复/只读证据在Jianify-LLC运维记录中；其本地运维改动尚未归档为新提交，不冒充已有baseline提交产物。

初始部署Compose指纹：e66db6304e5d99d2c730a7cac774b65d7521de09875a3f4ad01ed89ca0c4ae5b；首次操作使用正在审查的部署脚本，部署配置源码提交将在后续候选B中归档，不能把候选A源码中的旧部署配置认作实际部署配置。

## Luvel test 连接配置交接 / 2026-09-27

- 仅更新 jianify/luvel 的 GitHub Environment `test`：变量 `MEMOBASE_API_URL=https://test-memoia.jianify.dev`，Secret `MEMOBASE_PROJECT_TOKEN` 对应当前 Memoia 测试服务 Bearer，更新时间 2026-09-27T00:58:35Z。token 通过受保护 SSH 读取到进程内存，再通过 gh 标准输入写入；未输出或写入仓库，不轮换服务器凭据。
- Luvel 当前安装的 SDK 对公网 `/api/v1/project/profile_config` 只读调用成功；缺失及错误 Bearer 均返回 HTTP401。Python urllib 默认 User-Agent 的公网请求返回 Cloudflare HTTP403，相同路径使用 curl 标识及实际 JavaScript SDK 则成功；未修改 Cloudflare 规则，不把本次 SDK 探针扩张为 Worker 运行时或写入联调验收。
- API、PostgreSQL、Redis 当前健康，API 仍为候选 B 的已验收 manifest；本次没有重建或重启容器。Memoia test/online 自动部署开关仍为 false。
- 本次不修改 Luvel 源码、不执行其数据库迁移、不触发 Worker 发布。上述 GitHub 配置须由负责 Luvel 的 Agent 在迁移及候选版本核对后，通过既有 Server/Task 发布流程应用；尚未生效于当前运行的 Worker，也不代表实际业务闭环已验收。

### 连接字段改名 / 后续明确决策

- 用户明确要求 Luvel 连接变量统一为 `MEMOIA_API_URL` / `MEMOIA_PROJECT_TOKEN`，覆盖先前保留连接绑定名称的决定；SDK、历史 provider、持久化数据与缓存键仍保持兼容。
- GitHub Environment `test` 新变量为 `https://test-memoia.jianify.dev`，新 Secret 更新时间 2026-09-27T01:15:55Z，沿用当前测试服务 Bearer。已有 JavaScript SDK 再次通过公网只读鉴权验证；没有轮换服务器 token、改动容器或触发发布。
- Luvel 本地已同步配置元数据、Server/Task 的 test/online YAML、adapter 初始化、健康探针、测试夹具及配置文档；真实 `.env.local` 仅更名两项键，既有值逐字保留，不宣称本机开发已切换到新服务。相关配置契约和健康探针共 51 项测试通过，env/backend/server/task/infra 类型检查及六份文档检查通过。12 份受影响 TypeScript 文件的只读 Biome 检查通过；发布验收测试文件的已有格式问题在修改前副本中同样存在，未替其它 Agent 重排内容。
- 本地改动未提交或推送。GitHub 旧名仅为尚未退出的旧发布入口及显式恢复暂留；新版代码不读取旧名作为别名，须由负责 Luvel 发布的 Agent 在新版验收并核对恢复边界后清理。online 凭据未配置，不复制 test 凭据；数据库迁移和 Worker 发布仍由负责 Luvel 的 Agent 完成。

### 本地提交交接

- Luvel `feature/mvp` 已形成独立提交 `f665b6d9cb12a97d62bf4a88da55a5028fb9436a`（`refactor(config): rename Memoia connection bindings`），只含 23 份文件的连接配置改名、配置说明与契约回归，不包含数据库迁移或其它 Agent 的记忆写入及业务改动。
- 拟提交树使用 Git index 导出到隔离快照，重新通过 51 项配置/健康测试、13 份 TypeScript 格式检查、env 类型检查、五份配置文档检查，并在该快照执行正常 pre-commit；未跳过 hook，也未临时覆盖或隐藏主工作区其它改动。此前工作区的既有格式问题仍由原改动 owner 处理，未混入本次提交。
- 混有权益/任务迁移内容的记忆架构说明及未纳入 Git 的迁移交接文件，其余内容留在 Luvel 工作区供原 owner 统一提交；本次提交已独立记录新连接名称及 SDK/历史数据兼容边界。真实 `.env.local` 不纳入 Git。
- 两个仓库仅做本地提交，不推送、不触发 test 部署，不操作 Luvel 数据库；运行中的 Memoia 镜像仍是候选 B，文档提交不代表新应用镜像或 Worker 发布。
