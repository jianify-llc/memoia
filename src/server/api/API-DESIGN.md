# 有界来源与可靠写入

## 不变量与 owner

Luvel 决定消息范围；服务只处理一个完整有界 Blob，不截断正文。来源分组由调用方必传的 source_id 给出（Luvel 使用 dialogId）；幂等键是批次操作身份，正文摘要仅用于拒绝同键不同请求，不用于业务去重。PostgreSQL 保存操作回执、消息关联、事实及支持组；画像和事件是派生结果。

```text
Project → User → Source（外部 source_id）→ Blob（服务端批次 UUID）→ Fact
                    └→ Message（外部 message_id，无正文）← Fact 支持组
```

Source 的自然键是 `(project_id, user_id, source_id)`；Message 再加 message_id，属于 Source 而不是 Blob。每个导入幂等键映射唯一 Blob；Blob 保存该批实际消息 ID，重叠消息不会成为第二次独立证据。同一消息 ID 的正文、角色或发生时间变化报 message_conflict。数据库复合外键约束 Source、Blob、操作、事实与历史的用户／项目归属；证据约束同时验证消息属于批次与 Source、且没有被删除。

唯一接口：`POST /users/{uid}/blobs` 接收 source_id、idempotency_key 和带 message_id 的完整消息；`GET /users/{uid}/blobs/{blobId}` 查询批次；`GET /users/{uid}/sources/{sourceId}` 查询分组。`DELETE /users/{uid}/sources/{sourceId}/messages` 接收 message_ids 与稳定幂等键，内部清理证据、重建记忆；对外只称“删除消息”，不另暴露撤回 API。上述路径都在 `/api` 下，project_id 只能来自鉴权。没有 Blob 取消或编辑能力；删除 Event 仍仅删除派生事件，不撤回消息。

同一用户所有生成、修改、撤回使用 Redis 的 owner lease。续租使用 compare-and-expire，释放使用 compare-and-delete。模型等待不占数据库连接。新 owner 在数据库登记 generation；提交同时比较 generation 和读快照的 version，CAS 失败整个事务回滚，禁止仅重试 INSERT。

不再提供独立 insert/flush HTTP 流程。来源导入登记 processing/completed/failed 回执，接受与完成不同；调用方只按固定操作身份查询或显式恢复。历史 buffer 数据和内部清理原语仍保留用于既有在途数据维护，不作为兼容 API，切换时不删除未完成任务。

注册、快照、正式提交与永久遗忘使用同一项目／UUID 的 PostgreSQL `pg_advisory_xact_lock`，稳定 SHA-256 的长度安全 JSON 键归一 UUID；不使用 Python 随机 hash 或 session lock。lease 关联的 SQL Session 在 after_begin 通过已开始事务的 Connection 先取得锁，避免既有行锁与遗忘形成反向锁序。锁只属于短 SQL 事务，commit／rollback／close 结束后释放，不能跨模型 await；非记忆计费事务明确跳过。Redis 负责协调长计算，SQL 锁与 generation/version 负责所有正式数据提交的串行正确性，不再维护第二个长期锁 owner。

导入先登记可查询的 processing 操作，随后计算。事实、证据、派生结果、completed 回执与原文清理在同一个事务提交。调用响应丢失可以查询原结果；模型失败且已确认事务未提交可以用同一个键恢复。取消或数据库结果未知时不写 failed。批次和操作唯一约束是最终去重依据。

原文只临时保存在未完成 import 的 memory_operations.request，Source／Blob 均不保存 payload。完成后 request 仅保留来源和幂等键；历史 chat GeneralBlob 同事务清除，即使旧 persistent_blob 配置为 true 也不归档聊天。事实必须是精简结论，不复制整段聊天。

未完成输入默认保留 7 天（source_input_retention_seconds），普通重试不延长期限；每 60 秒清理过期正文，服务停止期间恢复启动后继续清理。期限不是独立任务平台，也不承诺原文清除后仍能独立重新抽取。到期 retry 返回 input_required；调用方先查原回执，确未完成再用原完整批次、原键显式补交，不能盲目重发或换成幸存消息。旧输入无真实外部消息身份，过期未处理 chat Blob 无独立恢复保证。

