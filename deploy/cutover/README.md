# 旧 PostgreSQL 一次性切换备份

本文件是 2026-09-30 Test 迁库的历史说明，切换和实际业务验收均已完成，不能作为当前发布或再次迁库的操作步骤。现役 API 连接公司 PostgreSQL 的 `memoia` 数据库；日常发布、配套备份和恢复见[部署手册](../README.md)，当次执行证据见[公司监控切换记录](https://github.com/jianify/Jianify-llc/blob/main/ops/monitoring/test-cutover.md)。

这份补丁只应用于线上已验收的 `54c0ba7664261ea2f68b0b3ab6375392d46a13e9` 版部署脚本。它在旧版配套备份入口增加显式 `backup-cutover` 模式：沿用原有运行身份、静止状态、PG／Redis、manifest 和哈希校验，成功后保持旧 API 停止。普通 `backup` 完全沿用原来的重启行为。当前日常脚本已经面向公司 PostgreSQL，不应为了一次迁移增加旧 Compose 兼容路径。

在本机 Memoia 仓库根目录先运行：

```bash
python3 -m unittest discover -s deploy/cutover -p 'verify_legacy_patch.py' -v
```

测试从固定 commit 取回两份旧源码，在临时目录执行正向检查／应用、反向检查／应用及重新正向应用，再做 Bash/Python 语法检查；行为测试验证默认备份重启、切换备份保持停止、失败保留维护标记及重新启动被拒绝。若固定 commit 无法取得或补丁不再适配，停止交接；不要把补丁直接套在当前新版脚本上。

生成一次性候选时，将固定提交中的 `deploy-memoia.sh`、`recovery.py`、`infra-fingerprint.sh` 原样放到新目录，只对前两份应用补丁：

```bash
memoia_repo=$(pwd)
cutover_candidate=$(mktemp -d)
mkdir -p "$cutover_candidate/deploy"
for name in deploy-memoia.sh recovery.py infra-fingerprint.sh; do
  git show "54c0ba7664261ea2f68b0b3ab6375392d46a13e9:deploy/$name" \
    > "$cutover_candidate/deploy/$name"
done
( cd "$cutover_candidate" &&
  git apply --unidiff-zero --check "$memoia_repo/deploy/cutover/54c0ba7-keep-api-stopped.patch" &&
  git apply --unidiff-zero "$memoia_repo/deploy/cutover/54c0ba7-keep-api-stopped.patch" &&
  git apply --unidiff-zero --reverse --check "$memoia_repo/deploy/cutover/54c0ba7-keep-api-stopped.patch" )
bash -n "$cutover_candidate/deploy/deploy-memoia.sh"
python3 -m py_compile "$cutover_candidate/deploy/recovery.py"
shasum -a 256 "$cutover_candidate"/deploy/*
```

上传前记录候选文件 SHA-256；在测试机共享 `codex` tmux 中核对原有已验收脚本和 Compose 身份，上传到**新的受保护候选目录**，不覆盖原候选、当前脚本、`.env`、Compose 或备份。`recovery.py` 在候选目录读取同目录的旧版 `infra-fingerprint.sh`；不可混入新版指纹脚本。所有远端人工命令遵守 Jianify-LLC 的 `ops/server/agent-operations.md`。

只有在目标仍使用旧 Compose、旧 PostgreSQL、旧 Redis，API 健康，`pending-deploy` 与 `pending-maintenance` 均不存在，仓库级 `MEMOIA_TEST_DEPLOY_ENABLED=false` 时，才在共享终端执行候选入口：

```bash
sudo -n bash /opt/memoia/.deploy/candidates/CUTOVER_CANDIDATE/deploy-memoia.sh \
  backup-cutover /opt/memoia
```

命令会先检查旧 PG／Redis 和待处理状态，正常停止 API 并检查退出码，再导出配套 PG dump、Redis RDB、配置及 `backup.json`。成功时再次确认 API 仍停止，才清除 `pending-maintenance`，以便后续新版 `adopt-external-postgres` 接纳。若失败发生在停机之后，维护标记保留且不会自动重启 API；若停机命令本身失败，API 是否仍在运行必须现场核对。任何失败都不得推定已停写，不自动恢复或重试。

**这里停止的是旧 API，不是先停旧 PostgreSQL。** 在 dump 和 Redis `SAVE` 完成前，旧 PG／Redis 必须继续运行。备份完成后核对容器已停止、127.0.0.1:8000 不再受理请求、旧 PG／Redis 仍健康、备份哈希与表行数，并把配套备份离机保存；随后才停旧 PG。整个窗口禁止手动发布或重启旧 API。若发现任何绕过 API、直连旧 PG／Redis 的写入方，停止切换并另行处理。

旧 PG 数据目录及原始候选保留到新数据库、应用和业务探针验收完成。新 API 接受任何写入后，不能通过恢复旧库快照覆盖新数据；需要回退时先单独制定数据处理方案。旧版 `backup.json` 不能交给新版 `restore-data`，配套回退要使用旧脚本和旧 Compose。完整恢复与接纳步骤见上级 [部署手册](../README.md)。
