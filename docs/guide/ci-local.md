# CI 与本地验证

本分支保留自己的业务源码、Python SDK、镜像打包和数据库实现；不从 Test 提前合入业务或新迁移。

## 本地入口

```bash
python3 scripts/test_push.py install
python3 scripts/verify_local.py --mode quick
python3 scripts/verify_local.py --mode full
python3 scripts/verify_local.py --mode full --base <推送前远端Test的完整SHA>
python3 scripts/test_push.py push
```

quick 固定运行实际 Python SDK 的序列化、鉴权、错误响应及 MockTransport 离线回归。它不启动 PostgreSQL/Redis，不导入会初始化数据库的 API，也不调用真实模型。full 无基线、基线不可读或工作区未提交时扩大为全部检查；有可靠祖先基线时覆盖整个多提交差异：API/SDK/依赖改动运行完整 API 与 Python SDK，工具改动运行其契约及隔离部署/历史维护检查，纯文档只检查差异格式。不用上次成功记录或 HEAD^ 猜范围。

Test 推送只通过 test_push.py push：先取得远端 Test SHA，拒绝脏树和非祖先更新，再 full --base；检查后再次确认 HEAD 和远端 SHA，hook 核对当前进程生成的证明，才允许普通非强制推送。普通开发分支推送不运行全量检查。已有 hook 管理器不会被覆盖。

需要 Python 3.12、uv；完整业务检查还需本机 Docker，相关脚本检查需 ShellCheck；部署隔离夹具需 curl。冻结安装使用本分支的 uv.lock。本地仅复制无凭据源码，排除真实 dotenv/config，使用临时本机 PG/Redis、假模型密钥和独立报告目录；不连接共享数据库或平台。完整 SDK 保留原 SDK 调用及真实 ASGI API，以测试夹具替换固定 localhost 服务和模型边界；缺数据库或跳过用例不能当成功。进程超时/取消与自有容器清理失败都会使检查失败。

## 云端入口

普通开发、Test、release push 均不触发 Actions。main PR、merge_group 和手动 Verify 的 verify 检查仅构建实际候选 AMD64 Docker 镜像，核对平台、revision 和无网络包导入，不推镜像、不运行 API/SDK 业务测试。原 Dockerfile 保持不变；此检查不声称证明镜像拥有本分支尚未打包的迁移或 Alembic 文件。

Test 只手动启动，镜像与部署两个 Job；发布前固定当前 Test HEAD，原生构建 AMD64 或验证复用身份正确且包含 AMD64 的既有 digest。Online 仍限当前 release HEAD 的稳定版本标签，AMD64/ARM64 用对应原生 Runner 独立构建、验证并组装同一不可变 manifest，部署保留 online 审批。缓存只保存 mode=min 最终阶段，按架构区分。标签不重写，既有 digest 不因本轮形式调整而覆盖。

发布源码来源、镜像身份、实际部署/恢复和真实模型业务验收是不同结论。云端构建不替代推送前本地完整验证；普通冒烟不证明完整记忆业务。没有执行的远端验证必须明确标未验证。

本 main 分支尚缺 deploy-memoia.sh、schema-fingerprint.sh、recovery.py、schema-maintenance.py 和 docker-compose.yml；原 Dockerfile 也未打包 migrations/alembic.ini。Test/Online 工作流在任何镜像发布、SSH 或脚本上传前检查其真实文件并阻断缺实现的路径。本批没有补齐发布业务，不能称 main 已具备生产发布能力。待原业务源码正常归档后再验证这些路径，不能用空文件或复制 Test 新业务来通过检查。
