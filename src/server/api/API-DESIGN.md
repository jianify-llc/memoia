# Fact 写入与串行派生维护

## 后台推理模式

Fact 抽取与 Profile/Event 统一 maintenance 始终发送 Responses `reasoning.mode=standard`。
公开导入请求不接受 `reasoning_mode`，不保存最近 Fact 模式，也不从 User 或 Operation 继承模式。
模型、reasoning effort、服务等级及正常恢复规则仍各自独立；工具轮、Flex 恢复和重新执行均使用 Standard。

历史 Alembic `0013_reasoning_mode → 0014_fact_time → 0015_event_time` 原样保留。
0013 的历史数据库 guard 不再由运行时代码写入模式；既有 JSON 不批量清洗，也不增加兼容读取。
在撤回旧合同前必须核查旧模式的在途／可恢复请求，不能仅凭新代码通过测试假定它们不存在。

## 不变量与归属

Fact 是有消息支持的历史陈述，不维护唯一正确的当前真相；显式人工编辑可原位纠正抽取错误。Profile 整理长期属性和人物关系，Event 组织故事。后两者不能修改 Fact 或产生新的事实依据。Luvel 决定消息范围并压缩分段；Memoia 只处理一个完整有界 Blob，不建设第二套分块或通用任务平台。

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
2. 短 SQL 事务取得 generation/version、本批消息身份和项目配置，不读取历史 Fact，不持有连接等待模型。
3. 只从本批有效消息一次输出完整陈述、证据和时间；统一校验结构、来源引用及时间覆盖后保存临时恢复结果，再生成检索向量。非法结果整批拒绝，不增加模型复查。全为已处理／已删除消息时直接完成 noop，不调用模型或 embedding。
4. 同事务保存 Fact、直接索引、消息关联、completed 回执及固定 Blob 变更引用，并清除原文。

completed **只表示 Fact 操作已提交**。回执中的 memory_version 固定，不因后台维护推进而变化；fact_ids 是该次结果，event_ids/profile_ids 不再是等待条件。响应丢失先查询原回执，不重新导入。空事实和重复消息也完成固定 Blob；只有 noop 的 flush 无需模型。

长计算由 compare-and-expire 原子续租、compare-and-delete 释放的 Redis lease 协调；所有正式写入仍比较 SQL generation/version。短事务共用用户级 pg_advisory_xact_lock，与永久遗忘线性化，不跨模型 await。失锁、冲突或提交未知不能写入失败假回执，也不能只重试 INSERT。

原文只临时保存在未完成 import 的 memory_operations.request，Source 和 Blob 不保存正文副本。完成结果、回执和清理同事务提交；完成后 request 只保留操作身份。旧 chat GeneralBlob 同事务清除，不受 persistent_blob 影响。旧 summary Blob 是摘要输入，保留原有独立语义，不把它宣称为完整聊天存档。

Fact 由一次 Standard 请求同时输出正文、主体、报告者、确定性、证据和事件时间，使用 fact_extraction.md 与内部 MessageExtraction：每条用户消息一项，可含零条或多条 Fact，any_of 中的 all_of 表示独立或联合支持。入口检查消息覆盖与所属消息支撑，再无损转为现有 Extraction.support_groups；完整候选、数据库和公开 API 仍使用原格式，不保存两套表示。不同消息的独立确认允许产生相同陈述，不用后文的细节替代前文可独立成立的内容；结构检查不能证明模型没有语义漏抽。保持项目模型/思考等级、text.verbosity=low、store:false、完整固定规则和转义的 source_material；只缓存固定规则，不给动态原文打断点，不使用历史续接、Session 或 previous_response_id。正常非空输入最多一次模型调用，返回空事实同样有效；全部消息已处理/删除的 noop 不调用模型。

Fact 正文、主体和报告者跟随所属用户消息的主要语言；仅有简短确认或表情、无法判断语言时，沿用其确认内容的语言。抽取资料只有 `source_material.messages`，不传项目语言或主题配置；原名和证据引文保持原文，JSON 字段名及枚举值不翻译。项目 `language` 仍用于 Profile/Event 正文和主题配置。既有 Fact 及已保存的恢复候选不重新翻译。

已有 Operation.request 保留历史 fact_review_candidate 存储键，现只保存通过结构、引用和时间校验的完整 Extraction 与输入指纹，不新增持久状态或迁移。embedding 失败恢复时，完整候选重新校验后复用，不重复模型调用；有效输入集合变化则失效。旧四字段正文草稿缺少证据，只能从仍有效的原消息重新执行一次完整抽取，不能提交旧草稿或编造关联；其它不合法候选明确失败。不保存第二份原文或 reasoning，候选不提前推进正式版本，原七天期限及 generation/version/租约保护不变，完成或过期随原文清除。正式结果仍只有原提交事务一个 writer。