前向迁移 0006 把旧批次迁到 Blob，来源保留为 legacy:<旧 UUID>，不猜测 dialogId；待处理旧输入继续保留，迁移时给予 7 天清理期限。完成操作 request、旧 Source payload 和已完成历史 chat Blob 原文清除；保留旧事实／关联／回执。该清理不可逆，迁移不修改旧版本、不清空未完成任务。备份、WAL、快照中的历史正文不由此迁移安全擦除，也不能拿旧快照覆盖当前已删除状态；它们需要独立的数据保留策略。

## 证据与删除

一个支持组中的消息共同支持一个事实；多个组是独立的替代支持。撤回任意消息使包含它的整个组失效，其他完整支持组保留。事实抽取只使用来源正文，不把助手建议或旧摘要当成用户的正面证据。汇总对每个候选事实必须给出处理结论，不能部分解析后成功。

事实的 occurred_at 是当前有效支持消息的最大发生时间；导入与撤回共用计算规则。撤回较新独立支持时，时间与支持组在同一事务回退，事件时间随剩余来源事实重建，不沿用被撤回证据的时间。

画像重整以变更事实所属的完整 topic 为起点，按现有画像的 fact_ids 和画像目标 topic 递归扩展关联主题；该范围包含仍有效但 included=false 的旧事实，允许撤回纠正后恢复旧支持。模型只收到该范围，必须完整返回所有候选结论，不得输出范围外画像；事务只替换受影响主题，无关画像保留 ID、正文、更新时间。全量来源与事实仍在数据库，暂仍全量读取用于确定关联，不宣称 SQL 读取成本已与历史无关。主题分类及已有关系是本轮计算边界，不保证识别此前未关联的任意跨主题语义冲突；真实模型需验证分类稳定性及纠正语义。

撤回在删除事实/隐藏画像的同一事务把已闭合的 reconcile_topics 写入原操作的内部 request，不修改业务幂等 hash；取消或失败恢复仍以它为起点并扩展当前关联，不因原事实已消失而丢失范围。它由服务端持有，不是新的公开输入字段。单个相关范围仍可能超限，明确返回 reconciliation_too_large、retryable=false，不能截断或自动重放相同输入；input_too_long 继续表示输入/抽取预算拒绝。维护调整预算或相关证据后，可显式调用原 operations/{id}/retry 重新计算历史容量失败，同一回执及 CAS 边界不变；其它不可重试失败仍拒绝恢复。重建失败时已撤回证据和派生隐藏状态不回滚为可读。

撤回先以数据库事务撤销支持并隐藏受影响的派生结果，再从剩余有效事实重建；计算失败时隐藏状态保持，操作可恢复。历史接口保存已提交画像的版本、差异及事实／来源 ID；读取时只返回仍有有效证据的画像，撤回时清理涉及失效证据的历史正文，不提供恢复已撤回内容的入口。操作列表是独立接口，不能把操作日志当作画像历史。所有读取共用正式画像和事件表，不返回已隐藏的派生内容；无来源的旧／手工画像保留，不宣称其可精确撤回。

删除事件只删除事件与索引，并保留 Blob 上不含正文的删除标记，后续重建不得重新创建它。不删除来源消息贡献或画像。编辑事件必须重建 embedding/gist，并在同一事务替换。

事件标签也是派生结果，保存在事件上，不在来源上另存重复快照。导入使用经过项目定义校验的抽取标签；撤回重建仅把剩余有效来源事实和当前项目标签定义交给严格模型生成标签，不能复用含已撤回事实的旧标签值。标签生成失败时旧事件继续隐藏，按同一持久操作恢复；没有剩余事实或没有配置标签时不额外调用模型。

客户端不能伪造或清除画像的内部事实／来源关联。手工编辑派生画像保留原证据关系；证据撤回后仍会隐藏它。手工编辑不新增来源事实，后续事实汇总可能重新生成该画像。

