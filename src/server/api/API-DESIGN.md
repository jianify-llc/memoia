# Fact 写入与串行派生维护

## 不变量与归属

Fact 是有证据的记忆；Profile 整理长期属性和人物关系，Event 组织故事。后两者不能修改 Fact 或产生新的事实依据。Luvel 决定消息范围并压缩分段；Memoia 只处理一个完整有界 Blob，不建设第二套分块或通用任务平台。

```text
Project → User → Source（调用方 source_id）
                    ├→ Message（调用方 message_id，无正文）
                    └→ Blob（服务端批次 UUID）→ Fact
                                              ├→ 独立检索索引
                                              ├→ Profile（Fact 支撑）
                                              └↔ Event（多对多）
User → flush Operation（固定 Blob 集合）→ 一个 AgentLoop → Profile + Event 原子提交
```

Source 的自然键为 (project_id, user_id, source_id)，Message 再加 message_id；消息属于 Source，不属于 Blob。幂等键映射唯一导入 Blob，正文 hash 只验证同键同请求，不将两次真实发生去重。重叠消息不能成为第二份独立证据；同消息 ID 的正文、角色或发生时间冲突明确报错。复合外键约束用户、项目、来源、批次与派生关联，不能只靠代码填对字段。

唯一公开协议为无版本的 /api，FastAPI 路由和 Pydantic 是 OpenAPI 真相源；SDK 由冻结 OpenAPI 生成类型及校验器。历史内部 buffer 清理原语不构成旧版本 HTTP 兼容承诺，切换不清空在途数据。

## 写入、回执与原文生命周期

导入路径：
1. 登记可查询的 processing 操作，获取 Redis renewable UserLease。
2. 短 SQL 事务取得 generation/version 和相关 Fact 快照后结束，不持有连接等待模型。
3. 一次有界抽取，校验证据与显式纠正，生成 Fact 检索向量。
4. 同事务保存 Fact、直接索引、消息关联、纠正关系、completed 回执及固定 Blob 变更引用，并清除原文。

completed **只表示 Fact 操作已提交**。回执中的 memory_version 固定，不因后台维护推进而变化；fact_ids 是该次结果，event_ids/profile_ids 不再是等待条件。响应丢失先查询原回执，不重新导入。空事实和重复消息也完成固定 Blob；只有 noop 的 flush 无需模型。

长计算由 compare-and-expire 原子续租、compare-and-delete 释放的 Redis lease 协调；所有正式写入仍比较 SQL generation/version。短事务共用用户级 pg_advisory_xact_lock，与永久遗忘线性化，不跨模型 await。失锁、冲突或提交未知不能写入失败假回执，也不能只重试 INSERT。

原文只临时保存在未完成 import 的 memory_operations.request，Source 和 Blob 不保存正文副本。完成结果、回执和清理同事务提交；完成后 request 只保留操作身份。旧 chat GeneralBlob 同事务清除，不受 persistent_blob 影响。旧 summary Blob 是摘要输入，保留原有独立语义，不把它宣称为完整聊天存档。

未完成输入默认保留七天（source_input_retention_seconds），重试不延长期限；API 每 60 秒清理，到期后 retry 返回 input_required。调用方先确认原回执，确未完成时以原键、原完整批次显式补交。没有原文和可恢复事实时，不承诺服务端可以独立重新抽取。事实是精简结论，不得变相复制完整聊天。日志、调试和 SQL 参数不保存正文或凭据。

## Fact、时间与纠正

抽取保留事实主体、行为、原因、人物、报告者及 certainty；用户及相关人物的有依据信息都可保存。助手只能辅助理解，新增猜测不能成为独立支持。引用、怀疑、否定、角色扮演和用户确认必须保留原有范围。结构校验不能证明语义正确；漏抽和过度推断仍需固定真实模型样例验收。