未完成输入默认保留七天（source_input_retention_seconds），重试不延长期限；API 每 60 秒清理，到期后 retry 返回 input_required。调用方先确认原回执，确未完成时以原键、原完整批次显式补交。没有原文和可恢复事实时，不承诺服务端可以独立重新抽取。事实是精简结论，不得变相复制完整聊天。日志、调试和 SQL 参数不保存正文或凭据。

非法结构、消息引用或时间关联返回 invalid_model_output，整批不提交 Fact/索引/完成回执，不静默删掉错误条目或增加修复调用。允许独立消息分别产生含义重复的 Fact，各自保留充分支持；不要求合并成一条并枚举所有替代证据组合，不改变既有 AND/OR 删除规则。同一消息的批次重放仍由消息身份和幂等约束处理，不能伪装成新独立证据。代码验证不是语义证明；真实验收同时检查信息保留、证据错误及失败率。

## Fact、时间与历史陈述

Fact 尽可能完整、客观地记录用户描述，不替用户增加判断，也不表示已经核实。保留主体、行为、原因、人物、报告者及 certainty；用户自己的感受、判断和推测按原有归属和确定程度记录。助手只能辅助理解，新增猜测不能成为独立支持。引用、否定、角色扮演和用户确认必须保留原有范围。结构校验不能证明语义正确；漏抽和过度推断仍需固定真实模型样例验收。

Fact 按可独立保留的信息组织，正文必须能独立理解，明确包含主体、对象和必要关系，不能依赖 subject 元数据或相邻 Fact 补全。需要不同证据才能成立的内容分开；同组消息支持的连贯内容可以合并，不按句子或动作机械拆分。感受、原因保留辨认活动所需的背景，不必合入整段经过。content、subject、certainty 对应同一主断言：若断言是某人可能处于某状况，用 uncertain；若断言是用户明确表达担忧，可用 asserted，但正文中的被担忧状况仍须保持未确认，不能把表达已发生当作状况已证实。

本人的普通 Fact、Profile 和 Event 使用“用户”指代，姓名单独作为身份断言保存，不装饰到无关喜好或经历中。第三方姓名和代词解释若依赖其他消息，每个支持组必须包含所需消息。派生 fact_ids 覆盖整条记录实际采用的信息，包括标题、摘要、关键词、时间、地点、正文、推断依据及标签值，而不只覆盖正文；不能把全部读集自动当作支撑。旧派生文本不是保留已删除身份信息的证据。提示词约束仍非语义正确性的证明，固定姓名删除用例与真实模型首轮失败必须分别留证。

Fact 不强制分类到画像 topic/subtopic；旧分类只作为 legacy 元数据。一个 support_group 内消息共同支持，多个组是独立替代支持：删除必要消息使整个组失效，不将组缩成剩下半句。事实仍有完整组则保留；重叠批次复用消息身份，不增加证据份数。

同批或不同批次的历史陈述可以并存；抽取不搜索、改写或隐藏旧 Fact。本批明确更正的旧说法若保留，须写明是先前的说法，不能把说错的内容当作曾经发生的情况。明确更正、否定和不确定性保留在陈述中，不用含糊指代猜补旧事实，也不把“曾告诉别人某事”提升为该事已发生。保留旧说法不表示仍采用旧结论；Profile/Event 按相关陈述、发生时间和明确更正整理当前理解，不能只按录入时间判断真伪。没有纠正关系图或 active 隐藏状态；旧 included 只是历史分类元数据。Source 仅为外部来源及消息身份／删除边界，没有累计 Fact 条数上限。

occurred_at 是当前支持消息的最新记录时间；删除较新独立组后同事务回退。fact_time 对应 Fact 所描述的事情或状态，不机械绑定句首“用户说／回忆／更正”；通知等交际行为本身是所记事情时，才采用该行为的时间。担忧、不知情或通知不继承其对象的发生日期。

fact_time 保存包含首尾两天的 ISO 8601 日期 start/end（YYYY-MM-DD）、year/month/day/range/unknown 精度及原消息表达。年月边界只说明精度，不表示状态持续了整年/月。持续、周期或未解析表达不能确定完整日期区间时使用双 null 与 unknown；正文及 evidence 保留时间含义，不补造结束日。没有时间表达时 fact_time 为 null。模型 Schema 区分完整日期与双 null 分支，共用 FactTime 日历校验；严格输出字段仍必填，业务未知值用 null。unknown 可以参与文本/向量检索，但不命中精确日期筛选。

原消息 time_zone 由代码用于计算 local_recorded_date；抽取 input 只传计算后的日期，不重复传 IANA 时区。记录／处理时刻不能直接代替发生日期。维护 Loop 使用当前 fact_time 和正文中的明确时间表达，不重新按本轮日期换算历史。删除时间依据立即清除不再有支撑的 fact_time；新旧索引文本相同则复用向量，否则重新 embedding。

