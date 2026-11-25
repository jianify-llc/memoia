# Fact 写入与串行派生维护

## 后台推理模式

Fact 抽取与 Profile/Event 统一 maintenance 始终发送 Responses `reasoning.mode=standard`。
公开导入请求不接受 `reasoning_mode`，不保存最近 Fact 模式，也不从 User 或 Operation 继承模式。
模型、reasoning effort、服务等级及正常恢复规则仍各自独立；工具轮、Flex 恢复和重新执行均使用 Standard。

历史 Alembic `0013_reasoning_mode → 0014_fact_time → 0015_event_time` 原样保留。
0013 的历史数据库 guard 不再由运行时代码写入模式；既有 JSON 不批量清洗，也不增加兼容读取。
在撤回旧合同前必须核查旧模式的在途／可恢复请求，不能仅凭新代码通过测试假定它们不存在。

## 不变量与归属

Fact 是有消息支持的历史陈述，不维护唯一正确的当前真相；显式人工编辑可原位纠正抽取错误。Profile 整理长期属性和人物关系，Event 组织故事。后两者不能修改 Fact 或产生新的事实依据。Luvel 决定消息范围并压缩分段；Memoia 按会话接收追加，每次 Fact flush 处理调用方指定的有界范围。

```text
Project → User → Source（调用方 source_id）
                    ├→ Message（调用方 message_id，无正文）
                    └→ 会话 Blob（公开 ID 为 source_id）→ Fact
                                              ├→ 独立检索索引
                                              ├→ Profile（Fact 支撑）
                                              └↔ Event（多对多）
User → flush Operation（固定 Fact 变更批次）→ 一个 AgentLoop → 写入 Profile / Event → 完成回执
```

Source 的自然键为 (project_id, user_id, source_id)，Message 再加 message_id；消息属于 Source，不属于 Blob。幂等键映射一次追加、封批或修正操作，正文 hash 只验证同键同请求，不将两次真实发生去重。重叠消息不能成为第二份独立证据；同消息 ID 的正文、角色或发生时间冲突明确报错。复合外键约束用户、项目、来源、批次与派生关联，不能只靠代码填对字段。

唯一公开协议为无版本的 /api，根目录 openapi.json 是公开契约真相源，由 TypeScript Worker 实现；SDK 由该契约生成类型及校验器。历史内部 buffer 清理原语不构成旧版本 HTTP 兼容承诺，切换不清空在途数据。

## 写入、回执与原文生命周期

1. 追加消息返回 `202 staged`。每个 Session 对应一个 Blob，公开 `blob_id` 等于 `source_id`。追加 Operation 的幂等键固定本次消息输入；Source、Blob 和消息记录只保存身份、成员关系与元数据。文字和调用方提供的图片描述仅暂存于 Operation。
2. 调用方用 `POST /api/users/{user_id}/blobs/{blob_id}/flush` 提交追加 Operation ID 清单，固定本次范围并创建 Fact Task。封批后收到的消息留给下一次。调用方通过原 Operation 查询或恢复任务。
3. Fact Task 逐段处理仍有效、未处理的消息。Fact Agent 校验陈述、证据和时间；先保存临时候选，再生成向量。分片续跑复用仍有效的候选和向量。删除使受影响范围的候选失效。在模型和向量等待期间不持有数据库事务。
4. 同事务保存 Fact、向量、消息处理标记、Blob 变更和完成回执，并清除临时原文、图片描述及候选。只在提交后发出 Profile/Event 唤醒。Cloudflare 可把通知交给 `waitUntil`；通知未送达时由 Cron 从 PostgreSQL 补投。Docker 通过轮询发现原任务和待封批数据。

`completed` 表示该次 Fact 操作已提交，`fact_ids` 和 `memory_version` 仍用原回执。消息导入统一走追加和封批。历史同步导入回执仍可查询，未完成的历史同步操作不再执行。消息删除与人工 Fact 编辑同步返回各自的回执，派生变化由后台执行。

Legato Task 租约决定执行权。永久遗忘保留用户墓碑，消息撤回直接移除消息及受影响的暂存内容，删除历史从原撤回回执读取。调用方须排除已撤回消息，用新幂等键重新提交会作为新输入受理。响应丢失时先查原回执，以原键确认或恢复。默认七天的临时输入期限不随重试延长，到期后原范围返回 `input_required`。

flush 的状态和结果来自同 ID 的 Legato Task。封批提交即确认受理；派发预约、发送或确认失败由 Cron 补投原任务。回执查询在同一数据库快照读请求身份和执行摘要，临时输入及检查点由执行和恢复路径读取。

## Fact、时间与历史陈述

Fact 尽可能完整、客观地记录用户描述，不替用户增加判断，也不表示已经核实。保留主体、行为、原因、人物、报告者及 certainty；用户自己的感受、判断和推测按原有归属和确定程度记录。助手只能辅助理解，新增猜测不能成为独立支持。引用、否定、角色扮演和用户确认必须保留原有范围。结构校验不能证明语义正确；漏抽和过度推断仍需固定真实模型样例验收。