永久遗忘必须显式调用 `DELETE /api/users/{user_id}`，返回严格 `{user_id, forgotten: true}`。同一短事务中先写项目／UUID 墓碑，再级联清理用户、原始来源、事实、操作和派生记忆；墓碑无 User 外键，不能随用户数据消失。重复遗忘（包括从未创建的用户）稳定成功且不改首次遗忘时间。这个纯数据库操作是长计算 lease 的明确例外：不等待 Redis/model，而是用相同 SQL 锁线性化；已开始计算的旧执行者在快照或正式提交遇到墓碑，回滚并返回 HTTP 410 `user_forgotten`，`retryable: false`。取消发生在事务提交前则全部回滚；响应或 COMMIT 确认丢失后可显式再次遗忘相同 UUID，不能凭单次 GET404 推断遗忘成功。

永久遗忘后，该项目／UUID 的 create、import、retry 均被拒绝；跨项目相同 UUID 不受影响。墓碑不保存正文，只随所属项目删除才级联。没有公开恢复身份或绕过墓碑的参数。

## 协议、安全与检索

协议真相源为 FastAPI 路由和 Pydantic 模型；`export-openapi.py openapi.json` 生成冻结的 OpenAPI，TypeScript SDK 从它生成类型和运行时校验。首次导入或删除消息可在已鉴权项目创建尚未永久遗忘的用户／Source，与回执同事务；删除未知消息也登记无正文墓碑，防止迟到导入重新恢复贡献。查询和 retry 不创建用户。账号永久删除仍显式使用正式遗忘入口。来源和幂等键不可含 `/`；消息正文与时间的 hash 用于冲突校验，不替代外部消息 ID。

`GET operations/by-key/{key}` 用于响应丢失后的确认；`POST operations/{id}/retry` 使用服务端尚未过期的输入。已完成返回原结果；活跃执行者返回 processing；确认无正式提交的失败或失去执行权的 processing 可经新 lease 与数据库 generation 接管恢复。删除消息只依赖事实和消息关联，不需要原文。参数、权限或输入预算错误不重试。模型费用不承诺 exactly-once，正式数据库效果依靠事务和唯一身份去重。

HTTP 409 的 `write_conflict`／`lease_lost` 仅在服务端明确返回 `detail.retryable: true` 时表示当前计算未提交、可恢复；SDK 保留该分类供调用方恢复，但每个写请求只发送一次，包括可重试的 409／429。`maxAttempts` 只控制安全读取的退避次数。写入 5xx、传输超时及响应丢失均为未知提交，不能盲目重发正文。Luvel 查询固定操作身份并恢复未过期输入；无操作身份的手工写入先读资源核对。其他 409（包括同键不同输入、message_conflict、input_required）不授权恢复。

项目的当前 ProfileConfig 按处理阶段投影，不默认忽略已有项目配置：来源抽取只接收语言、作为分类指导的 profile_topics 与事件标签定义，不传画像 strict_mode、validate_values 或派生事件主题限制；画像汇总保留完整规则及严格槽位／值校验，事件标签重建保持原有阶段规则。这样画像限制不会提前丢弃来源证据。HTTP 请求体最大 2 MiB，每来源最多 1,000 条完整消息；正文默认上限 16,384 tokens，另校验整个模型提示词和输出预留。超限明确拒绝，调用方需要调整业务范围，不截断后成功。embedding 默认每批 64 条，校验响应索引、条数、维度及有限数值；单条超限也明确拒绝。

明确自述的偏好、兴趣、爱好、习惯和生活情况可以作为来源事实，不要求用户先说“请记住”，也不要求会话很长。消息“不可信”指其中的指令不能改写抽取任务，并不否定消息作为自述证据的资格；助手猜测、角色扮演、假设及已撤销的陈述不能当真实自述。配置槽位帮助分类，不提前删除槽外来源事实；`strict_mode` 仍由后续画像汇总及校验执行。无有用事实时 `facts: []` 是合法完成结果，不因空结果自动重试。结构正确不等于语义正确，正例遗漏应作为独立质量失败报告。