0014 将原 event_time 列及未完成纠错／抽取候选中的对应字段改为 fact_time，保留日期值和证据。公开 API/SDK 只提供新名，消息输入及 event_after/before 查询参数不变。旧操作的 request_hash 不改；纠错 fingerprint 仍以历史 event_time 键规范化，确保载荷已清除的完成回执与过期原操作仍使用原幂等身份。已存索引文本不因字段改名重写或重算向量。

Fact.created_at 是首次数据库插入时间，updated_at 是最近修改时间；修改不改变 created_at。旧行无法确定的生命周期时间保持 null，不借消息或 Blob 时间猜补。来源读取、独立 query、search、context 和 Loop 返回同一组时间，均不能代替 occurred_at 或 fact_time。

人工编辑保留原 Fact ID、原 Blob 和来源归属；支持组只能使用原 Blob 内未删除的消息，每组至少包含一条用户消息，助手消息可提供必要上下文。新幂等 Operation／固定 Blob 使用 kind=correct，内部 Fact 变更为 updated 或 deleted；它是定点修正，不是新增历史陈述或证据迁移，也不建立纠正图。任何实际编辑均推进 Fact revision 和 updated_at，同事务更新直接索引、清理旧画像历史并登记维护。Loop 只整理 Profile/Event，必须读取当前 Fact；编辑前的读集不能提交旧版本结果。

失败的人工纠错不能靠重复 PUT／DELETE 执行：同键请求只返回原回执。临时载荷过期时，遗留 processing 收敛为 failed/input_required；定时清理和请求登记使用相同规则，已完成回执和既有失败原因保留。以原键补交相同完整请求只恢复载荷，重复补交也不执行；真正再次执行必须显式 retry 原 Operation，并重新校验 expected_revision。请求未知结果同样先查原回执，不换键重放。

请求最大 2 MiB、每批最多 1,000 完整消息、正文默认 16,384 tokens，另校验提示词和输出预留，不能截断成功。旧容量失败回执不改写或自动重放，只能显式恢复原操作／幂等键。原文过期时，按原键补交原批次只补回七天临时输入，不改变原错误或启动模型；随后再次显式 retry。正文不匹配仍报冲突，重复补交不续期。参数/鉴权错误不自动重试。embedding 每批默认 64，严格校验索引、条数、维度及有限数值。

## 固定 Blob、flush 与统一 AgentLoop

消息导入、删除或人工 Fact 编辑各有一个固定 Blob；幂等键定位原 Operation/Blob，重试不能扩大消息范围。Fact、索引、回执和 Blob 的 fact_changes（新增、人工编辑、删除、证据及时间变化引用）同事务提交。Blob 不保存聊天原文。人工 Profile 编辑、Event 删除和 Agent 写入不生产 Blob。

主动 POST flush 或 Worker 定时 flush，在短事务按完成顺序选取完整 Blob；可跨 Source，不跨项目/用户。每次扫描最多 100 个，变更引用与当前有效 Fact 的 JSON 总预算为 256 KiB，不能拆开 Blob。剩余、在途及随后完成的 Blob 留给下一次，pending_blob_count 可见；同键重试不扩大集合。单个 Blob 已超限时固定原集合并明确报 maintenance_capacity，不无限调用模型；恢复仍受容量校验。查询不改变计时，自动静默 30 秒、最长等待 120 秒。空 flush 直接 completed，不调用模型。

Operation(kind=flush) 是唯一调度和恢复身份，source_id/blob_id 为 null；保存固定 Blob 集合、执行租约、generation、尝试次数和下次执行时间，不新增任务 ID 或维护 Task 表。每个项目/用户最多一个有效执行者；短事务领取后释放连接，模型等待不占 Fact 写入锁。失败/退避释放执行权，新批次可继续。首次加三次恢复，间隔 5/15/60 分钟；耗尽保留原失败，显式 retry 原 operation_id 才重开预算，新批次不重置旧次数。

Operation.status 是终态真相源：待领取、执行及自动退避均为 processing，退避可携带 retryable 的末次错误；不可恢复或四次耗尽才为 failed，提交回执后才为 completed。flush.status 对应 pending/running、failed、completed，不独立猜终态。Worker 每轮独立回收过期租约，第四次崩溃也收敛到 failed；重复恢复 processing 不重置预算。