Fact 正文必须能独立理解，明确包含主体和必要关系，不能仅以 subject 元数据补足“患病”“照顾母亲”等省略主体的片段。certainty 标记所述结论的确定性：怀疑或未确认的内容为 uncertain，即便正文准确写成“用户怀疑”，也不能把被怀疑的结论标成 asserted。

本人的普通 Fact、Profile 和 Event 使用“用户”指代，姓名单独作为身份断言保存，不装饰到无关喜好或经历中。第三方姓名和代词解释若依赖其他消息，每个支持组必须包含所需消息。派生标题、摘要等所有字段也遵循完整 Fact 支撑；旧派生文本不是保留已删除身份信息的证据。提示词约束仍非语义正确性的证明，固定姓名删除用例与真实模型首轮失败必须分别留证。

Fact 不强制分类到画像 topic/subtopic；旧分类只作为 legacy 元数据。一个 support_group 内消息共同支持，多个组是独立替代支持：删除必要消息使整个组失效，不将组缩成剩下半句。事实仍有完整组则保留；重叠批次复用消息身份，不增加证据份数。

显式纠正由 Fact 写入路径有界读取同来源及词法相关历史候选；不是每次加载所有用户历史，也不承诺词法候选穷尽跨来源语义。纠正关系保存自身证据组；删除纠正依据后重新评估旧 Fact 是否有效，不能只看纠正 Fact 是否仍有别的支持。普通时间变化不是旧事实错误。active 与旧 included 独立，included=false 不代表事实无效。

occurred_at 是当前支持消息的最大发生时间；撤回较新独立组后同事务回退。event_time 单独保存事件日期的 inclusive ISO 范围、年/月/日/range/unknown 精度及原消息表达；年月不伪造精确日期。time_zone 是原消息 IANA 时区，处理时刻不是事件日期锚点。删除日期依据立即清除 unsupported event_time 并重建 Fact 向量。

请求最大 2 MiB、每批最多 1,000 完整消息、正文默认 16,384 tokens，另校验提示词、相关历史和输出预留。输入过长与相关历史容量不足分别报错，不能截断成功。容量修复后可显式恢复原操作；参数/鉴权错误不自动重试。embedding 每批默认 64，严格校验索引、条数、维度及有限数值。

## 固定 Blob、flush 与统一 AgentLoop

消息导入或删除各有一个固定 Blob；幂等键定位原 Operation/Blob，重试不能扩大消息范围。Fact、索引、回执和 Blob 的 fact_changes（新增、删除、纠正、证据及时间变化引用）同事务提交。Blob 不保存聊天原文。人工 Profile 编辑、Event 删除和 Agent 写入不生产 Blob。

主动 POST flush 或 Worker 定时 flush，在短事务按完成顺序选取完整 Blob；可跨 Source，不跨项目/用户。每次扫描最多 100 个，变更引用与当前有效 Fact 的 JSON 总预算为 256 KiB，不能拆开 Blob。剩余、在途及随后完成的 Blob 留给下一次，pending_blob_count 可见；同键重试不扩大集合。单个 Blob 已超限时固定原集合并明确报 maintenance_capacity，不无限调用模型；恢复仍受容量校验。查询不改变计时，自动静默 30 秒、最长等待 120 秒。空 flush 直接 completed，不调用模型。

Operation(kind=flush) 是唯一调度和恢复身份，source_id/blob_id 为 null；保存固定 Blob 集合、执行租约、generation、尝试次数和下次执行时间，不新增任务 ID 或维护 Task 表。每个项目/用户最多一个有效执行者；短事务领取后释放连接，模型等待不占 Fact 写入锁。失败/退避释放执行权，新批次可继续。首次加三次恢复，间隔 5/15/60 分钟；耗尽保留原失败，显式 retry 原 operation_id 才重开预算，新批次不重置旧次数。

