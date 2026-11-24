# Memoia Agent 入口

代码审查、测试和长任务交接遵循 [Jianify 开发规范](https://github.com/jianify-llc/Jianify-LLC/blob/main/docs/engineering/development.md)。本地命令和验证范围见 [开发指南](docs/development.md)。

模型请求组装与缓存遵循 [公司 Prompt／缓存合同](https://github.com/jianify-llc/Jianify-LLC/blob/main/docs/engineering/llm-prompt-cache.md)；本项目场景映射见 [服务端说明](docs/development.md#configuration)。

应用部署见 [deploy/README.md](deploy/README.md)。涉及 Jianify 远端服务器的 Agent 操作，必须先读相邻仓库 `../Jianify-LLC/ops/server/agent-operations.md` 的“Agent 可见运维”；服务器规则由 Jianify-LLC 统一维护，部署脚本及 CI 的执行方式按该章节的边界处理。

公司统一分支与发布规范见 [Jianify-LLC 的 branch-release.md](https://github.com/jianify-llc/Jianify-LLC/blob/main/docs/engineering/branch-release.md)。Memoia 的 Test 与 Online 使用独立工作流；普通开发／Test push 不运行 Actions，Test 由负责人明确手动启动验收批次，Online 由 `release` 的 `v*` 标签触发并等待 `online` Environment 审批。

TypeScript 首发前，以 `feature/mvp` 作为开发基线。新任务从这里开分支，完成后合回这里。需要验收时选定一批提交同步到 `test`。首次发布时将经 Test 验收的 MVP 候选合入 `release`；TypeScript 正式发布并归档到 `main` 后，从 `main` 开新任务。

SQL defaults to standalone statements. Queue tasks must release database transactions and checked-out connections before model calls, external I/O, or retry waits. See [database statements and transactions](docs/development.md#database-statements-and-transactions).
