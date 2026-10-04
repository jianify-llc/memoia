# Memoia Agent 入口

应用部署见 [deploy/README.md](deploy/README.md)。涉及 Jianify 远端服务器的 Agent 操作，必须先读相邻仓库 `../Jianify-LLC/ops/server/agent-operations.md` 的“Agent 可见运维”；服务器规则由 Jianify-LLC 统一维护，部署脚本及 CI 的执行方式按该章节的边界处理。

公司统一分支与发布规范见 [Jianify-LLC 的 branch-release.md](https://github.com/jianify-llc/Jianify-LLC/blob/main/docs/engineering/branch-release.md)。Memoia 的 Test 与 Online 使用独立工作流；普通开发／Test push 不运行 Actions，Test 由负责人明确手动启动验收批次，Online 由 `release` 的 `v*` 标签触发并等待 `online` Environment 审批。