Operation.status 是终态真相源：待领取、执行及自动退避均为 processing，退避可携带 retryable 的末次错误；不可恢复或四次耗尽才为 failed，提交回执后才为 completed。flush.status 对应 pending/running、failed、completed，不独立猜终态。Worker 每轮独立回收过期租约，第四次崩溃也收敛到 failed；重复恢复 processing 不重置预算。

维护校验拒绝使用具体安全错误码（例如 maintenance_invalid_identifier、maintenance_target_unread、maintenance_support_unread）；回执和 Worker 日志保留原 operation_id、次数及是否可重试，不记录模型参数、正文或异常文本。验收探针在清理自己的临时用户前持久化首次错误码，不用后续成功覆盖首次失败。

一个 OpenAI Agents SDK Agent 同时查询并暂存 Profile/Event，模型自行安排处理顺序；不能修改 Fact。只使用 Agent、异步 Runner、函数工具和 Pydantic，不使用 handoff、持久线程、MCP、Shell/文件工具。禁用外部 tracing/正文 debug，transport max_retries=0。项目 llm_model/reasoning_effort 默认继承 gpt-6-luna/high，运行固定配置、最终再次校验；不静默切模型或降低等级。

Fact 用 Standard（service_tier=default）；Loop 先 Flex，临时供应商失败/超时后本轮余下请求用 Standard。只重试未执行工具的模型请求，Flex fallback 同样占一次请求，不重启会话或重置限制。鉴权、输入、拒绝/过滤、失锁和预算错误不能借 fallback 绕过。单次生成最多 32768 tokens，一次 Loop 最多 10 次模型请求/300 秒；无累计 64K 上限，用量仍记录。Responses 适配器 store=false，原生 context_management.compact_threshold=262144；不增加摘要模型调用，数据库读集和暂存修改不压缩。模型/入口真实兼容性单独验收。

初始仅批次概况。read_changes 返回固定变更及当前有效 Fact（不存在时为 null），代码登记实际返回页的读集和覆盖范围；遗漏任一非 noop 变更不能完成，全部检查后不生成派生修改可合法完成。read_memory 精确/分页读取，search_memory 复用同用户混合搜索；stage_profile/stage_event 批量暂存。读取/修改工具以完整条目分页，单页/批最多 64 KiB、200 条，读取默认 100 条，混合搜索最多 20 条；超限不截断正文。取消全局 100 个暂存目标限制。工具读当前数据并登记版本，不按旧 flush 水位过滤，不接受 project/user，不加载全部历史。覆盖校验不能证明模型语义判断正确，真实样例仍需验收。

代码先暂存失去全部有效 Fact 支持的受影响 Profile/Event 删除，模型无需逐条发删除命令；有独立有效支持、无事实关联的人工/legacy 条目不机械删除。该清理与模型修改一起原子提交，读集阻止途中支持恢复或目标被人工修改后误删。

所有修改先保存在本轮内存，最终短事务验证执行权、项目配置、读过的 Fact revision 和目标条目 revision，用既有 Redis renewable lease + SQL generation/version 写入保护。Profile、Event 与 flush completed 回执一起提交；失败两类全部回滚。相关删除/纠正/人工编辑使旧计划失败，无关新增不废弃本轮；旧 flush 恢复重新读取当前事实，不能按历史快照覆盖新结果。永久遗忘立即阻断工具读取及最终提交。日志仅状态、轮数、Token、耗时和安全错误码。

## 删除与派生中间状态

DELETE sources/{source_id}/messages 接收用户定位、message_ids 与稳定幂等键，不需要正文、event_id 或 blob_id。同步处理所有相关 Blob 的支持组、Fact、直接索引、消息墓碑及完成回执，登记该次删除 Blob。重复删除稳定成功；未知消息也写无正文墓碑，迟到导入不能恢复贡献。

**旧 Profile/Event 文本可暂时读取，直到统一 Loop 成功。** 接口/Inspector 显示待更新或失败；失效关联不得作为有效 Fact 证据返回。删除后的旧文本可能暂时进入聊天上下文，维护失败不保证固定时间内消失。历史读取过滤失效证据，不提供恢复已撤回内容的接口。