Fact 按可独立保留的信息组织，正文必须能独立理解，明确包含主体、对象和必要关系，不能依赖 subject 元数据或相邻 Fact 补全。需要不同证据才能成立的内容分开；同组消息支持的连贯内容可以合并，不按句子或动作机械拆分。感受、原因保留辨认活动所需的背景，不必合入整段经过。content、subject、certainty 对应同一主断言：若断言是某人可能处于某状况，用 uncertain；若断言是用户明确表达担忧，可用 asserted，但正文中的被担忧状况仍须保持未确认，不能把表达已发生当作状况已证实。

本人的普通 Fact、Profile 和 Event 使用“用户”指代，姓名单独作为身份断言保存，不装饰到无关喜好或经历中。第三方姓名和代词解释若依赖其他消息，每个支持组必须包含所需消息。派生 fact_ids 覆盖整条记录实际采用的信息，包括标题、摘要、关键词、时间、地点、正文、推断依据及标签值，而不只覆盖正文；不能把全部读集自动当作支撑。旧派生文本不是保留已删除身份信息的证据。提示词约束仍非语义正确性的证明，固定姓名删除用例与真实模型首轮失败必须分别留证。

Fact 不强制分类到画像 topic/subtopic；旧分类只作为 legacy 元数据。一个 support_group 内消息共同支持，多个组是独立替代支持：删除必要消息使整个组失效，不将组缩成剩下半句。事实仍有完整组则保留；重叠批次复用消息身份，不增加证据份数。

同批或不同批次的历史陈述可以并存；抽取不搜索、改写或隐藏旧 Fact。本批明确更正的旧说法若保留，须写明是先前的说法，不能把说错的内容当作曾经发生的情况。明确更正、否定和不确定性保留在陈述中，不用含糊指代猜补旧事实，也不把“曾告诉别人某事”提升为该事已发生。保留旧说法不表示仍采用旧结论；Profile/Event 按相关陈述、发生时间和明确更正整理当前理解，不能只按录入时间判断真伪。没有纠正关系图或 active 隐藏状态；旧 included 只是历史分类元数据。Source 仅为外部来源及消息身份／删除边界，没有累计 Fact 条数上限。

occurred_at 是当前支持消息的最新记录时间；删除较新独立组后同事务回退。fact_time 对应 Fact 所描述的事情或状态，不机械绑定句首“用户说／回忆／更正”；通知等交际行为本身是所记事情时，才采用该行为的时间。担忧、不知情或通知不继承其对象的发生日期。

fact_time 保存包含首尾两天的 ISO 8601 日期 start/end（YYYY-MM-DD）、year/month/day/range/unknown 精度及原消息表达。年月边界只说明精度，不表示状态持续了整年/月。持续、周期或未解析表达不能确定完整日期区间时使用双 null 与 unknown；正文及 evidence 保留时间含义，不补造结束日。没有时间表达时 fact_time 为 null。模型 Schema 区分完整日期与双 null 分支，共用 FactTime 日历校验；严格输出字段仍必填，业务未知值用 null。unknown 可以参与文本/向量检索，但不命中精确日期筛选。

原消息 time_zone 由代码用于计算 local_recorded_date；抽取 input 只传计算后的日期，不重复传 IANA 时区。记录／处理时刻不能直接代替发生日期。维护 Loop 使用当前 fact_time 和正文中的明确时间表达，不重新按本轮日期换算历史。撤回后删除失去支撑的 Fact。幸存 Fact 的索引文本未变时保留向量；有变化且启用向量时，先在事务外同步生成，再与证据、Fact 和完成回执一起提交。供应商失败时本次撤回没有提交，调用方用原幂等键重试。

0014 将原 event_time 列及未完成纠错／抽取候选中的对应字段改为 fact_time，保留日期值和证据。公开 API/SDK 只提供新名，消息输入及 event_after/before 查询参数不变。旧操作的 request_hash 不改；纠错 fingerprint 仍以历史 event_time 键规范化，确保载荷已清除的完成回执与过期原操作仍使用原幂等身份。已存索引文本不因字段改名重写或重算向量。

Fact.created_at 是首次数据库插入时间，updated_at 是最近修改时间；修改不改变 created_at。旧行无法确定的生命周期时间保持 null，不借消息或 Blob 时间猜补。来源读取、独立 query、search、context 和 Loop 返回同一组时间，均不能代替 occurred_at 或 fact_time。

人工编辑保留原 Fact ID、原 Blob 和来源归属；支持组只能使用原 Blob 内未删除的消息，每组至少包含一条用户消息，助手消息可提供必要上下文。新幂等 Operation／固定 Blob 使用 kind=correct，内部 Fact 变更为 updated 或 deleted；它是定点修正，不是新增历史陈述或证据迁移，也不建立纠正图。任何实际编辑均推进 Fact revision 和 updated_at，同事务更新直接索引、清理旧画像历史并登记维护。Loop 只整理 Profile/Event，必须读取当前 Fact；编辑前的读集不能提交旧版本结果。

删除消息及人工修改、删除 Fact 都是同步请求。改动、派生维护登记及完成回执在一次短事务提交。请求结果未知时，先按原幂等键查询。已完成就确认，回执缺失或未完成时按原键重交原请求。同键不同请求返回冲突。人工 Fact 请求每次实际写入仍核对 expected_revision。