维护校验使用具体安全错误码。已知但正文未读或已不存在的 Fact 支撑返回 `staged=false`、整批目标 `ids` 和 `error.unread_fact_ids/invalid_fact_ids`，不暂存该批任何修改，也不自动查询或替换支撑；模型可在同一 Loop 和原时间预算内补读、修正。返回引用与输入顺序一致，新建目标仅预留本轮身份，修正必须复用。未解决目标仅在成功暂存或显式移除后解除；其它目标成功不能解除，未解决时以 `maintenance_unresolved_staging` 拒绝完成。同目标重复相同错误提案且相关支撑读取状态未变，以 `maintenance_staging_repeated` 终止；无关读取和引用重排不重置保护。未知／类型错误引用仍以 `MAINTENANCE_REFERENCE_INVALID` 终止；格式、归属、配置、失租、读冲突和数据库错误不交给模型纠正。日志只记录操作身份、错误码、计数及有界内部 ID，不记录正文、凭据或完整工具参数。结构合法仍不证明语义完整；验收保留首次失败。

Loop 工具用本轮短引用：Fact 为 f1/f2，Profile 为 p1/p2，Event 为 e1/e2。首次返回条目或关联时编号，后续搜索、分页、精确读取和暂存复用，新增条目继续追加；已删除引用不回收、不重新分配。引用只进入工具身份／关联字段，面向用户的正文、标题、摘要等不附内部引用；证据保存在 fact_ids。只有维护工具边界转换类型化引用，不改写自然文本；读集、并发锁、提交、数据库和公开 API 始终使用真实 UUID。每次执行独立持有映射，恢复新建响应链与映射，不跨用户或任务共享；服务端压缩不改变内存映射。新建派生条目传 id=null，工具返回短引用；关联引用不代表正文已读或 Fact 仍有效。查询名字用 query/search，不猜引用或模糊匹配 UUID。

一个 OpenAI Agents SDK Agent 同时查询并暂存 Profile/Event，模型自行安排处理顺序；不能修改 Fact。只使用 Agent、异步 Runner、函数工具和 Pydantic，不使用 handoff、持久线程、MCP、Shell/文件工具。禁用外部 tracing/正文 debug，transport max_retries=0。项目 llm_model/reasoning_effort 默认继承 gpt-6-luna/high，运行固定配置、最终再次校验；不静默切模型或降低等级。

Fact 与维护 Loop 均使用 text.verbosity=low，与思考档位、正文和支撑完整性要求独立。Fact 使用默认服务等级（service_tier=default），与固定的 reasoning.mode=standard 独立；Loop 每次模型调用先 Flex，临时供应商失败/超时后仅本次调用降级 Standard，下次调用重新先 Flex。同一次调用的 SDK 重试保留当前服务等级，只有通过校验的成功响应才复位。只重试未执行工具的模型请求，Flex fallback 延续原运行预算、parent/input 和缓存键，不重启会话或重置限制；跨等级缓存收益须实际观测。鉴权、输入、拒绝/过滤、失锁和预算错误不能借 fallback 绕过。单次生成最多 32768 tokens，一次 Loop 整体最多 900 秒，不设模型请求次数或累计 64K 上限，用量仍记录。Responses 使用 store=true、previous_response_id 增量续接，原生 context_management.compact_threshold=256000（十进制）；不增加摘要模型调用，数据库读集和暂存修改不压缩。模型/入口真实兼容性单独验收。

首轮 maintenance_batch 只提供变化数量 change_count 及第一页变更（items/next_cursor），不传后台水位 through_version 或批次数 blob_count，复用 read_changes 的有界读取、读集和覆盖登记。每项含当前有效 Fact（不存在时为 null）；初始输入与后续工具共用本轮短引用。超出单页才由 read_changes 续读，遗漏任一非 noop 变更不能完成，全部检查后不生成派生修改可合法完成。read_memory 用于已知 ID、分页和单字段内不区分大小写的连续文本片段过滤，不拆分关键词；search_memory 用于语义/关键词探索，复用同用户混合搜索。已有完整结果直接使用，不要求两个工具互相确认；stage_profile/stage_event 批量暂存。读取/修改工具以完整条目分页，单页/批最多 64 KiB、200 条，首轮加载最多 200 条、工具读取默认 100 条，混合搜索最多 20 条；超限不截断正文。取消全局 100 个暂存目标限制。工具读当前数据并登记版本，不按旧 flush 水位过滤，不接受 project/user，不加载全部历史。覆盖校验不能证明模型语义判断正确，真实样例仍需验收。

直接使用首轮变化，按需补页和查找相关已有记忆，不固定预查两类派生条目。新增陈述缺少相关旧记忆时用 search_memory 发现；同一人物／故事的相关变化优先合并搜索，不按 Profile/Event 拆查询；不同主题或结果不足时仍可独立并行搜索，不设固定搜索次数。人工编辑、删除、证据或时间变化使用完整关联分页，不能以有排名上限的搜索替代受影响条目的覆盖。混合批次兼顾两者并复用已得结果。read_memory 的 ids/query 均为空时，仅返回关联本批变更 Fact 的条目；空页不代表用户没有其它相关记忆。创建前须发现相关已有条目，已返回完整候选时直接复用，不重复确认。旧 flush 恢复按当前数据发现已有条目，不能因旧 added 标记跳过发现；当前 Fact 已不存在时，仍按关联定位失效派生条目。

