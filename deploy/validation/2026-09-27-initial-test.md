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

两个不同兼容digest的A→B更新和B→A显式恢复、远端Actions自动更新、真实过期/未知发布阻断尚待完成。完整通过前不接入Luvel，也不声称整体测试部署完成。

初始部署Compose指纹：e66db6304e5d99d2c730a7cac774b65d7521de09875a3f4ad01ed89ca0c4ae5b；首次操作使用正在审查的部署脚本，部署配置源码提交将在后续候选B中归档，不能把候选A源码中的旧部署配置认作实际部署配置。