请求最大 2 MiB，每批最多 1,000 条完整消息。模型拒绝超出上下文容量的抽取请求时，原 Fact flush 回执记录 `fact_model_input_rejected`。旧配置 `source_max_input_tokens` 和 `source_context_window_tokens` 仍可读取，抽取输出由 `source_output_reserve_tokens` 限制。固定抽取指令与 `source_material` 分开，原文和 `visual_description` 按用户资料发送。参数和鉴权错误不会自动重试。embedding 每批默认 64，严格校验索引、条数、维度及有限数值。

Source／用户整组清理仍由 PostgreSQL 外键在原事务内完成。0016 在所属 Source 已消失时跳过无意义的延迟逐消息扫描；来源仍在时保留证据及 Blob 成员约束，并使用现有归属和消息成员索引。移除重复旧单列 Fact→Blob 外键，保留复合归属外键；不新增清理任务、不延长超时、不改删除 API 语义。

## 会话 Blob、flush 与统一 AgentLoop

同一 Session 的消息追加到同一 Blob；删除和人工 Fact 编辑另记变更 Blob。幂等键定位原 Operation，重试不能扩大处理范围。Fact、索引、回执和 Blob 的 fact_changes（新增、人工编辑、删除、证据及时间变化引用）同事务提交。Blob 不保存聊天原文。人工 Profile 编辑、Event 删除和 Agent 写入不生产 Blob。

主动 POST flush 或 Worker 定时 flush，在短事务按完成顺序选取待处理的 Blob 变更。每次扫描最多 100 个 Blob，可跨 Source，范围仍限当前项目和用户。变更引用与当前有效 Fact 的 JSON 总预算为 256 KiB。会话和撤回 Blob 按待维护变更前缀分批，其余固定 Blob 仍作为一个整体。若首个不可再拆的变更或旧批次超限，原回执报告 `maintenance_capacity`。剩余及随后完成的变更留给下一次，`pending_blob_count` 可见。同键重试沿用已封范围。自动静默 30 秒、最长等待 120 秒，查询不改变计时。显式空 flush 保留 `completed` 回执。自动唤醒发现没有待处理 Blob 时直接返回。

Operation（`kind=flush`）是公开身份，保存固定范围；同 ID 的 `queue_tasks` 保存执行状态、租约及恢复进度。每个项目和用户最多一个派生执行者。首次失败后按 5／15／60 分钟退避，耗尽后沿原 Operation 显式恢复。退避期间后续批次可以运行。

公开回执将待领取、运行及退避映射为 `processing`，将任务终态映射为 `failed` 或 `completed`。重复查询或领取不会重置原任务的预算。

维护校验使用具体安全错误码。已知但正文未读或已不存在的 Fact 支撑返回 `staged=false`、整批目标 `ids` 和 `error.unread_fact_ids/invalid_fact_ids`，不暂存该批任何修改，也不自动查询或替换支撑；模型可在同一 Loop 和原时间预算内补读、修正。返回引用与输入顺序一致，新建目标仅预留本轮身份，修正必须复用。未解决目标仅在成功暂存或显式移除后解除；其它目标成功不能解除，未解决时以 `maintenance_unresolved_staging` 拒绝完成。同目标重复相同错误提案且相关支撑读取状态未变，以 `maintenance_staging_repeated` 终止；无关读取和引用重排不重置保护。未知／类型错误引用仍以 `MAINTENANCE_REFERENCE_INVALID` 终止；格式、归属、配置、失租、读冲突和数据库错误不交给模型纠正。日志只记录操作身份、错误码、计数及有界内部 ID，不记录正文、凭据或完整工具参数。结构合法仍不证明语义完整；验收保留首次失败。

Loop 工具用本轮短引用：Fact 为 f1/f2，Profile 为 p1/p2，Event 为 e1/e2。首次返回条目或关联时编号，后续搜索、分页、精确读取和暂存复用，新增条目继续追加；已删除引用不回收、不重新分配。引用只进入工具身份／关联字段，面向用户的正文、标题、摘要等不附内部引用；证据保存在 fact_ids。只有维护工具边界转换类型化引用，不改写自然文本；读集、并发锁、提交、数据库和公开 API 始终使用真实 UUID。全新 Loop 独立建立映射；安全检查点续跑恢复原映射与原生响应续接，检查点失效需重建时才按新 Loop 处理，不跨用户或任务共享；服务端压缩不改变映射。新建派生条目传 id=null，工具返回短引用；关联引用不代表正文已读或 Fact 仍有效。查询名字用 query/search，不猜引用或模糊匹配 UUID。

一个 OpenAI TypeScript Agents SDK Agent 同时查询并暂存 Profile/Event，模型自行安排处理顺序；不能修改 Fact。使用 Agent、Runner、函数工具和 Zod 参数校验，不使用 handoff、持久线程、MCP、Shell/文件工具。禁用外部 tracing/正文 debug，transport maxRetries=0；SDK 模型重试按下面的档位与预算规则执行。项目 llm_model/reasoning_effort 默认继承 gpt-6-luna/high，运行固定配置、最终再次校验；不静默切模型或降低等级。