删除 Event 只删除该事件及派生索引，不改变 Fact 或画像；保存被删除事件 ID 墓碑，后台不能复活该 ID。人工修改增加 revision、保留证据关联，后台旧版本提交失败，不承诺人工文本永远不被后续正常整理替换。

Event 保存 title/summary/keywords/time/location/content，未知为空；interpretation 单独表示解释/推测，不能回写 Fact 或支撑 Profile。同人物/关键词不自动合并故事，Fact 与 Event 多对多。原文已清除，Loop 必须从 Fact 获取背景，遗漏细节不能补造。

Fact 抽取只产生事实，不重复生成 Event 标签或画像分类。新版检索只计算 Fact 向量，EventLoop 不再生成未使用的故事向量；原有 v1/人工 Event 路径独立保留。Fact 删除、纠正或时间证据变化时同步清理相关历史画像；AgentLoop 不能把旧文本或后续未处理 Blob 所涉及的失效文本重新记入历史。当前派生文本允许延迟更新的契约不变。

永久遗忘 DELETE users/{uid} 仍立即阻断读取及后续提交，不采用派生延迟语义。短 SQL 事务写项目/UUID 墓碑并级联清理；不等待长 Redis/model lease。旧执行者提交遇到墓碑返回 410 user_forgotten。重复调用返回同 UUID forgotten=true；墓碑不含正文，不能随 User 清理消失，也没有恢复身份参数。

## 接口、检索与消费者

主要接口（均在 /api 下）：
- POST users/{uid}/blobs：source_id、idempotency_key、带 message_id/role/content/occurred_at 的消息。
- GET users/{uid}/blobs/{blob_id}、sources/{source_id}：有界来源/批次及当前证据。
- POST users/{uid}/flush：稳定 idempotency_key，返回固定集合及 kind=flush 的 Operation。
- GET users/{uid}/operations/by-key/{key}、operations/{id}、POST operations/{id}/retry：查询/恢复原 Fact 或 flush 操作；恢复 flush 不重发正文。
- GET users/{uid}/maintenance：未封闭 Blob 数量及最近 flush 状态、错误、尝试次数和固定 Blob ID。
- DELETE sources/{source_id}/messages：删除消息贡献；DELETE events/{id} 与 DELETE users/{uid} 独立。
- POST search、POST context：私密查询留在 JSON body，使用 read scope。

POST search 的 `query` 保留在请求正文：并行计算查询向量和文本候选，以 pgvector、PostgreSQL FTS/字面匹配融合排序。先按顺序选择完整 Fact，再读取这些 Fact 关联的 Event/Profile；返回 `facts`、`events`、`profiles` 三个独立字段，不把 Fact 包装成 Event，也不新增查询分类模型。相同关联条目去重；三类完整对象及证据共同计入 `max_token_size`（默认 4,000，上限 10,000），放不下整条就跳过，不截断正文或证据。无 Event 的有效 Fact 立即可搜，删除 Event 不影响 Fact 召回。

`exclude_fact_ids`、`exclude_event_ids`、`exclude_profile_ids` 各最多 500 个 UUID。三类输出独立按 ID 排除，不改变数据库，也不新增 revision 协议。已注入 Fact 不再独立输出，但仍可导航到未注入的关联 Event/Profile，包括异步维护后来生成、或上次预算未容纳的条目。候选只保留未见 Fact，或仍关联允许返回的未见派生对象的已见 Fact；两类各有有界候选池，已见 Fact 不挤占未见 Fact 的位置。关联内容和完整证据仍计入响应总预算。调用方在整个 Dialog 内保留实际已注入的 ID：同 ID 后续文本更新仍被该会话排除，新会话自行重置。本人的每轮画像读取仍是独立调用，不因检索排除消失。现有 `include_events=false` 可以明确关闭故事扩展，旧 `event_max_tokens` 可进一步限制故事子预算，但不能突破总预算。临时 query embedding 故障保留词法召回，输入/配置拒绝仍失败。不承诺精确时间过滤或穷尽列举。