每轮模型请求串行；同轮独立工具通过 SDK 原生配置最多并发 4 个，其余在本轮排队；相同集合、相同目标 ID 的暂存写入仍按序执行。工具上限不等于 Worker 的用户 Loop 并发数（现有默认每进程 2 个，其余用户等待数据库领取）。SQL 线程使用私有读集/暂存快照，返回后由事件循环先校验再合并读集；并发读取版本不一致或返回项的暂存内容已变化，整轮失败而非覆盖检查。read_changes/search 已返回完整条目，不强制再次读取；仅补查缺少的相关历史，批量查询和暂存，预留最终完成请求。工具 schema 分开表达 upsert/remove：前者必填正文和非空 Fact 支撑，画像还必填分类；后者只接受现有 ID。运行日志仅记录 Operation、请求轮次、服务等级、工具名称、数量、状态及耗时，不记录参数/正文，不启用外部 tracing。脚本化模型测试证明执行边界，真实模型验收另证规划效率与语义效果。

代码先暂存失去全部有效 Fact 支持的受影响 Profile/Event 删除，模型无需逐条发删除命令；有独立有效支持、无事实关联的人工/legacy 条目不机械删除。该清理与模型修改一起原子提交，读集阻止途中支持恢复或目标被人工修改后误删。

模型给出的 `fact_ids` 只表示实际支撑；代码另在既有 JSON 中保存内部 `_impact_fact_ids`，用于删除和纠错定位，不返回给模型或公开 API。每轮输出使用最终 Fact 读集和已读 Profile/Event 继承的影响范围，在版本校验后、两类写入前统一计算。只剔除本批明确处理且已不存在的删除 ID；属于其他待完成 flush 的删除 ID 继续传递，避免旧正文经新条目逃过后续清理。影响范围是保守上界，不宣称每条 Fact 都支持每项内容，也不改变检索的支撑关联。

非新增 Fact 变化同事务增加受影响派生条目的内部 revision；旧 Loop 即使只读过派生文本，也不能绕过并发检查。影响范围只产生需复核候选，不是删除依据；每项必须明确 keep/upsert/remove，遗漏则原 flush 失败，不提交半成品或默认删除。keep 仅接受实际读过的完整目标，且原有非空支撑全部有效并已读；提交继续校验版本，不重写正文、向量、时间、影响范围或历史。只有已知支撑全部消失才自动暂存 remove，缺少关联不等于支撑全部失效。执行中新出现的受影响条目仍由完成检查阻断。旧条目缺失/null 影响范围视为未知，在同用户删除、纠错或证据变化时保守纳入复核；普通新增不扩大到全部旧条目。只有实际返回给模型的旧文本才继承影响范围；keep 保留原范围，不能靠现有 `fact_ids` 将未知洗成完整。新建纯人工画像的影响范围为空，人工更新不能清除或伪造此字段。

画像历史的三类快照同样保存内部影响范围，删除/纠错时过滤受影响条目。旧快照范围未知的不作为可恢复历史返回，也不从当前同 ID 画像补猜。原历史记录及旧派生正文不作发布时批量删除；当前正文仍遵循待 flush 语义。这项改动不新增表、迁移或外部版本协议；保守范围可能使更多条目需要整理，不能据此承诺模型不会漏记或错误概括。

可变 Fact/Profile/Event 集合使用稳定 ID 游标，与本轮暂存修改按同一 ID 顺序合并；不建立快照表。游标停在最后实际返回的完整条目，字节预算不足不截断或跳过未消费项。省略 ids 仍返回完整正文，不降为目录预览；单条超出字节预算明确失败。固定 read_changes 列表仍用 offset。待删除派生条目保留 pending_delete 导航信息；旧文本不是证据。关联按页批量读取，提交按集合批量锁定并比较内部 revision。

同步 SQLAlchemy 保留；每个完整 SQL 工作单元在线程内创建、使用和关闭 Session，不跨线程传 ORM 对象。公开记忆读取的短 SQL 单元使用 REPEATABLE READ，让正文、支撑和待处理状态来自同一快照，避免并发 flush 完成后给旧正文配上新证据；不跨模型或网络等待持有事务。异步层负责模型与 Redis 等待。请求取消时等待 SQL 结果后才释放写租约，不将响应取消解释成事务失败；鉴权仍逐请求读数据库，不缓存权限。