项目可用 `fact_llm_model`、`fact_reasoning_effort`、`fact_temperature` 单独配置抽取，
不改变上述维护配置；省略模型／effort 时分别沿用共享设置。温度仅在实际 effort 为 `none`
时发送，省略则使用供应商默认值。已有候选／原操作恢复仍复用保存的结果，不因选模变化重新抽取。

Fact 与维护 Loop 均使用 text.verbosity=low，与思考档位、正文和支撑完整性要求独立。Fact 和维护 Loop 每次模型调用先 Flex，临时供应商失败/超时后仅本次调用降级 Standard，下次调用重新先 Flex。同一次调用的 SDK 重试保留当前服务等级，只有通过校验的成功响应才复位。只重试未执行工具的模型请求，Flex fallback 延续原分片预算、parent/input 和缓存组装，不重启会话或重置限制；跨等级缓存收益须实际观测。鉴权、输入、拒绝/过滤、失锁和预算错误不能借 fallback 绕过。单次生成最多 32768 tokens；维护 Task 由 Legato 分片执行，12 分钟软边界前预留收尾时间并在安全点保存检查点，14 分钟硬边界后撤销普通提交权。主动让出不算业务失败，下一分片沿原 Task／Operation 继续，不把它重建为新导入；硬超时按原失败恢复规则处理。单次维护模型调用最多 10 分钟，并受当前分片剩余预算约束；不再使用旧的 Loop 整体 900 秒上限，不设模型请求次数或累计 64K 上限，用量仍记录。Responses 使用 store=true、previous_response_id 增量续接，原生 context_management.compact_threshold=256000（十进制）；不增加摘要模型调用，数据库读集和暂存修改不压缩。模型/入口真实兼容性单独验收。

首轮 maintenance_batch 只提供变化数量 change_count 及第一页变更（items/next_cursor），不传后台水位 through_version 或批次数 blob_count，复用 read_changes 的有界读取、读集和覆盖登记。每项含当前有效 Fact（不存在时为 null）；初始输入与后续工具共用本轮短引用。超出单页才由 read_changes 续读，遗漏任一非 noop 变更不能完成，全部检查后不生成派生修改可合法完成。read_memory 用于已知 ID、分页和单字段内不区分大小写的连续文本片段过滤，不拆分关键词；search_memory 用于语义/关键词探索，复用同用户混合搜索。已有完整结果直接使用，不要求两个工具互相确认；stage_profile/stage_event 批量暂存。读取/修改工具以完整条目分页，单页/批最多 64 KiB、200 条，首轮加载最多 200 条、工具读取默认 100 条，混合搜索最多 20 条；超限不截断正文。取消全局 100 个暂存目标限制。工具读当前数据并登记版本，不按旧 flush 水位过滤，不接受 project/user，不加载全部历史。覆盖校验不能证明模型语义判断正确，真实样例仍需验收。

直接使用首轮变化，按需补页和查找相关已有记忆，不固定预查两类派生条目。新增陈述缺少相关旧记忆时用 search_memory 发现；同一人物／故事的相关变化优先合并搜索，不按 Profile/Event 拆查询；不同主题或结果不足时仍可独立并行搜索，不设固定搜索次数。人工编辑、删除、证据或时间变化使用完整关联分页，不能以有排名上限的搜索替代受影响条目的覆盖。混合批次兼顾两者并复用已得结果。read_memory 的 ids/query 均为空时，仅返回关联本批变更 Fact 的条目；空页不代表用户没有其它相关记忆。创建前须发现相关已有条目，已返回完整候选时直接复用，不重复确认。旧 flush 恢复按当前数据发现已有条目，不能因旧 added 标记跳过发现；当前 Fact 已不存在时，仍按关联定位失效派生条目。

每轮模型请求串行；同轮独立工具通过 SDK 原生配置最多并发 4 个，其余在本轮排队；相同集合、相同目标 ID 的暂存写入仍按序执行。工具上限不等于 Worker 的用户 Loop 并发数（部署配置与数据库领取决定用户间并发）。SQL 线程使用私有读集/暂存快照，返回后由事件循环先校验再合并读集；并发读取版本不一致或返回项的暂存内容已变化，整轮失败而非覆盖检查。read_changes/search 已返回完整条目，不强制再次读取；仅补查缺少的相关历史，批量查询和暂存，预留最终完成请求。工具 schema 分开表达 upsert/remove：前者必填正文和非空 Fact 支撑，画像还必填分类；后者只接受现有 ID。运行日志仅记录 Operation、请求轮次、服务等级、工具名称、数量、状态及耗时，不记录参数/正文，不启用外部 tracing。脚本化模型测试证明执行边界，真实模型验收另证规划效率与语义效果。

代码先暂存失去全部有效 Fact 支持的受影响 Profile/Event 删除，模型无需逐条发删除命令；有独立有效支持、无事实关联的人工/legacy 条目不机械删除。发布前用读集校验支持和目标版本，防止误删并发编辑后仍有效的条目。