`exclude_profile_topics` 接收最多 50 个一级 Topic 名称（每个 1–256 字符），只排除这些分类的关联画像，不排除 Fact/Event。调用方按项目定义选择本人分类；服务端不猜人物归属。默认目录的关系人物 Topic 是 `relationships`，其它预设分类用于本人，项目自定义目录不能套用这一默认假设。超出 ID/Topic 上限明确拒绝；调用方可降级当前可选检索，不能截断集合后重搜或清空整个 Dialog 的去重记录。

原 context 的有序完整 entries 和 entries.join("\\n\\n") 契约保留；结构化检索及 ID 排除使用 search，避免在两个入口复制不同格式的检索协议。query=null 使用近期记录列表，语义检索不按记录年龄排除旧事。无来源的旧手工事件保留明确的 fallback，不伪装成新 Fact 支撑。画像直接读 PostgreSQL，没有 Memoia 或 Luvel 画像缓存。

Luvel 用固定 Fact 回执确认批次/删除，不等待 Event ID；派生失败不得重新导入。压缩、任务调度、Mem0 分支和删除补偿仍由 Luvel 负责。Inspector 保留原页面/可选 Playground，展示状态、原 flush 操作恢复与故事字段；同源写入保护和失败不得报成功不变。

所有写请求只发送一次；HTTP5xx/超时/响应丢失为未知提交，先查回执。retryable=true 的 write_conflict/lease_lost 表示明确未提交，不授权 SDK 盲目重放。安全读可有限退避，幂等键由调用方持有。项目/key scope、到期/撤销逐请求校验，缺少凭据失败关闭，不能跨项目。

## 迁移、发布与验证

Alembic 0008 建立：维护任务、Fact revision/纠正关系、直接索引、派生多对多及版本约束。旧 Fact active=true，不从 included=false 猜失效；机械迁移已有同归属索引/关联，缺失主体/报告者保持 legacy。0009_blob_flush 前向迁移将旧任务进度/变更/失败转为 Blob 引用和可恢复 flush Operation，随后移除旧维护表；旧在途 owner 不延续，原身份及次数保留，重新读当前 Fact，不重新抽取原文。旧删除操作补固定 Blob，未知消息补无正文墓碑。0006 已清除的聊天不能恢复，不用模型猜补；历史备份/WAL 中正文需独立保留策略。

应用 import 不做 DDL，启动检查 head/向量维度。数据库池默认每进程 8+4，多 Worker 必须核对总连接预算。同镜像运行独立 maintenance_worker，Compose/健康/发布/备份均覆盖 API 与 Worker；新 schema 不允许普通 prepare 或旧 API 镜像回退。迁移、提交、共享库和 Test 部署需另行确认，不操作 Online 或云配置。

验证分层报告：纯函数/MockTransport → 隔离真实 PostgreSQL/Redis（迁移、归属反例、事务、接管、新变更、原 flush 恢复、永久遗忘）→ 当前模型真实工具调用/固定语义样例 → Test API → Inspector UI。静态代码、MockTransport 和本地容器不等同真实模型或远端发布验收。

source_quality --list 不加载业务配置/模型；执行显式从受保护 stdin 收模型 JSON，禁用 .env/config 自动发现、计费及数据库连接，只计算公开合成夹具。每次一次抽取，合法空结果不追加抽到通过；固定输出标记 human_review_required=true。M3 过去关系仅保留原文含义，不凭过去时猜分手；新增人物主体、助手推测、两次徒步原因/月份和明确结束关系样例。机械概念/支持组检查不是通用语义证明，模型失败原样保留。真实配置或凭据使用必须单独授权。