所有修改先保存在本轮内存，最终短事务验证执行权、项目配置、读过的 Fact revision 和目标条目 revision，用既有 Redis renewable lease + SQL generation/version 写入保护。Profile、Event 与 flush completed 回执一起提交；失败两类全部回滚。相关删除、证据变化或人工编辑使旧计划失败，无关新增不废弃本轮；旧 flush 恢复重新读取当前事实，不能按历史快照覆盖新结果。永久遗忘立即阻断工具读取及最终提交。常规日志仅状态、轮数、Token、耗时和安全错误码；未读支撑错误的有限 ID 诊断遵循上文边界。

必处理集合复用本轮准备时查到的保守影响范围，不因普通搜索或额外读取扩大。工具条目的 `review_required` 标明该范围；首轮变化页、后续读取和暂存回执中的 `remaining_review` 按 Profile/Event 返回剩余 count 和至多 20 个 ID，接受决定后列表推进，无需额外游标或任务状态。短引用仍由同一映射生成；清单只有身份，不代表正文或支撑已读，模型对已有条目做任何决定前必须读到完整正文。已接受 keep/upsert/remove（含已知全失支撑的自动删除）退出剩余清单，被拒绝的重提仍保持未完成。结束时先检查本轮剩余项，提交事务再检查当前数据库范围与版本；并发新增影响不能被旧清单掩盖。

## 默认画像目录与三类初始背景

维护工具向模型声明与执行检查一致的读取范围：目录／变更页 1–200、搜索 1–20、精确读取最多 200 个 ID、查询最多 500 字符。超限仍失败，不静默放宽；容量诊断只记录工具名、数量及长度，不记录查询正文或 ID。Schema 声明不保证模型永不超限，真实模型失败须保留原操作证据。

默认一级分类为 `user_profile`、`personal_background`、`work`、`education`、`interests_preferences`、`lifestyle`、`goals_values`、`relationships`。中英文使用相同英文标识，描述与画像正文按项目语言输出；详细边界由 `prompts/user_profile_topics.py` 的双语目录统一维护。二级分类仍由现有 Loop 创建和复用，不新增人物表或单例约束。

`user_profile` 仅保存本人重要稳定背景和长期重点的简短概况，不拼接全部详细分类；`interests_preferences` 保存稳定兴趣和偏好，明确表达的长期交流偏好使用 `sub_topic=interaction_preferences`，不再作为独立一级分类，不保存一次性指示、短期情绪或助手猜测；`lifestyle` 保存持续日常习惯、作息和生活方式，不将一次经历断言为长期习惯。三类可以各有多条简短、非重复的 Profile，并保留有意义的二级分类。Loop 根据相关 Fact 增删和证据变化更新，优先查找并修改已有条目；明确更正也是新增历史陈述，不回写旧 Fact。所有画像均直接关联有效 Fact，不互相作为证据，也不为每次聊天重新生成全部概况。偏好是参考资料，调用方的显式设置与当前要求优先。

Luvel 默认分别调用既有 `queryProfiles`，读取 `user_profile`、`interests_preferences`、`lifestyle`（query 省略或 null，不能用空字符串），保留二级分类标签，在共享总预算内选择完整条目；其它分类按需检索。没有条目就返回空，不拼接或回填旧分类。不新增 API、SDK 方法、模型调用或调度器。

只替换系统默认模板，保留项目 overwrite/additional 配置；不修改已存的自定义目录，不建立旧默认映射或迁移／重建工具。修改模板不意味着历史画像被重新整理。Test 旧画像清理需独立定界和授权，且须等新 API/Worker 发布、排除旧在途写入后执行；不隐式清理 Fact/Event/Source/聊天或画像历史。

本地验证目录一致、实际请求提示词、现有查询隔离、二级分类与删除后增量维护；这不能证明模型语义。真实模型首轮验收应区分“今天简短一点”（不存长期偏好）与“通常喜欢简洁解释”（可存），以及“今天走路上班”（不认定长期习惯）与“通常走路上班”（可存生活方式），验证他人职业只进关系人物、详细工作背景不全量复制入概况，以及删除偏好证据后只更新受影响条目。

## 删除与派生中间状态

DELETE sources/{source_id}/messages 接收用户定位、message_ids 与稳定幂等键，不需要正文、event_id 或 blob_id。同步处理所有相关 Blob 的支持组、Fact、直接索引、消息墓碑及完成回执，登记该次删除 Blob。重复删除稳定成功；未知消息也写无正文墓碑，迟到导入不能恢复贡献。

**旧 Profile/Event 文本可暂时读取，直到统一 Loop 成功。** 接口/Inspector 显示待更新或失败；失效关联不得作为有效 Fact 证据返回。公开读取按尚未完成的 Blob/flush 变更排除被修改、删除或证据变化的 Fact 关联，不能用修正后的 Fact 为旧正文作证；无关的有效支撑保留。原数据库关联仍供 Loop 定位待修条目，当前 Fact 也仍可独立读取，不新建证据快照。删除后的旧文本可能暂时进入聊天上下文，维护失败不保证固定时间内消失。历史读取过滤失效证据，不提供恢复已撤回内容的接口。