模型给出的 `fact_ids` 只表示实际支撑；代码另在既有 JSON 中保存内部 `_impact_fact_ids`，用于删除和纠错定位，不返回给模型或公开 API。每轮输出使用最终 Fact 读集和已读 Profile/Event 继承的影响范围，在版本校验后、两类写入前统一计算。只剔除本批明确处理且已不存在的删除 ID；属于其他待完成 flush 的删除 ID 继续传递，避免旧正文经新条目逃过后续清理。影响范围是保守上界，不宣称每条 Fact 都支持每项内容，也不改变检索的支撑关联。

非新增 Fact 变化同事务递增受影响 Profile 和 Event 的 version；旧 Loop 即使只读过派生文本，也不能绕过并发检查。影响范围只产生需复核候选，不是删除依据；每项必须依据当前有效 Fact 重写（upsert）或移除，不能 keep 旧正文；发布前发现遗漏时原 flush 失败，不能默认删除。无关条目仍可 keep，但必须实际读过完整目标，且原有非空支撑全部有效并已读；提交继续校验版本，不重写正文、向量、时间、影响范围或历史。只有已知支撑全部消失才自动暂存 remove，缺少关联不等于支撑全部失效。执行中新出现的受影响条目仍由完成检查阻断。旧条目缺失/null 影响范围视为未知，在同用户删除、纠错或证据变化时保守纳入复核；普通新增不扩大到全部旧条目。读取受影响条目的定位与支撑也保守继承原影响范围；keep 保留原范围，不能靠现有 `fact_ids` 将未知洗成完整。新建纯人工画像的影响范围为空，人工更新不能清除或伪造此字段。

画像历史的三类快照同样保存内部影响范围，删除/纠错时过滤受影响条目。旧快照范围未知的不作为可恢复历史返回，也不从当前同 ID 画像补猜。原历史记录及旧派生正文不作发布时批量删除；当前正文仍遵循待 flush 语义。这项改动不新增表、迁移或外部版本协议；保守范围可能使更多条目需要整理，不能据此承诺模型不会漏记或错误概括。

可变 Fact/Profile/Event 集合使用稳定 ID 游标，与本轮暂存修改按同一 ID 顺序合并；不建立快照表。游标停在最后实际返回的完整条目，字节预算不足不截断或跳过未消费项。普通条目返回完整正文；必处理条目的旧正文、标题、子主题等自由文本不返回给模型，保留 ID、version、顶级 topic 和完整支撑 ID，以当前有效 Fact 重建原 ID。自己的暂存新正文仍可读。缺少旧关联标记 support_unknown，需搜索当前 Fact，不自动删除；支撑正文超预算通过现有 Fact 分页补读，不截断支撑 ID。单条超出字节预算明确失败。固定 read_changes 列表仍用 offset。待删除派生条目保留 pending_delete 导航信息；旧文本不是证据。关联按页批量读取，发布前按集合核对 Fact 的 revision 与 Profile/Event 的 version。

鉴权、排名、正文与证据使用普通 SELECT，空排名直接返回。相关读取限定项目和用户，并过滤已失效依据。维护和抽取都在事务外等待模型或 Queue。

维护阶段用 watchdog 检查运行权。发布前校验项目配置、Fact 和目标版本，写入语句继续限定当前用户与有效租约。Profile 和 Event 各按条目的 version 条件写入。画像历史只登记实际生效的修改，每条 Event 的正文和证据同一条 SQL 写入。已成功的写入保留，全部处理完成后由 Legato 用一次条件更新确认任务成功。原任务恢复时使用既有检查点，按版本和内容识别已经生效的修改，相关证据或目标发生其他变化时重新整理。永久遗忘阻断迟到写入。

必处理集合复用本轮准备时查到的保守影响范围，不因普通搜索或额外读取扩大。工具条目的 `review_required` 标明该范围；首轮变化页、后续读取和暂存回执中的 `remaining_review` 按 Profile/Event 返回剩余 count 和至多 20 个 ID，接受决定后列表推进，无需额外游标或任务状态。短引用仍由同一映射生成；清单只有身份，不代表正文或支撑已读，模型对已有条目做决定前必须读取目标（必处理项为定位与支撑）及所需有效 Fact。已接受的重写或移除（包括已知全部失去支撑的自动删除）退出剩余清单，被拒绝的重提仍保持未完成。结束时先检查本轮剩余项，发布前再检查当前数据库范围与版本；并发新增影响不能被旧清单掩盖。

## 默认画像目录与三类初始背景

维护工具向模型声明与执行检查一致的读取范围：目录／变更页 1–200、搜索 1–20、精确读取最多 200 个 ID、查询最多 500 字符。超限仍失败，不静默放宽；容量诊断只记录工具名、数量及长度，不记录查询正文或 ID。Schema 声明不保证模型永不超限，真实模型失败须保留原操作证据。

默认一级分类为 `user_profile`、`personal_background`、`work`、`education`、`interests_preferences`、`lifestyle`、`goals_values`、`relationships`。中英文使用相同英文标识，描述与画像正文按项目语言输出；详细边界由 `src/worker/src/default-topics.json` 的双语目录统一维护。二级分类仍由现有 Loop 创建和复用，不新增人物表或单例约束。