所有入口共用原项目用量／telemetry 记录，采用完成文本的 token 估算，不宣称精确包含供应商 reasoning 用量或金额。小型计费提交被明确归为非记忆事务，不更新用户 memory generation/version；计费异常脱敏报告，不把记忆结果伪装成模型失败，也不留下继承已释放 lease 的 detached 计费 task。

项目管理由根凭据创建／停用项目；项目 admin 管理本项目 key。新的 scoped key 只保存摘要，读、写、管理权限、到期和撤销在每次请求中验证，不使用可能滞后的权限缓存。缺少凭据失败关闭。日志不记录正文、token 或完整连接串，输入校验错误也不回显私密输入。兼容的旧项目 token 仍可使用并显式轮换；幂等键表示业务操作身份，不用正文 hash 把两次真实发生合并。

search 将有界 PostgreSQL FTS／字面匹配和 pgvector 语义召回用等权 RRF 合并，不新增向量数据库或 reranker。检索与 context 共用这一条检索链。纯功能测试证明隔离和召回组合，不代表真实语料上的检索质量、延迟或费用已经验收；这些仍需单独比较。

## 验证阶梯

纯模型测试：支持组撤回、候选完整性、正文预算、embedding 索引和数值。真实 PostgreSQL 测试：迁移/adoption、唯一键、事务失败、generation/version CAS、响应丢失后的复用。真实 Redis 测试：超 TTL heartbeat、取消、失锁后旧执行者不能写入。真实 ASGI 检查无版本契约、只读 POST scope、私密正文不进入 URL、错误不回显、手工写入和永久删除。SDK 回归后才进行真实模型、Test 升级与隔离恢复。

### 仅计算的抽取质量回归

`python -m memoia_server.source_quality --list` 列出固定合成案例，不加载服务配置或调用模型。执行时从 stdin 读取 JSON：`api_key`、`base_url`（无嵌入凭据的 HTTPS URL）、`model` 必须显式给出；`trials` 默认 1、最大 5，`deadline_seconds` 默认 1200、最大 7200。不要把密钥放到命令参数、仓库或公开 artifact。示意调用为：

```bash
# 由操作员通过受保护输入提供 JSON；不在命令中写入密钥。
python -m memoia_server.source_quality --case self_preferences < /protected/quality-settings.json
```

工具只调用真实 `extract_source`（完整输入、阶段配置投影、预算、OpenAI adapter、严格 schema 和证据 ID 校验），不调用导入受理、汇总、embedding、lease 或正式提交。独立进程禁用 `.env`／`config.yaml` 自动发现及 telemetry listener；禁用服务计费回调并明确阻断 PostgreSQL／Redis 连接。供应商模型费用仍会发生。固定输入是公开合成夹具，输出只含这些夹具的抽取结果及判据，不输出密钥或供应商错误正文。

案例覆盖未要求记住的偏好／兴趣、撤销与纠正、联合指代证据、角色扮演、仅助手、寒暄、提示注入及 strict 槽外证据保留。每次试验只调用一次，不对合法空结果追加重试。若需对照旧提示，通过 stdin 的可选 `extract_system` 提供公开基线文本；输出记录 prompt／schema 的 SHA-256，同一抽取函数、模型和固定夹具保持不变，不在代码中维护第二份旧提示。试验是显式重复采样，不是业务恢复或 SDK 自动重试。

机械判据仅匹配这些英文夹具的概念、列出的明确否定词及支持组；联合指代夹具显式允许两条核心证据、包含用户确认的三条证据及两组共同返回；纠正夹具显式允许单条纠正、旧陈述加纠正及两组共同返回。不自动接受任意额外消息或缺少关键上下文的组。输出始终标记 `human_review_required: true`，还须人工核对事实含义、漏抽和误抽及未覆盖的否定表达，不能将关键词匹配当通用语义证明。工具不验证画像 strict、跨来源汇总、检索、实际 Luvel 调度或业务写入；假 transport 单测也不构成真实模型验收。真实对照须经本任务审查后单独执行。