删除 Event 只删除该事件及派生索引，不改变 Fact 或画像；保存被删除事件 ID 墓碑，后台不能复活该 ID。人工修改增加 revision、保留证据关联，后台旧版本提交失败，不承诺人工文本永远不被后续正常整理替换。

Profile/Event 鼓励基于当前有效 Fact 作有用的推断，而非仅摘抄。Profile 可归纳特点和关系模式，在现有正文中用“可能／倾向于”等表达区分推断与明确描述，不新增字段。Event 的 title/summary/keywords/event_time/location/content 保留有依据的经历，未知为空；可能的原因、动机、影响或意义放入 interpretation。两者都须直接关联作为判断依据的 Fact；派生解释不能回写 Fact 或成为另一条记忆的独立证据，依据修改或删除后须重新判断推断是否成立。同人物/关键词不自动合并故事，Fact 与 Event 多对多。原文已清除，遗漏的具体经历不能靠推断补造。

Fact 抽取只产生事实，不重复生成 Event 标签或画像分类。Fact-first search 使用 Fact 向量；独立 events/query 使用 Event 向量。Loop 完成修改集后，在写锁和 SQL 事务外批量计算新增／文本变化 Event 的向量；Profile、Event、向量、关联及 flush 回执仍一次提交。索引失败不提交半成品，复用原 flush 恢复；提交前继续检查事实及目标版本。未变的索引文本复用向量。Loop 与人工 Event 路径共用 factual title/summary/keywords/event_time/location/content 的索引文本，旧 event_tip/profile_delta/tag 保留兼容，不把 interpretation 当成事实索引正文。显式关闭 embedding 时仅词法查询。

Profile/Event 的 created_at 由数据库在创建时生成，更新不改变；不再用支撑消息的 occurred_at 覆盖。Event.event_time 是故事发生时间的文字描述，Fact.fact_time 是事实的结构化日期及证据；两者都不同于入库时间。旧记录曾将来源时间写进 created_at，不能可靠还原的保持 legacy，不以当前时间或 updated_at 猜补；历史 created_* 筛选因此不能保证精确。

Fact 人工编辑、删除或时间证据变化时同步清理相关历史画像；AgentLoop 不能把旧文本、后续未处理 Blob 或迁移 flush 所涉及的失效文本重新记入历史。新旧 flush 恢复都读取当前 Fact，并过滤其它未完成变更涉及的旧画像。当前派生文本允许延迟更新的契约不变。

永久遗忘 DELETE users/{uid} 仍立即阻断读取及后续提交，不采用派生延迟语义。短 SQL 事务写项目/UUID 墓碑并级联清理；不等待长 Redis/model lease。旧执行者提交遇到墓碑返回 410 user_forgotten。重复调用返回同 UUID forgotten=true；墓碑不含正文，不能随 User 清理消失，也没有恢复身份参数。

## 接口、检索与消费者

主要接口（均在 /api 下）：
- POST users/{uid}/blobs：source_id、idempotency_key、带 message_id/role/content/occurred_at 的消息。
- GET users/{uid}/blobs/{blob_id}、sources/{source_id}：有界来源/批次及当前证据。
- POST users/{uid}/flush：稳定 idempotency_key，返回固定集合及 kind=flush 的 Operation。
- GET users/{uid}/operations/by-key/{key}、operations/{id}、POST operations/{id}/retry：查询/恢复原 Fact 或 flush 操作；恢复 flush 不重发正文。
- GET users/{uid}/maintenance：未封闭 Blob 数量及最近 flush 状态、错误、尝试次数和固定 Blob ID。
- DELETE sources/{source_id}/messages：删除消息贡献；DELETE events/{id} 与 DELETE users/{uid} 独立。
- PUT users/{uid}/facts/{fact_id}、DELETE users/{uid}/facts/{fact_id}：write scope；稳定 idempotency_key、expected_revision 和人工 reason，返回 kind=correct 的 Operation。编辑提交完整 content/subject/reporter/certainty/support_groups/fact_time，证据遵循上文的原 Blob 支持组约束；原文已清除，身份和结构校验不能证明编辑内容语义为真。版本冲突先读当前 Fact，不自动覆盖；恢复沿原 Operation。
- POST search、POST context：私密查询留在 JSON body，使用 read scope。

POST search 的 `query` 保留在请求正文：并行计算查询向量和文本候选，以 pgvector、PostgreSQL FTS/字面匹配融合排序。先按顺序选择完整 Fact，再读取这些 Fact 关联的 Event/Profile；返回 `facts`、`events`、`profiles` 三个独立字段，不把 Fact 包装成 Event，也不新增查询分类模型。相同关联条目去重；三类完整对象及证据共同计入 `max_token_size`（默认 4,000，上限 10,000），放不下整条就跳过，不截断正文或证据。无 Event 的有效 Fact 立即可搜，删除 Event 不影响 Fact 召回。