`user_profile` 仅保存本人重要稳定背景和长期重点的简短概况，不拼接全部详细分类；`interests_preferences` 保存稳定兴趣和偏好，明确表达的长期交流偏好使用 `sub_topic=interaction_preferences`，不再作为独立一级分类，不保存一次性指示、短期情绪或助手猜测；`lifestyle` 保存持续日常习惯、作息和生活方式，不将一次经历断言为长期习惯。三类可以各有多条简短、非重复的 Profile，并保留有意义的二级分类。Loop 根据相关 Fact 增删和证据变化更新，优先查找并修改已有条目；明确更正也是新增历史陈述，不回写旧 Fact。所有画像均直接关联有效 Fact，不互相作为证据，也不为每次聊天重新生成全部概况。偏好是参考资料，调用方的显式设置与当前要求优先。

Luvel 默认分别调用既有 `queryProfiles`，读取 `user_profile`、`interests_preferences`、`lifestyle`（query 省略或 null，不能用空字符串），保留二级分类标签，在共享总预算内选择完整条目；其它分类按需检索。没有条目就返回空，不拼接或回填旧分类。不新增 API、SDK 方法、模型调用或调度器。

只替换系统默认模板，保留项目 overwrite/additional 配置；不修改已存的自定义目录，不建立旧默认映射或迁移／重建工具。修改模板不意味着历史画像被重新整理。Test 旧画像清理需独立定界和授权，且须等新 API/Worker 发布、排除旧在途写入后执行；不隐式清理 Fact/Event/Source/聊天或画像历史。

本地验证目录一致、实际请求提示词、现有查询隔离、二级分类与删除后增量维护；这不能证明模型语义。真实模型首轮验收应区分“今天简短一点”（不存长期偏好）与“通常喜欢简洁解释”（可存），以及“今天走路上班”（不认定长期习惯）与“通常走路上班”（可存生活方式），验证他人职业只进关系人物、详细工作背景不全量复制入概况，以及删除偏好证据后只更新受影响条目。

## 删除与派生中间状态

DELETE sources/{source_id}/messages 接收用户定位、message_ids 与稳定幂等键，不需要正文、event_id 或 blob_id。同步处理相关支持组、Fact、索引、消息行及完成回执，并登记本次删除 Blob。只有 Fact 或其证据实际变化时才通知后台维护。同键重试返回原回执；来源中的已删除消息 ID 从撤回回执读取。调用方负责避免用新键重新上传已撤回内容。

**旧 Profile/Event 文本可暂时读取，直到统一 Loop 成功。** 接口/Inspector 显示待更新或失败；失效关联不得作为有效 Fact 证据返回。公开读取按尚未完成的 Blob/flush 变更排除被修改、删除或证据变化的 Fact 关联，不能用修正后的 Fact 为旧正文作证；无关的有效支撑保留。原数据库关联仍供 Loop 定位待修条目，当前 Fact 也仍可独立读取，不新建证据快照。删除后的旧文本可能暂时进入聊天上下文，维护失败不保证固定时间内消失。历史读取过滤失效证据，不提供恢复已撤回内容的接口。

删除 Event 只删除该事件及派生索引，不改变 Fact 或画像；保存被删除事件 ID 墓碑，后台不能复活该 ID。人工修改递增 version 并保留证据关联，后台旧版本提交失败，不承诺人工文本永远不被后续正常整理替换。

Profile/Event 鼓励基于当前有效 Fact 作有用的推断，而非仅摘抄。Profile 可归纳特点和关系模式，在现有正文中用“可能／倾向于”等表达区分推断与明确描述，不新增字段。Event 的 title/summary/keywords/event_time/location/content 保留有依据的经历，未知为空；可能的原因、动机、影响或意义放入 interpretation。两者都须直接关联作为判断依据的 Fact；派生解释不能回写 Fact 或成为另一条记忆的独立证据，依据修改或删除后须重新判断推断是否成立。同人物/关键词不自动合并故事，Fact 与 Event 多对多。原文已清除，遗漏的具体经历不能靠推断补造。

Fact 抽取只产生事实，不重复生成 Event 标签或画像分类。Fact-first search 使用 Fact 向量；独立 events/query 使用 Event 向量。维护发布前批量生成新增或索引文本变更的 Event 向量。每条 Event 将正文、证据和向量一起写入。供应商失败沿原维护回执重试。人工编辑仅在索引文本变化时同步生成向量；已有依据正在撤回维护中的 Event 暂不允许修改索引文本。只改解读等字段时保留原向量。Loop 与人工 Event 路径共用 factual title/summary/keywords/event_time/location/content 的索引文本，旧 event_tip/profile_delta/tag 保留兼容，不把 interpretation 当成事实索引正文。显式关闭 embedding 时仅词法查询。

Profile/Event 的 created_at 由数据库在创建时生成，更新不改变；不再用支撑消息的 occurred_at 覆盖。Event.event_time 是故事发生时间的文字描述，Fact.fact_time 是事实的结构化日期及证据；两者都不同于入库时间。旧记录曾将来源时间写进 created_at，不能可靠还原的保持 legacy，不以当前时间或 updated_at 猜补；历史 created_* 筛选因此不能保证精确。