数据库 schema 从 Alembic 维护；应用 import 不执行 DDL，启动前显式检查 revision、向量维度并初始化根项目。迁移前旧运行环境须停写并按[部署维护流程](../../../deploy/README.md#schema-维护与来源模型升级)取得配套备份和隔离恢复证据，不能手填 schema 指纹绕过普通发布门禁。数据库池每进程默认 8 + 4，模型等待不占连接；多 worker 的总预算须与 PostgreSQL max_connections 配套核对。

## Event time evidence (0.4)

`SourceMessage.occurred_at` is the original message recording instant. Optional `time_zone` supplies its original IANA zone. Extraction receives a server-derived local recording date only when that zone is known; processing time is never the anchor. `memory_facts.event_time` is separate JSONB: inclusive ISO date bounds, year/month/day/range/unknown precision, and verbatim expressions citing jointly supported original message IDs. A calendar month or year does not assert a day or duration. Unknown event time is null or an unknown range with retained evidence. Occurrence dates belong in event_time, not surviving fact text.

Source evidence and search expose event_time plus source message recording times/zones. context renders the same evidence and provenance, and counts it in the existing token budget. New imports and ordinary withdrawal rebuilds derive retrieval text from fact content plus supported event_time: ISO year/month/day at the recorded precision, or both endpoints with a range label; null/unknown time leaves the fact text alone. Each gist stores this projection in search_text and embeds it once. New events have no whole-event vector; event_tip retains the combined projection for display. Original facts and gist content retain their independent plain content; recording times and source IDs are not embedded as event dates.

Search and context share bounded lexical/vector rank fusion at fact granularity (each branch contributes 1 / (60 + rank)). Search groups the selected facts by event for association; context retains global fact order so unrelated facts cannot inherit an event's relevance. Temporary query embedding failure retains lexical candidates; input/configuration rejection remains an error. Stored events without gists use their existing event text/vector as a read fallback, without restoring an old API or rebuilding history. Neither endpoint parses query dates or adds a temporal score, and semantic search does not filter old events by recording age. Query negations, corrections, ordering and intervals remain natural-language meaning for the caller and evidence-aware response model. This supports everyday recall, not exact temporal filtering or exhaustive listing. Recent non-search listings keep their recording-time window. Unknown event dates remain valid candidates.

The shared document projection uses existing complete-text embedding limits and batches, without truncation, another model call, schema changes or a reindex job. Withdrawal removes unsupported time from both derived text and regenerated vectors; failure keeps old derived events hidden until the existing operation resumes. Existing indexes are not bulk rebuilt, and completed idempotent replays do not generate vectors again.

Withdrawal clears event_time when its anchor no longer belongs to a surviving support group. A fact with independent untimed support may remain. Optional timezone enrichment preserves the existing message hash; conflicting known zones are rejected. Missing timezone is omitted from operation fingerprints for old request replay compatibility. Existing facts are not reinterpreted or backfilled from record timestamps. Migration 0007 is forward-only; SDK 0.7.0 adds the required context entries contract without another database migration.

## 唯一协议与上下文读取

FastAPI 只挂 `/api`，旧版本路径返回失败，不挂 alias。JSON 成功响应是业务对象，错误使用真实 HTTP 状态及受控 `detail`，不再叠加 errno envelope。唯一 SDK `@jianify/memoia` 由 `openapi.json` 生成类型和校验器；软件版本仍按 SemVer 发布。

`POST /users/{uid}/search` 接收 query/limit；`POST /users/{uid}/context` 接收 query/max_token_size，返回有序完整事实 `entries` 及 `context = entries.join("\n\n")`。两者是 read scope，查询不进入 URL。context 按事实排名逐条计算正文与证据预算，跳过放不下的条目；没有证据的历史事件仍可读。Luvel 请求 1500-token 返回目标，再以转义及包装后的 2048-token 提供方预算逐条裁决，不能从拼接字符串猜边界。query=null 才使用按记录时间的近期列表，语义检索不按记录年龄排除旧事。画像独立由 GET profiles 读取。

用户创建/列表/读取、手工画像、事件列表/删除、项目配置和用量复用既有 controller 与同一 lease/fence；只有永久遗忘保留既有短 SQL 事务例外。时间、来源、回执、墓碑及历史存储无需为接口重命名而迁移。