`exclude_fact_ids`、`exclude_event_ids`、`exclude_profile_ids` 各最多 500 个 UUID。三类输出独立按 ID 排除，不改变数据库，也不新增 revision 协议。已注入 Fact 不再独立输出，但仍可导航到未注入的关联 Event/Profile，包括异步维护后来生成、或上次预算未容纳的条目。候选只保留未见 Fact，或仍关联允许返回的未见派生对象的已见 Fact；两类各有有界候选池，已见 Fact 不挤占未见 Fact 的位置。关联内容和完整证据仍计入响应总预算。调用方在整个 Dialog 内保留实际已注入的 ID：同 ID 后续文本更新仍被该会话排除，新会话自行重置。本人的每轮画像读取仍是独立调用，不因检索排除消失。现有 `include_events=false` 可以明确关闭故事扩展，旧 `event_max_tokens` 可进一步限制故事子预算，但不能突破总预算。临时 query embedding 故障保留词法召回，输入/配置拒绝仍失败。不承诺精确时间过滤或穷尽列举。

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

历史缺失 Event 向量使用 `python -m memoia_server.event_index_backfill --project-id … --user-id … --limit 100` 只读预览；另行授权后添加 `--apply` 才调用 embedding 并写入。每次最多 500 条，输出 last_id 可传 `--after` 继续；并发编辑／删除的行跳过，下次不带游标重新扫描缺失项。只补空向量，不改正文、时间、revision，不重新抽取或运行 Agent。共享库执行与真实模型调用不是本地验证的一部分。

Alembic 0008 建立：维护任务、Fact revision/纠正关系、直接索引、派生多对多及版本约束。旧 Fact active=true，不从 included=false 猜失效；机械迁移已有同归属索引/关联，缺失主体/报告者保持 legacy。0009_blob_flush 前向迁移将旧任务进度/变更/失败转为 Blob 引用和可恢复 flush Operation，随后移除旧维护表；旧在途 owner 不延续，原身份及次数保留，重新读当前 Fact，不重新抽取原文。旧删除操作补固定 Blob，未知消息补无正文墓碑。0006 已清除的聊天不能恢复，不用模型猜补；历史备份/WAL 中正文需独立保留策略。

0010_historical_facts 只删除旧 active=false Fact，不复活隐藏内容；保留其他 Fact、来源、消息、固定 Blob 和原回执。删除前机械保留受影响 Event 的关联导航、定点清理引用这些 Fact 的历史条目，再用已有 flush legacy_changes 承载有界删除变更，不改已封闭 Blob。未完成迁移 flush 也参与历史失效过滤。退出纠正表、触发器和 active，补反向关联索引；迁移不可逆，不在迁移中运行模型。退役配置另行核对，不由迁移静默修改。

0011_retire_gists 删除旧 Gist 索引表及全部运行分支，保留 Event 正文、Fact、消息和回执；
仅存在于旧 Gist 的细节退出检索，不伪造 Fact 证据。Blob message_ids 使用 jsonb_ops GIN
索引支持删除的精确成员查询，不新增关系表。flush 候选事实批量读取一次。

应用 import 不做 DDL，启动检查 head/向量维度。运行连接默认连接 5s、锁等待 5s、单 SQL 30s 截止（可配置正数），断连启用 TCP keepalive/user timeout；超时回滚后才释放写租约，未知提交仍查询原回执。Alembic 独立维护连接不继承这些 SQL 上限。数据库池默认每进程 8+4，多 Worker 必须核对总连接预算。同镜像运行独立 maintenance_worker，Compose/健康/发布/备份均覆盖 API 与 Worker；新 schema 不允许普通 prepare 或旧 API 镜像回退。迁移、提交、共享库和 Test 部署需另行确认，不操作 Online 或云配置。

验证分层报告：纯函数/MockTransport → 隔离真实 PostgreSQL/Redis（迁移、归属反例、事务、接管、新变更、原 flush 恢复、永久遗忘）→ 当前模型真实工具调用/固定语义样例 → Test API → Inspector UI。静态代码、MockTransport 和本地容器不等同真实模型或远端发布验收。

source_quality --list 不加载业务配置/模型；执行从受保护 stdin 收模型 JSON，禁用 .env/config 自动发现、计费及数据库连接，只计算公开合成夹具。每次调用正常单次抽取，不重跑到通过，输出标记 human_review_required=true。extract_system override 只替换这次抽取规则，报告记录实际 Prompt/schema hash。机械概念／支持组检查不等于语义证明；模型失败原样保留，凭据使用另行授权。