Fact 人工编辑、删除或时间证据变化时同步清理相关历史画像；AgentLoop 不能把旧文本、后续未处理 Blob 或迁移 flush 所涉及的失效文本重新记入历史。新旧 flush 恢复都读取当前 Fact，并过滤其它未完成变更涉及的旧画像。当前派生文本允许延迟更新的契约不变。

永久遗忘 DELETE users/{uid} 仍立即阻断读取及后续提交，不采用派生延迟语义。短 SQL 事务写项目/UUID 墓碑并级联清理；不等待长模型执行。旧执行者提交遇到墓碑返回 410 user_forgotten。重复调用返回同 UUID forgotten=true；墓碑不含正文，不能随 User 清理消失，也没有恢复身份参数。

## 接口、检索与消费者

主要接口（均在 /api 下）：
- POST users/{uid}/blobs：source_id、idempotency_key、带 message_id/role/content/occurred_at 的文字消息并返回 staged。
- POST users/{uid}/blobs/{blob_id}/flush：以同一 Session Blob ID 提交 1–32 个已暂存的追加 Operation，固定本次 Fact 范围。处理中新增消息属于后续范围。提交前已有段过期时返回 409 expired_append_inputs 和 append_operation_ids，整份请求未受理，有效段可使用原追加回执另行封批。
- GET users/{uid}/blobs/{blob_id}、sources/{source_id}：有界来源/批次及当前证据。
- POST users/{uid}/flush：稳定 idempotency_key，返回固定集合及 kind=flush 的 Operation。
- GET users/{uid}/operations/by-key/{key}、operations/{id}：查询原回执。POST operations/{id}/retry 仅恢复 Fact flush 和维护 flush。Fact flush 复用原范围及仍有效的检查点；输入过期后，原回执持续返回 input_required。
- GET users/{uid}/maintenance：未封闭 Blob 数量及最近 flush 状态、错误、尝试次数和固定 Blob ID。
- DELETE sources/{source_id}/messages：删除消息贡献；DELETE events/{id} 与 DELETE users/{uid} 独立。
- POST users/{uid}/events 用 `EventInput` 新建独立 Event，正文必填，返回 201 和 ID。PATCH users/{uid}/events/{event_id} 用 `EventPatch` 提交至少一项改动，返回 204。省略字段保留当前值，可选字段传 `null` 清除，提交正文时必须为非空文本。两者都需要 write scope。新建 Event 可独立查询，未关联 Fact 时不会被 Fact-first 检索召回。编辑保留原 Fact 支撑和影响范围，支撑变化仍由统一维护处理。索引根据合并后的正文计算，提交检查 Event 版本，遇到 `write_conflict` 先读当前记录。人工写入无需生成 Blob 或排队。
- GET users/{uid}/events/{event_id} 和 GET users/{uid}/profiles/{profile_id} 按 ID 返回一条完整记录，使用 read scope。条目不存在或不属于当前项目和用户时返回 404。单条读取沿用列表的返回结构与证据过滤。
- PUT users/{uid}/facts/{fact_id}、DELETE users/{uid}/facts/{fact_id}：write scope；稳定 idempotency_key、expected_revision 和人工 reason，成功后返回 kind=correct 的完成 Operation。编辑提交完整 content/subject/reporter/certainty/support_groups/fact_time，证据遵循上文的原 Blob 支持组约束；原文已清除，身份和结构校验不能证明编辑内容语义为真。版本冲突先读当前 Fact，再确认修改。
- POST search、POST context：私密查询留在 JSON body，使用 read scope。

POST search 的 `query` 保留在请求正文：并行计算查询向量和文本候选，以 pgvector、PostgreSQL FTS/字面匹配融合排序。先按顺序选择完整 Fact，再读取这些 Fact 关联的 Event/Profile；返回 `facts`、`events`、`profiles` 三个独立字段，不把 Fact 包装成 Event，也不新增查询分类模型。相同关联条目去重；三类完整对象及证据共同计入 `max_token_size`（默认 8,192，上限 10,000），放不下整条就跳过，不截断正文或证据。无 Event 的有效 Fact 立即可搜，删除 Event 不影响 Fact 召回。

`exclude_fact_ids`、`exclude_event_ids`、`exclude_profile_ids` 各最多 500 个 UUID。三类输出独立按 ID 排除，不改变数据库，也不新增 revision 协议。已注入 Fact 不再独立输出，但仍可导航到未注入的关联 Event/Profile，包括异步维护后来生成、或上次预算未容纳的条目。候选只保留未见 Fact，或仍关联允许返回的未见派生对象的已见 Fact；两类各有独立候选池，共用本次查询向量。融合沿用原排名窗口，默认每路 250 条，融合后每类最多读取 50 条候选详情。关联内容和完整证据仍计入响应总预算。调用方在整个 Dialog 内保留实际已注入的 ID：同 ID 后续文本更新仍被该会话排除，新会话自行重置。本人的每轮画像读取仍是独立调用，不因检索排除消失。现有 `include_events=false` 可以明确关闭故事扩展，旧 `event_max_tokens` 可进一步限制故事子预算，但不能突破总预算。临时 query embedding 故障保留词法召回，输入/配置拒绝仍失败。不承诺精确时间过滤或穷尽列举。

`exclude_profile_topics` 接收最多 50 个一级 Topic 名称（每个 1–256 字符），只排除这些分类的关联画像，不排除 Fact/Event。调用方按项目定义选择本人分类；服务端不猜人物归属。默认目录的关系人物 Topic 是 `relationships`，其它预设分类用于本人，项目自定义目录不能套用这一默认假设。超出 ID/Topic 上限明确拒绝；调用方可降级当前可选检索，不能截断集合后重搜或清空整个 Dialog 的去重记录。

原 context 的有序完整 entries 和 entries.join("\\n\\n") 契约保留；结构化检索及 ID 排除使用 search，避免在两个入口复制不同格式的检索协议。query=null 使用近期记录列表，语义检索不按记录年龄排除旧事。无来源的旧手工事件保留明确的 fallback，不伪装成新 Fact 支撑。画像直接读 PostgreSQL，没有 Memoia 或 Luvel 画像缓存。

Luvel 用固定 Fact 回执确认批次/删除，不等待 Event ID；派生失败不得重新导入。压缩、任务调度、Mem0 分支和删除补偿仍由 Luvel 负责。Inspector 保留原页面/可选 Playground，展示状态、原 flush 操作恢复与故事字段；同源写入保护和失败不得报成功不变。

所有写请求只发送一次；HTTP5xx/超时/响应丢失为未知提交，先查回执。retryable=true 的 write_conflict/lease_lost 表示明确未提交，不授权 SDK 盲目重放。安全读可有限退避，幂等键由调用方持有。项目/key scope、到期/撤销逐请求校验，缺少凭据失败关闭，不能跨项目。

## 迁移、发布与验证

### 独立只读查询

SDK 0.10.0 新增 `queryFacts`、`queryEvents`、`queryProfiles`，分别对应 `POST /api/users/{user_id}/facts/query`、`events/query`、`profiles/query`，均只需要 read scope。每类先应用自身归属和筛选，再从独立候选池做有界排序；不调用混合 search 后拆字段。旧 search/context/list 接口不变。公共参数为 query（可空）、ids、exclude_ids、limit（默认 10，最多 100）、max_token_size（三类均默认 8192，最多 10000）；未支持的字段拒绝，预算只容纳完整条目及证据，最小空响应也放不下时返回 422。

- Fact：source_ids、recorded_after/before（带时区时间）、event_after/before（日期）。返回 facts/SearchFact；历史 `occurred_at` 明确是支撑消息记录时间，发生日期在 evidence.fact_time；created_at/updated_at 是数据库生命周期时间，旧行未知时为 null，不能以 Blob 创建时间冒充。
- Event：fact_ids（任一有效关联）、created_after/before（数据库创建时间）、event_after/before（有效关联事实的已知发生日期范围重叠，未知不命中）。返回 events/EventRecord 加 score；SDK 0.10.1 用独立 QueriedEventData 保证返回当前有效 fact_ids／evidence（无关联则空列表），不改变原管理 EventData。叙事 event_time 字符串不伪装成可精确筛选的日期。
- Profile：topic、sub_topic 精确匹配及 query/IDs。返回 profiles/SearchProfile，仅携带当前同项目、同用户的有效 Fact 引用。画像没有向量列，使用文本匹配；Fact/Event 并行文本与向量查询，沿用 8 秒 embedding 截止及临时故障词法降级。候选上限 500，不承诺穷尽全量历史。

`GET /api/project/identity` 及 SDK `getProjectIdentity` 只返回鉴权确定的 project_id。Inspector 用它与已初始化用户生成缓存 key，不信任浏览器提供的项目归属。三个查询接口保持只读；Event 索引由上述写入链路维护，不在查询时补写。真实供应商／远端隔离验收仍独立。

独立 Event/Profile 查询按排序候选每页 20 条批量读取关联／当前有效证据，预算容纳足够完整条目即停止；超大条目整条跳过，继续下一页。身份和筛选在读取时再次应用，不逐条查询证据，也不添加记忆缓存。

旧数据沿既有迁移维护。执行顺序、数据保护与验证见 [TypeScript 迁移与恢复](guide/typescript-worker-migration.md)。公开响应及 SDK 以 [OpenAPI](../openapi.json) 为准。

用量按模型调用实时累加。项目日用量查询最多返回最近 30 天（含当天），每天清理已过期的计数。当月额度使用独立的月汇总。

`GET /api/project/usage/events?date=2026-11-16&user_id=<uuid>&limit=100` 读取当前项目的逐次用量。可按项目内用户过滤，每页最多 100 条，按原查询传回 `next_cursor` 续读。首页的 `first_recorded_date` 是项目或所选用户的首个记录日，与该页明细来自同一快照；请求日期无明细时仍返回首日。TypeScript SDK 使用 `listUsageEvents`。

`date` 按明细写入时的 UTC 日过滤，`occurred_at` 用于按发生时间归账。使用明细 ID 去重。明细包括实际 Fact 抽取、派生维护和 embedding 的供应商、模型、服务层级及可用的 Token 数据。暂存、封批登记和回执查询不记模型用量。缺少供应商计量时数值为 `null`，账号删除时清除该账号的明细。
