# 进程接口与模型调用契约

## 1. 通信封装

Electron main 启动一个 Python service，stdin/stdout 为 UTF-8 JSON Lines，一行一个完整对象。stdout 禁止普通日志；日志走 stderr 并脱敏。解析器需支持跨 chunk 和一 chunk 多行，不能直接对每个 stdout chunk 做 JSON.parse。

首条事件为 ready，含 protocol_version=1、app_version、schema_version。版本不兼容时显示启动错误，不继续发送业务命令。

```json
{"type":"request","id":"req-uuid","method":"jobs.list","params":{"scope":"discover","page":1,"page_size":50}}
{"type":"response","id":"req-uuid","ok":true,"result":{"items":[],"total":0}}
{"type":"response","id":"req-uuid","ok":false,"error":{"code":"VALIDATION_ERROR","message":"Select at least one query","retryable":false}}
{"type":"event","name":"run.updated","seq":12,"data":{"run_id":"run-uuid","status":"running","stage":"scoring"}}
```

每个请求最多一个 response，事件无 request id 依赖。长操作先返回 `{operation_id,run_id?}`，后发事件。事件 seq 只在本 service 会话单调递增；重连后重新读取状态，不要求实现事件回放系统。

错误码至少包含 VALIDATION_ERROR、NOT_FOUND、BUSY、AUTH_ERROR、RATE_LIMITED、NETWORK_ERROR、INVALID_MODEL_OUTPUT、PROXY_ERROR、WORKER_EXITED、CANCELLED、INTERNAL_ERROR。message 可读且不含 Key、认证代理 URL、原始响应全文；可返回 field_errors。provider HTTP status 可作为独立字段。

调用方超时不等于后台已取消。查询命令超时可重试；start、resume、jobs.score、draft generate 等变更命令不自动重发，等待期间禁用对应按钮，确认超时后先通过 app.status/runs.detail 查询状态。请求 id 仅用于匹配响应，不持久化操作防重凭据或响应。清单加入天然幂等，运行创建由 service 互斥；cancel 单独命令。LLM operation 取消后停止后续派发与重试，已发出请求结束前仍占用全局并发额度；已取消的草稿/测试不应用迟到结果，岗位评分的停止语义见 PIPELINE。

Electron 对 renderer 暴露具名白名单函数，不暴露任意 method、shell 命令或 SQL。TS 定义消息类型，Python 在命令入口校验所有输入；不单建 JSON Schema 文件或双端运行时 schema 校验。单条消息大小设工程上限并返回可读错误；大型 JD 列表不返回全文，只在 detail 读取。

## 2. 查询对象

### M0 后端已实现的最小接口（2026-10-18）

当前仅实现 `app.status`、`app.ping` 和 `app.diagnostics`；其余目录为后续阶段契约，未实现的方法返回 NOT_FOUND。ready 使用统一事件封装：`{type:"event",name:"ready",seq:1,data:{protocol_version:1,app_version:"0.1.0",schema_version:1}}`。启动锁/迁移失败不发送 ready，stderr 报错并以 2 退出。

`app.status` 无参数，返回 `{active_run:null,operations:[],cleanup:{status:"idle"},configuration_complete:false,storage:{schema_version:1,journal_mode:"wal"}}`。此阶段尚无配置、run 或清理服务。`app.ping` 要求 `{message:string}`（最长 256 字符），原样返回 `{message}`，用于最小通信操作。`app.diagnostics` 无参数，执行离线依赖/原生 curl 导入和 SQLite 写读回滚，返回版本、声明的锁定 JobSpy SHA、架构、frozen 与 storage 诊断；不访问网络，不保存诊断状态。

消息工程上限为每行 1 MiB（不含 LF）；id 为 1–128 字符的字符串，params 可省略为 `{}`。畸形 JSON/UTF-8、无有效 id、超大行的错误响应使用 `id:null`；有有效 id 的入口校验错误保留该 id。超大行丢弃到下一个 LF 后继续接收。暂不增加 shutdown 命令；stdin EOF 或 SIGTERM 正常释放 SQLite/目录锁。对照实现与复现命令见 `job-vaccum-app/backend/README.md`。

M0 Electron 集成已完成：main 检查首条 ready 的 protocol_version=1 后才发送请求；具名 preload 为 getConnection/onConnectionChange/getStatus/ping/getDiagnostics，不透出任意 method。启动等待 10 秒，status/ping 请求 10 秒、离线诊断 30 秒，超时只结算本地请求，不取消、不自动重发；迟到响应忽略。关闭窗口保留 main/service，重开查询状态；显式 Quit 关闭 stdin 等待 10 秒，然后按需 SIGTERM、1 秒后 SIGKILL，再最多等 1 秒退出。无自动 service 重启或事件重放。M0 没有定时运行或业务 worker，这些后续按原阶段实现。


### M1 第 1 步桌面外壳接口（2026-10-19，已与第 2 步汇合）

在既有接口及 M1 具名业务方法之外，preload 增加三个仅由 Electron main 处理的具名方法：

- `getAppInfo()` 返回 `{version,arch,packaged,data_dir}`；data_dir 仅供 About／启动失败页显示，家目录缩写为 `~`，不作为 renderer 的文件访问能力。packaged 用于仅在开发构建显示 Ping。
- `quit()` 走既有 before-quit 有界退出流程。
- `showDataFolder()` 在 Finder 中显示当前 App 数据目录，不接受任意路径或命令。

三者均验证调用来自当前主窗口主 frame／已知 renderer 文件，不经过 Python，不新增 service 命令。外观及侧边栏偏好使用 renderer localStorage `jobVaccum.ui`（位于本机 userData），不写 SQLite。自动窄窗口折叠不修改偏好；任何窗口宽度下的手动切换保存 sidebarCollapsed。第 1、2 步汇合后 ready/storage 的 schema_version 为 2，protocol_version 仍为 1。

FilterSpec：scope=discover/applications；可选 text、direction_ids[]、sources[]、companies[]、locations[]、job_types[]、run_ids[]、score_min/max、score_states[]、in_applications、application_statuses[]、first_seen_from/to、date_posted_from/to、date_posted_unknown、added_from/to、updated_from/to、salary_presence=known/unknown、salary_min/max/currency/interval。数组内 OR、维度间 AND，空数组表示不限。date_posted_unknown 与发布时间范围互斥；薪资数值范围必须指定 currency/interval，按已知区间重叠匹配，未知端点开放、双端未知不匹配。发现/加入/更新时间的日期选择转为用户时区当天边界对应的 UTC 毫秒半开区间 [from,to)；date_posted 保留来源 YYYY-MM-DD 日期精度，其范围也使用 YYYY-MM-DD 半开区间，不伪造发布时间。清单专属字段用于 discover 时返回 VALIDATION_ERROR。run_ids 为抓取运行（kind=pipeline）ID，匹配 `EXISTS run_jobs(run_id IN run_ids AND is_new=1)`，即在所选运行中首次发现的岗位；空数组为 All，rescore 运行 ID 返回 VALIDATION_ERROR。

sort 白名单为 first_seen/date_posted/score/company/title/location/job_type 各自的 _asc/_desc，以及仅清单可用的 status/added/updated 各自 _asc/_desc；status 按 new、applied、oa、interviewing、offer、rejected、ghosted 的固定顺序排序；发现页默认 first_seen_desc，清单默认 added_desc。固定追加 job_id ASC，所有空值置后。page>=1，page_size 默认 50、最大 200。响应 items、total 使用同一筛选；多来源/方向使用 EXISTS，不能放大结果行数。查询参数全部参数化。


score 筛选只匹配实际存在的成功分数，不能把 NULL 当 0。全文检索首版可用公司／标题／地点的 LIKE，不需要语义搜索。非法排序字段拒绝而非拼进 SQL。

JobSummary：id、company、title、location、job_type、score 可空、score_reason、score_state、scored_at、first_seen_at、directions[{id,name}]、in_applications。JobDetail 在此基础上增加 description、salary、links、sources、queries、application{status,notes,added_at,updated_at}、last_score_error。

所有协议 JSON 使用 snake_case，TS 类型可保持同名减少转换。所有事件及管理时间为 UTC 毫秒；来源 date_posted 及其筛选边界为明确的 YYYY-MM-DD 日期，不传含糊的本地日期时间字符串。

撤销由前端用 remove 或 set_status 返回的修改前数据调用 applications.restore；只在提示条显示期间提供，不建撤销历史表，岗位已被清理时返回 not_found 并提示。批量加入由 service 单次短事务处理所有有效 ID，失效 ID 返回 not_found；内部错误回滚，不报告虚假成功。重复调用天然幂等，无需新任务表。前端使用请求序号忽略过期列表响应；批量反馈分别显示新增、已存在及失效数量，仅在成功响应后更新选择和列表。

## 3. 命令目录

| 命令 | 输入 | 输出或效果 |
| --- | --- | --- |
| app.status | 无 | 活跃运行、operations、清理状态、配置完成状态 |
| settings.get | 无 | 非敏感正式配置、has_key |
| settings.save | 本次修改的配置字段 | 校验并串行更新，返回更新后的配置 |
| directions.save/delete/reorder | ID、编辑字段或有序 ID 列表 | 原子更新，删除不删岗位 |
| queries.save/delete | ID、方向、expression、enabled | ID 稳定；运行快照不变 |
| drafts.get/save | draft_kind、内容 | 持久草稿；不得覆盖正式设置 |
| drafts.generate | kind=search/rubric、用户文本／条件 | operation_id；异步生成草稿 |
| drafts.apply | draft_id | 应用编辑后的已验证草稿 |
| model.test | 当前或待保存连接的非敏感字段 | operation_id，最小文本请求 |
| jobs.list/detail | FilterSpec / job_id | 分页摘要 / 详情 |
| applications.add | job_id | added 或 already_present |
| applications.add_many | job_ids[]（去重后最多 200） | 每个 ID 的 added/already_present/not_found 及计数；已有状态备注不变 |
| applications.update | job_id、status?、notes? | 更新后管理信息 |
| applications.set_status | job_ids[]（去重后最多 200）、status | 每个 ID 的 updated/not_found、修改前的 status 与 updated_at 及计数；单次短事务，只改 status 与 updated_at，不改 notes |
| applications.remove | job_ids[] | removed_count 及被移出记录的 job_id、status、notes、added_at、updated_at；仅移出清单 |
| applications.restore | items[]（job_id、status、notes?、added_at?、updated_at，最多 200） | 每项 restored/not_found 及计数；单次短事务。清单中没有该岗位时按给定字段重新插入；已存在时只把 status、updated_at 改回给定值，不改 notes |
| jobs.score | job_ids[]（去重后最多 200）或 filter（FilterSpec）二选一 | {run_id, job_count}；创建时解析并固定岗位集合，建立 kind=rescore 运行；无模型配置或评分模板返回 VALIDATION_ERROR，已有运行返回 BUSY；两个池子都可调用 |
| runs.preview | direction_ids?（省略或 null=全部） | 所选搜索的任务数量、各平台目标和参数，不访问网络 |
| runs.start | direction_ids?、schedule_id?、firing_id? | run_id；无有效配置、所选搜索无可运行任务或已有运行时失败；记录触发来源 |
| runs.resume | run_id | 同一 run_id；沿用快照，新增本次尝试预算 |
| runs.stop | run_id | 请求停止，最终状态通过事件/查询获取 |
| runs.list/detail | 分页、可选 kind / run_id | 状态、计数、任务诊断及 still-existing job 关系；list 返回 started_at 与 new_job_count（is_new=1 且岗位仍存在）供批次下拉 |
| operations.cancel | operation_id | 取消连接测试或 AI 生成 |
| export.csv | scope、filter、range=filtered/all、include_jd、destination_token | operation_id；一岗位一行 |
| cleanup.preview | mode=manual/automatic | 将删岗位/运行数、保留清单数 |
| cleanup.execute | mode=manual | 忙时 BUSY；完成返回删除数 |
| schedules.list | 无 | 计划（含 next_at）及其 waiting／not_run／最近触发记录 |
| schedules.save/delete | id?、enabled、direction_ids、time、weekdays、timezone；或 id | 新建或更新（最多 10 个）／删除计划；不启动运行，删除时一并删除其触发记录，不删运行 |
| schedules.trigger | schedule_id、scheduled_at | main 专用；原子记账，空闲则开始运行，忙时记 waiting |
| schedules.record_missed | schedule_id、scheduled_at、reason、missed_count | main 专用；记 not_run 并合并同计划旧记录 |
| firings.cancel/delete | firing_id | 取消 waiting／删除 not_run |

credentials.set/delete 是 Electron main 的本地方法，不写 SQLite；保存后通过私有控制消息更新 service 内存中的秘密。普通 settings.save 不能意外清除旧 Key。settings.get/save 包含 retention_days（非负整数，默认 14；0 关闭自动清理）；空值、负数及非整数返回 VALIDATION_ERROR。该值统一控制岗位、运行记录、计划触发记录和日志自动留存，下一次清理检查生效。菜单栏图标开关 show_menu_bar_icon（默认 true）保存在 Electron 本机 UI 偏好，由 main 读取，不经 service、不写 SQLite。各页筛选记忆、列宽、显示的列、侧边栏折叠状态、详情抽屉宽度以及外观模式、浅色主题和深色主题同样只存本机 UI 偏好，由前端读写，没有对应的 service 命令。单主窗口的配置保存按顺序发送，只更新本次编辑字段；不使用配置版本锁。设置页能先测试未保存输入，测试失败不丢失输入。

destination_token 来自 main 保存对话框，main 解析成受信路径交给 service；renderer 不自行提供任意系统写路径。打开申请链接由 main 独立处理，不经 Python。

事件至少包含 ready、run.updated、run.stats、jobs.changed、operation.completed、operation.failed、cleanup.completed。UI 接到变更后按需重新查询；不要把事件当唯一持久数据源。run.stats 至少包含 retrieval/scoring 两组计数（total、succeeded、failed、active、pending、cancelled），total 为当前已登记任务数，评分 total 可随新岗位入库增长。进度分别展示抓取与评分，不将 stage 当互斥阶段或估算整体百分比。stage 为按当前任务/操作推导的展示字段，不存入 runs；retrieving 期间也可评分。每批入库和评分提交后发送 jobs.changed，抓取完成但评分未结束时 run 仍为 running。

settings.get/save 的配置包含 auto_score_enabled（boolean，默认 true）；runs.detail 返回其运行快照值。jobs 返回 score_state=unscored 表示未排队的未评分岗位，不能显示为评分中或失败。自动评分关闭的 pipeline，其 scoring 计数均为 0，UI 显示「本轮自动评分已关闭」。jobs.score 允许无旧分数岗位首次评分，Score 按钮不区分评分与重评模式。评分模板为空时 auto_score_enabled 只能为 false：settings.save 将其设为 true 返回 VALIDATION_ERROR；引导跳过评分模板时保存为 false。保存评分模板不会自动把它改为 true。

## 4. 模型协议配置

只实现 Custom，协议枚举 `chat_completions/responses/anthropic_messages/gemini_generate_content`。Base URL 必填并包含版本路径，去掉尾部斜杠后拼后缀。页面展示最终 endpoint 预览；不探测提供商或自动修复地址。

| 协议 | 示例 Base URL | 追加后缀 | Key 头 |
| --- | --- | --- | --- |
| Chat Completions | https://api.openai.com/v1 | /chat/completions | Authorization: Bearer |
| Responses | https://api.openai.com/v1 | /responses | Authorization: Bearer |
| Anthropic Messages | https://api.anthropic.com/v1 | /messages | x-api-key；另带 anthropic-version |
| Gemini | https://generativelanguage.googleapis.com/v1beta | /models/{model}:generateContent | x-goog-api-key |

model_id 填模型标识；Gemini 不重复填写 models/ 前缀。保留用户 Base URL 的已有路径，不使用会把版本路径覆盖的 URL join。允许 localhost HTTP 开发端点；非本地服务建议 HTTPS，不自动改写协议。

请求与文本响应：

| 协议 | 请求主体核心 | 文本提取 |
| --- | --- | --- |
| Chat | model、messages、stream=false | choices[0].message.content |
| Responses | model、input、stream=false | output 中 message 的 output_text 内容，不假设 REST 存在 SDK 的 output_text helper |
| Anthropic | model、messages、system（需要时）、max_tokens | content 中 type=text 的 text |
| Gemini | contents[].parts[].text、systemInstruction（需要时） | candidates[0].content.parts 中非 thought 文本 |

只实现非流式文本生成，不开放 tools、多模态文件、服务端会话或模型列表。截断、拒绝、空候选和错误对象都转换为明确失败，不从 reasoning 内容提取评分。评分在协议层得到文本后统一校验整数 0..10 与字符串 reason。

## 5. 留空不发送与必填协议字段

可选参数使用 null 表示未填写；数字 0 是填写值，不能通过 truthy 判断漏发。只按协议映射，不根据模型 ID 修改或过滤：

| 可选字段 | Chat | Responses | Anthropic | Gemini |
| --- | --- | --- | --- | --- |
| temperature | temperature | temperature | temperature | generationConfig.temperature |
| 输出上限 | max_completion_tokens | max_output_tokens | max_tokens（协议必填） | generationConfig.maxOutputTokens |
| 推理／思考 | reasoning_effort 文本 | reasoning.effort 文本 | thinking JSON 对象 | generationConfig.thinkingConfig JSON 对象 |

Anthropic max_tokens 是请求必填参数，界面标为必填；空值在本地提示补填，不偷偷补默认。其他协议的输出上限留空就省略。首版 thinking 采用小型 JSON 对象输入，给协议示例并只做语法／对象类型校验，不做模型适配；不建设任意 HTTP 请求编辑器。

Anthropic 版本头可预填 2023-06-01 并允许修改。这是协议版本参数，不是 provider 预设。标准协议未覆盖的提供商私有 reasoning 参数留待未来 provider 功能，不复制私人 pipeline 的域名判断。

官方协议参考（实现时核对字段，不据此扩大功能）：

- [OpenAI Chat/Responses 差异](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)
- [Gemini generateContent](https://ai.google.dev/api/generate-content)

## 6. 草稿与评分结果格式

search draft 返回 `{directions:[{name,queries:[{expression,enabled}]}],cities:[{location,distance_miles,enabled}],clarification?:string}`。生成默认一个方向、2～3 query；信息不足可以给一轮简短追问。业务校验不允许空表达式，应用时创建稳定 ID，不让模型指定数据库 ID。

rubric draft 返回 Markdown 字符串。用户只粘贴简历文本及少量明确条件；模型不能推断身份。输出评分 JSON 的格式要求由调用层附加，不要求用户维护格式指令。AI 输入/输出均不直接当 SQL、文件路径或命令执行。

所有模型调用使用同一全局并发/RPM 调度器。网络错误、408、429、5xx 和无效生成按有限次数重试；认证及其他明确 4xx 直接报错，不无限重试。Retry-After 可影响等待时间，但不突破用户停止信号。

## M1 第 2 步实施补充（2026-10-19）

本节将前述目录具体化；M0 接口说明为历史记录。schema_version 升为 2。本步不含 renderer 接入。

- `jobs.list` 直接接收 FilterSpec 加 `sort/page/page_size`，默认 scope=discover；`jobs.detail {job_id}` 返回 JobDetail。Summary 另含 date_posted、salary、sources、application，支持列表可选列；只有 detail 返回 description、links、queries、score_model、last_score_error。date_posted 存来源 ISO 日期（YYYY-MM-DD），范围按该精度比较；其他 *_at 为 UTC 毫秒，from 包含、to 不包含。用户于 2026-10-19 明确确认：run_ids 非空在 M1 返回 VALIDATION_ERROR（运行表/批次接入属于 M2）；M2 补齐该维度，不建空运行表。
- `settings.get {}` 返回 `{retention_days,directions:[{id,name,enabled,sort_order,queries:[{id,direction_id,expression,enabled}]}]}`；`settings.save {retention_days}` 仅实现 M1 留存设置。保存不触发清理。
- `directions.save {id?,name?,enabled?}` 新建时 name 必填；省略 ID 由服务生成 UUID，带 ID 必须存在。`directions.delete {id}`；`directions.reorder {ids}` 必须包含全部现有方向且无重复。`queries.save {id?,direction_id?,expression?,enabled?}` / `queries.delete {id}` 同样使用稳定 ID。更新 query 不迁移所属方向。
- `applications.add {job_id}` 返回 `{job_id,outcome}`；批量返回 `{items:[{job_id,outcome}],counts:{added,already_present,not_found}}`。update 返回 application 字段。set_status 返回 items（updated 项含修改前 job_id/status/updated_at）和 counts。remove 返回 `{items:[完整原管理记录],removed_count,not_found:[job_id]}`。restore 返回 items 和 counts；记录缺失但 job 存在时，只有包含 notes/added_at 的完整移出快照可插入，状态撤销快照缺少这些字段则 not_found，不复活已被主动移出的记录。所有批量命令去重后最多 200 项，restore 的重复 ID 拒绝；参数无效整批拒绝，失效 ID 逐项 not_found。
- `cleanup.preview {mode}` 返回 `{jobs,runs:0,applications,files,disabled}`；`cleanup.execute {mode:"manual"}` 返回 `{deleted_jobs,deleted_runs:0,deleted_files,failed_files}`。本步未建立 runs/schedule_firings，相关删除数为 0；M2/M7 建表时接入。文件失败在成功数据库提交后报告 failed_files（受控相对路径），不能显示全部成功。只清理 App 自有 logs/tmp 内普通文件/目录，不跟随符号链接，绝不触碰导出或外部目录。
- 自动清理在 ready 前及运行中每 60 秒检查；单接收循环串行写库，使用可注入毫秒时钟，当前有 export operation 时延后。retention_days=0 跳过全部自动过期清理；启动 tmp 清理独立于留存。手动清理忙时 BUSY。未来运行/AI operation 必须共用此互斥入口。
- `export.csv` 的 renderer 输入为 `{scope,filter?,range,include_jd,destination_token}`，filter 不含分页，可含 sort；scope 与 filter.scope 必须一致。`chooseCsvDestination()` 在 main 打开原生保存面板，返回 `{destination_token}` 或 null；token 只保存在 main 内存，用一次即消费；保存目标不能位于 App 数据目录中，避免覆盖数据库或被 App 清理；`showCsvInFinder({destination_token})` 仅接受本会话成功导出的 token。main 将 token 解析为私有 service 参数 `destination_path`，不会把 renderer 路径透传。返回 `{operation_id}`，独立只读连接在线程中流式导出全部匹配行，不阻塞查询/清单写操作，完成发送 operation.completed `{operation_id,row_count}` 或 operation.failed `{operation_id,error}`。只允许一个 export operation；app.status.operations 返回其 ID。事件也通过具名 onServiceEvent 转发；关闭 renderer 不取消导出。失败可能留下部分 CSV，明确报错，不新增恢复状态或备用文件。
- `dev.import_synthetic {count?}`（默认 125，1..1000）只在显式 `--enable-dev-commands` 的非 frozen service 可用；开发 Electron 开启该标志，打包版拒绝。生成稳定合成岗位、两方向/query、多来源、空分/0 分和长 JD；重复导入合并集合，不覆盖正文、首次发现、评分或清单。此入口不是 M2 抓取/去重实现，不读取任何私人数据。
- 本步业务提交发送 jobs.changed / cleanup.completed；event seq 在同一 service 单调递增，ready 始终为 1。export 以外命令短事务同步返回，协议未增加通用执行入口。

### M1 修复约定：实际导出路径与响应上限（2026-10-19）

- CSV 数据目录保护基于实际解析路径：main 发放 token 和执行 export 前检查实际数据目录与目标；已有文件解析目标，新文件解析父目录；无法解析时明确拒绝。token 保存解析后的路径。Python 在实际打开导出目标前再次解析并拒绝数据目录内路径，禁止先截断后检查。文件/父目录符号链接均适用。
- 1 MiB 上限按与实际输出一致的 JSON 序列化字节数计算（不含 LF）。正常响应过大时，服务在输出任何字节前改为同 request id 的 `RESPONSE_TOO_LARGE` 错误，建议减少每页条数或批量选择；不截断备注、不隐式缩小页、不提高上限，连接继续可用。Electron 对真正超大/损坏协议消息的保护保留。
- applications.remove 的完整 Undo 快照，以及 applications.update 返回的完整管理记录，在事务提交前检查成功响应大小，超限则回滚本次修改；remove 不会已经移出却丢失 Undo。已成功提交的其他变更不会因输出大小检查而自动重放或逆向补偿。长 JD/detail 及其他查询同样受到响应输出上限保护。

## M1 第 3 步界面接入（2026-10-19）

- preload 新增具名方法 `openLink(url)`：只接受 http/https，由 main 校验发送方后调用系统浏览器打开（申请链接、JD 内链接），其他协议拒绝；不经 Python，不暴露任意 URL scheme、路径或命令。
- renderer 本机 UI 偏好 `jobVaccum.ui` 增加 `lists.jobs` / `lists.shortlist`：各页的筛选（相对时间范围保存为天数，自定义范围保存为本地日期，请求时换算为 UTC 毫秒半开区间或 YYYY-MM-DD）、排序、每页条数、显示的列和列宽。读取时逐项校验，非法或失效值回到默认；页码与勾选只在会话内。已删除方向的筛选在读取方向列表后移除并提示。
- 侧边栏计数用 `jobs.list` 的 `total`（page_size=1）：发现页全部、清单全部、每个方向的发现页数量；不新增计数命令。
- renderer 对本窗口发出的、成功后会产生 jobs.changed 的命令计数，对应事件只触发两页静默刷新；其余 jobs.changed（自动清理等）显示「Results updated · Refresh」，不自动重排当前列表。
- JD 用 markdown-it（html: false，禁用图片）渲染；新增运行依赖 markdown-it 14.3.2（package-lock 锁定）。

## M2 后端与桌面桥接（2026-10-19）

本节是下一步 renderer 的接入契约，覆盖 M1 同名接口的阶段限制。schema_version=3，protocol_version=1。renderer 本步不改。

- `settings.get {}` / `settings.save {本次修改字段}`：保留 retention_days、directions；增加 cities（`[{id,location,distance_miles,enabled}]`，新城市省略 id，服务生成，更新保留 ID）、country_indeed（默认 usa）、platforms（默认 linkedin/indeed）、auto_score_enabled（默认 true）、rubric（默认空）、model（null 或 `{protocol,base_url,model_id,temperature?,max_output_tokens?,reasoning_effort?,thinking?,anthropic_version?}`）、rules（见下）、proxy（`{mode:"off"|"ordinary",url:null|无认证代理地址}`）。返回另含 `has_key:false,has_proxy_credentials:boolean`。本步只存模型无秘密配置，不调用模型。保存只更新提供的顶层字段，接收循环按请求顺序提交；嵌套对象/数组整体替换。仅显式开启 auto_score_enabled 或清空已开启的 rubric 时检查模板；空库默认 true 但未配置，start 必须补 rubric/model 或关闭自动评分。run.preview 同样校验。
- 默认运行参数固定：linkedin 10、indeed 100、hours_old 72、单抓取并发、600 秒整任务尝试超时、最多 3 次、退避 5/10 秒；不开放高级模式字段。snapshot 保存这些值及 jobspy_commit、正式配置、方向/query 和城市全部字段，不含 has_* 或秘密；启用的 query ID、城市 ID、平台名排序确定任务顺序。
- rules：`{enabled_rule_ids:[],experience_max_years:3,excluded_companies:[],qualifications:{}}`。可选规则 ID 为 `test_jobs,senior_title,experience,authorization,language,graduation,degree`；空记录（缺标题或 JD）和明确兼职始终筛除，公司排除始终按规范化名称精确匹配。qualifications 可含 `requires_sponsorship:boolean,work_authorization:"opt"|"unrestricted",languages:string[],graduation_date:YYYY-MM-DD,degrees:string[]`，仅在明确条件与岗位明确要求冲突时过滤。专业排除本步不启用；不推断任何私人身份。经验只判明确 required/minimum/at least 或 N+ 年，不筛 preferred；学历 OR 分支按用户学历可满足的最小年数判。未核实的旧规则不声称兼容，原项目不可访问记录在 DEVELOPMENT-STATUS。
- `drafts.get {draft_kind:"search"|"rubric"}` 返回 `{draft_kind,content:null|SearchDraft|string}`；`drafts.save {draft_kind,content}` 返回同结构；search content=`{directions:[{name,queries:[{expression,enabled}]}],cities:[{location,distance_miles,enabled}]}`，rubric 为 Markdown 字符串。验证后按 `draft:search` / `draft:rubric` 存 settings，不写正式配置。`drafts.apply {draft_kind}` 应用已存草稿，search 替换方向/query/城市并生成新稳定 ID，按删除方向语义去掉旧标签；rubric 只改模板，不开启评分。生成草稿留 M5。
- `runs.preview {direction_ids?}` 返回 `{task_count,parameters,auto_score_enabled}`；parameters 是上述固定参数。`runs.start {direction_ids?,schedule_id?,firing_id?}` 返回 `{run_id}`；direction_ids 省略或 null 为全部启用搜索；非空数组中未知/已删除 ID 忽略，空数组或剩余为空返回 VALIDATION_ERROR；快照保存所选方向，runs.trigger_json 记录 `{source:"manual"|"schedule",schedule_id?,firing_id?}`，立即返回后逐任务异步执行；无启用 query/城市/平台、普通代理缺地址或评分配置不全返回 VALIDATION_ERROR，已有活跃 run 返回 BUSY。
- `runs.list {page?:1,page_size?:50(1..200),kind?:"pipeline"|"rescore"}` 返回 `{items:[RunSummary],total}`，默认仅 pipeline（供批次下拉，排除 rescore），created_at DESC,id ASC。RunSummary=`{id,kind,status,created_at,started_at,finished_at,new_job_count,stats,error,stage,searches,trigger}`，searches 为 null（全部）或快照中的 `[{id,name}]`，trigger 同 trigger_json，new_job_count 仅计仍存在的 run_jobs.is_new=1；stats 持久化当时统计，不因清理回写。`stage` 动态推导 retrieving/scoring/cleaning，结束为 null。
- `runs.detail {run_id,task_page?:1,task_page_size?:50(1..200)}`（Runs 页不分页显示任务，前端取回全部页后在表内滚动） 返回 RunSummary 加 `{config_snapshot,tasks:[{id,kind,stable_order,spec,status,attempt_count,stats,error}],task_total,jobs:[{job_id,is_new}]}`；jobs 仅仍存在关系。task 列表分页，jobs 最多 200，完整结果用 jobs.list 的 run_ids 查询。stats=`{retrieval,scoring,received_count,filtered_count,matched_job_count,new_job_count,directions:[{direction_id,name,received_count,filtered_count,matched_job_count}]}`，任务计数各含 total/succeeded/failed/active/pending/cancelled。任务 stats 含 received_count、filtered_count、filter_reasons、matched_job_count、missing_jd_count、warnings、http_requests/http_429、identity_conflicts。
- `runs.stop {run_id}` 返回 `{run_id}`，停止派发和退避，最多等抓取进程 10 秒再结束；未提交结果丢弃。`runs.resume {run_id}` 返回同 ID，仅允许 stopped/interrupted/partial/failed，成功任务不重做；原快照和任务 ID/order 不变，失败任务获得新的三次预算，统计替换、attempt_count 累计。M2 已登记评分任务保留 pending；开启评分且有新岗时 run 保持 running/scoring，实际评分执行随 M3 交付，不能写成成功。
- 事件：`run.updated {run_id,status,stage}`、`run.stats {run_id,...stats}`，在 start/resume/stop、任务开始/提交、运行状态改变后发送；每次批次事务提交且存在岗位命中时发送 `jobs.changed {}`。UI 按事件重新查询，不解析日志；启动和恢复响应先于其事件。`app.status.active_run` 为 null 或 `{run_id,status,stage}`，configuration_complete 按当前正式配置能否 preview 判定。
- `FilterSpec.run_ids` 空数组等同不按批次筛选；非空仅匹配 `run_jobs.is_new=1`，rescore ID 拒绝；已删除/未知运行 ID 返回空结果，前端通过 runs.list 清除失效条件。导出复用同一筛选。
- cleanup.preview/execute 的 runs/deleted_runs 接入真实运行数；自动按 created_at 严格早于 cutoff，0 禁用。运行中手动清理 BUSY、自动延后；删除 run 仅级联任务/关系，不删存活岗位的来源/query/方向。重启将旧 running/stopping run 标 interrupted，running task 回 pending。
- preload 具名方法：`getDraft/saveDraft/applyDraft/previewRun/startRun/listRuns/getRunDetail/stopRun/resumeRun`；原 saveSettings 接收部分配置。普通代理认证使用 main 本地 `setProxyCredential({url})` / `deleteProxyCredential()`：safeStorage 加密 App 数据目录 credentials 文件，拒绝加密不可用，不回显明文；启动和 start/resume 前 main 私有 `internal.credentials {proxy_url:string|null}` 注入 service 内存，公开桥接不暴露该 method。settings.proxy.url 只允许 http/https/socks5 的无认证 origin（无 path/query/fragment），凭据 endpoint 必须与运行快照一致；off 忽略凭据且明确不使用环境代理。set 仅存凭据，不修改正式 proxy 设置。凭据错误不回显 URL 或密码；resume 可修正同 endpoint 的凭据。
- fake scraper 仅通过 Python 测试依赖注入，覆盖成功/空/部分/失败/延迟，不增加 renderer 切换真实与模拟抓取的产品入口。

M2 事件细化：`run.stats` 发送 run_id、retrieval、scoring 和四个全局业务计数，不携带方向数组；方向明细由收到事件后的 runs.detail/list 查询获取。这样事件大小不随方向数增长。任务 stats 的 matched_job_ids 仅保存去重后岗位 ID，供各方向唯一计数，不复制岗位内容。评分 spec 仅 `{job_id}`，评分输入从 jobs 主体及该 run 快照读取，不在任务内复制 JD。运行开始/续跑时解析普通代理凭据并只保存在当前运行内存，运行期间编辑代理设置/凭据只影响下一次 start/resume；续跑可使用同 endpoint 的修正凭据。

运行计划（M7）：`schedules.list {}` 返回 `{items:[{id,enabled,direction_ids（null=全部）,time,weekdays,timezone,next_at}],firings:[{id,schedule_id,scheduled_at,outcome,reason,missed_count,run_id}]}`，firings 含全部 waiting、各计划最近一条 not_run 及每个计划最近 5 条 started。`schedules.save` 校验 HH:mm、weekdays 为 0–6 去重数组、direction_ids 为现有方向、总数不超过 10，超出返回 VALIDATION_ERROR；附近有其他计划只在界面提示，不拒绝。只跑一次的计划被触发后由 service 设 enabled=false。删除方向时从各计划移除该 ID，计划无剩余方向则设 enabled=false。等待开始、取消、未运行记录和计划变化时发送 `schedules.updated {}`，UI 收到后重新查询。

任务重跑的 received/filtered/matched 等本次聚合计数替换旧值；matched_job_ids 表示该任务历次已提交的命中关系并取并集，用于不丢失部分失败后已入库的方向命中。停止时未提交的内存结果丢弃，保留该任务此前已提交统计/命中关系。

内容阶段的不同有效外链边界比较代表字段及全部已补来源中的 direct_url；代表先入库时无外链，不代表后来补入的来源外链可被忽略。该比较不修改代表字段，也不反向恢复前面跨平台公司标题阶段已合并的记录。

## M3 后端、协议与桌面桥接（2026-10-19）

本节覆盖 M2「只登记评分任务」的限制；schema_version=3、protocol_version=1 不变。只实现 Python、shared 类型、main/preload 及测试，不修改 renderer；Custom 页面、rubric 编辑和 Score 菜单由界面工作接入现有 settings 与下列具名 API。AI 草稿生成仍属 M5，不提前开放 drafts.generate。

### 新增公开方法

| Python 命令 | preload 方法 / 参数 | 返回与事件 |
| --- | --- | --- |
| `jobs.score` | `scoreJobs({job_ids})` 或 `scoreJobs({filter})`，严格二选一 | `{run_id,job_count}`，kind=rescore；后续 run.updated/run.stats/jobs.changed |
| `model.test` | `testModel({model?})`，默认 `{}` 使用正式配置；传 model 测试完整未保存连接配置 | `{operation_id}`；成功 `model.test.completed {operation_id,connected:true}`，失败 `operation.failed {operation_id,error}` |
| `operations.cancel` | `cancelOperation({operation_id})` | `{operation_id}`；M3 仅取消连接测试，最终 operation.failed/CANCELLED |
| 无（main 本地） | `setModelKey({key:string})` / `deleteModelKey()` | `{has_key:boolean}`；不回显 Key，不更新正式模型设置 |

`model.test.completed` 是 M3 新增的独立成功事件，避免现有 renderer 把模型测试当 CSV 导出完成（原 operation.completed 仍返回 row_count）。所有事件使用已有统一封装与会话递增 seq。接受响应先于对应事件。连接测试的输出文本不回传、不保存；模型输出只有有效非空最终文本才算连接成功。测试失败不修改设置、rubric 或草稿。

settings.get/save 的 has_key 改为实际内存凭据状态。`internal.credentials` 私有消息接受 `{proxy_url?:string|null,model_key?:string|null}`，省略字段保留、null 只删除该凭据；至少一个字段。main 在读取 settings、preview/start/resume、jobs.score、model.test 前从 App 目录 `model-key.enc` 解密注入；保存/删除时立即更新内存。文件使用 safeStorage、0600 权限；加密/解密不可用明确报告 AUTH_ERROR，不明文保存。renderer 不能调用 internal.credentials。运行开始时捕获 Key，期间修改仅影响下次 start/resume/test；resume 可修正 Key，仍沿用原模型和 rubric 快照。

M3 审阅修正：`setModelKey` 拒绝空白或含 CR/LF 的输入，合法单行 Key 在加密保存前去除首尾空白。读取/解密失败时保留原加密文件、通过私有消息清除后端当前模型 Key，不清除已经启动运行捕获的 Key。`getSettings()` 仍成功返回非敏感配置，`has_key=false`，另含可选 `model_key_error:ApiError`（由 main 附加，消息受控且无秘密），供设置页展示 Keychain 错误和重设/删除 Key 的处理办法；读成功或删除后省略该字段。该错误不阻断无需模型的 preview/start/resume；是否需要 Key 由 service 使用正式配置或原运行快照判断。需要 Key 的评分返回 AUTH_ERROR，模型/rubric 等非凭据配置缺失仍为 VALIDATION_ERROR。`jobs.score`、`model.test` 在凭据不可读时保持受控拒绝，不绕过加密、不静默吞错。

### 手动评分与运行

- job_ids 去重后 1..200；有失效岗位时整次返回 NOT_FOUND，提示刷新，不创建部分运行。filter 使用 FilterSpec（可含 sort，不接受分页），与列表/导出复用同一筛选；创建时一次解析全部匹配岗位，之后新增/移出清单不改变固定集合。零匹配返回 VALIDATION_ERROR。前端的 Score all N matching 需先展示确认数量，再提交 filter；job_count 是服务创建时的实际数量。
- 手动评分只要求当前 model、已保存 Key、非空 rubric，不要求 query/城市，也不使用抓取代理；不受 auto_score_enabled 影响。缺配置返回 VALIDATION_ERROR，任何 pipeline/rescore 活跃（含 stopping）返回 BUSY。清理等待运行和连接测试结束；浏览、清单编辑、CSV 不等待网络。
- 新任务与岗位 pending 原子登记，旧成功分数保留；实际请求开始转 running，每次请求（含重试）增加 attempt_count。成功事务只更新 jobs 的 score/reason/scored_at/score_model/state/error 和对应任务/统计；失败只写 failed、last_score_error（可读脱敏文本）和任务 error，不改旧成功分与时间、正文或清单。0 分是 succeeded。
- 新批次入库后立即排队评分，与后续抓取重叠；本轮每 job 一个任务，输入仅 title/company/description 加运行 rubric。不同 job 即使输入完全相同也独立请求，不缓存、不共享结果；后续来源/方向命中不重评。抓取结束后仍等待评分，提交后发送 jobs.changed 和 run 事件。
- stop 立即停止后续派发与重试，可打断 RPM/退避；已发请求继续占用全局并发直至结束，成功评分照常保存，再转 stopped。未开始任务 cancelled，未完成岗位保留 pending 供续跑。resume 跳过 succeeded，其他任务获得新的三次尝试预算；启动将旧 running 任务转 pending，保留旧成功分。崩溃/退出故障验证入口见 ACCEPTANCE 的 M4 后端验证边界。
- 自动清理可能删除 stopped/interrupted 运行中的旧岗位，但保留较新的运行和任务。续跑派发时，岗位已不存在的任务记 failed，error.code=NOT_FOUND、retryable=false，不发模型请求、不增加 attempt_count、不恢复岗位；继续其他任务并按实际结果结束运行。缺失任务仍保留在运行详情，全部岗位已删时运行可正常结束为 failed，混合存活岗位时为 partial。
- worker 在通知接收循环等阻塞返回后、发送 transport 前再次检查取消信号；未发请求以 CANCELLED 结算，任务最终 attempt_count 只计实际 transport 调用，保留此前累计尝试数。已经发出的请求仍按原停止语义保存成功结果。

M4 退出补充：不新增 shutdown 协议命令。EOF 与 SIGTERM 均进入正常停止流程，继续接收在途评分结果并提交；CLI 同时启动 10 秒退出期限，超时结束本进程创建的 multiprocessing 子进程并强制退出，不等待 ThreadPoolExecutor 的解释器退出 join。该期限也覆盖 Electron 意外退出造成的 EOF/输出管道断开；Electron 原有 10 秒等待、SIGTERM、1 秒后 SIGKILL 的进程组停止保持。强制退出不伪造 stopped/succeeded，下一次持锁启动标 interrupted；正常 Stop 不受 Quit 时限影响。正常退出在抓取子进程结束后清空 App tmp，强制退出遗留 tmp 由下次启动清理。抓取线程在开始通知阻塞返回后同样复查停止信号，最终 attempt_count 不计未发起的抓取。

### HTTP 与限速

四协议 endpoint、参数映射和最终文本提取遵循本文件第 4–6 节；仅 requests 直接 HTTP，无 SDK、提供商推断或模型名分支。Base URL 原路径保留、去尾斜杠再拼后缀，不跟随重定向；Gemini model_id 不接受 models/ 前缀。Anthropic max_output_tokens 必填，本地保存/测试即校验；版本头缺省 2023-06-01。其他可选字段 null 不发，temperature=0 发送。

全 service 共用 LLM 线程池，并发 1、RPM 10、起始间隔至少 6 秒（空闲后不累积突发额度）。连接测试、首次评分、手动评分、每次重试均经过同一门；后续 M5 生成也必须使用该池。连接/读取超时 10/120 秒，读取超时不是总时限。最多 3 次尝试，基础退避 5/10 秒，Retry-After 秒数可延长等待且能取消；网络异常、408/429/5xx、无效文本或评分 JSON 可重试，401/403 和其他明确 HTTP 错误不重试。错误只包含受控消息/code/retryable，HTTP 错误另含 http_status，不持久化或回显 provider 响应/网络异常全文、认证头或秘密。截断、拒绝、空候选、畸形响应及非整数 0..10 / 非字符串 reason 都失败，不从 reasoning/thought 提取评分。

fake LLM 仅 Python 测试依赖注入，支持成功（含 0 分）、无效输出、失败和延迟；四协议使用本地假 HTTP server 验证。未新增真实服务或模拟模式的产品开关。

## M2 收尾：预置城市与规则统计（2026-10-19）

- 未保存 cities 配置时返回用户指定的 19 个美国城市，顺序和半径固定、全部 enabled=true，预置 ID 跨读取/重启稳定。Philadelphia 按本轮约定为 25 miles。已保存的城市配置（包括空数组）不覆盖；settings.save 后继续按原有城市编辑契约处理。
- RunSummary.stats、RunDetail.stats 与 run.stats 事件增加 filter_reasons（规则 ID → 数量），从本轮全部 retrieval 任务的当前统计求和，不受 tasks 分页影响。续跑替换任务统计后重新汇总，不累计旧尝试；历史运行尚无该字段时，list/detail 从仍保存的任务计数聚合。Runs 详情显示 Filtered by rule，无筛除时显示空状态，不保存被筛岗位正文。

## M3 renderer 接入（2026-10-19）

- 不新增命令、事件或 preload 方法。Settings 新增 Model 分区：settings.save 只提交 model 对象（空值为 null、仅当前协议相关字段非 null），Key 走 setModelKey/deleteModelKey；testModel 传入表单当前完整 model，等待 model.test.completed 或 operation.failed，离开分区时 cancelOperation。
- 两页工具栏 Score 菜单与详情 Score 调用 scoreJobs：勾选为 job_ids，Score all 为当前 FilterSpec（含 sort，无分页），先显示确认：总数为该 FilterSpec 的 jobs.list total，已有分数数为同一 FilterSpec 加 `score_min:0` 的 total（含重评失败保留旧分者），未评分数为二者之差；不新增命令。缺 model、has_key=false、存在 model_key_error、rubric 为空或 app.status.active_run 非空时前端禁用并说明原因；服务端校验仍为准。
- Runs 历史同时读取 runs.list 默认（pipeline）与 kind=rescore，各最多 200 条，按 created_at 合并；批次筛选只用 pipeline。保存 rubric 后自动评分关闭时由前端询问，再显式 settings.save {auto_score_enabled:true}。

## M2 Runs 修正落地（2026-10-20）

- 迁移 004 给 runs 增加可空 trigger_json；schema_version=4，protocol_version=1 不变。旧运行 trigger 为 null，界面按 Manual 显示。
- runs.preview/start 接受 direction_ids（省略或 null=全部启用搜索；非数组返回 VALIDATION_ERROR；未知 ID 忽略，空数组或剩余为空返回 VALIDATION_ERROR；所选搜索没有启用 query 时返回 VALIDATION_ERROR）。快照写入 direction_ids（null 或所选 ID）；只为所选且启用的方向生成任务。
- M3 初始阶段 runs.start 与 jobs.score 都写 trigger_json `{source:"manual"}`；M7 已补齐 schedule_id/firing_id 和自动触发 source=schedule，具体语义见下节。
- RunSummary 增加 searches（null 或快照中的 `[{id,name}]`，名称取运行开始时的快照，方向删除后仍显示）与 trigger。preload 的 previewRun/startRun 接受可选 `{direction_ids}`。
- Runs 页 runs.detail 以 task_page_size=200 逐页取回全部任务（评分运行只取 1 条，不显示任务表）。


## M7：计划、时钟与桌面接口（schema 5）

- `schedules.save {id?,enabled,direction_ids,time,weekdays,timezone}` 返回 `{id}`，更新必须提供完整字段。weekdays 为 Monday=0 至 Sunday=6，重复值去重；time 严格 HH:mm，timezone 必须为 zoneinfo 可识别 IANA 名称。direction_ids 必须为现有方向的非空数组或 null；无效字段和超过十个计划返回 VALIDATION_ERROR，更新/删除不存在 ID 返回 NOT_FOUND。附近计划不拒绝。
- `schedules.list {}` 的 items 除原字段增加 created_at、updated_at、checked_at；next_at 是水位之后下一时刻，关闭计划为 null。运行中/等待计划置顶，其余按 time/id；firings 按 scheduled_at 倒序，包含全部 waiting、每计划一条 not_run 和最近五条 started，cancelled 不返回。Firing 增加 `missed_since:number|null`；run_id 在运行过期删除后为 null。
- `schedules.trigger {schedule_id,scheduled_at}` 与 `schedules.record_missed {schedule_id,scheduled_at,reason,missed_count,missed_since?}` **只给 main**，不进入 businessMethods/preload。成功返回 Firing，已存在的同一触发返回原记录；已删除/合并且早于检查水位的旧通知返回 `{ignored:true}`。拒绝未来时刻、非该计划的到点时刻及尚未记账的关闭计划。record_missed 合并旧未运行数量及最早时间；不创建 run。
- `internal.schedules_check {reason?:"asleep"|"app_closed"}` **只给 main**，返回 `{checked_at}`。省略 reason 为正常到点检查，传 reason 只记未运行。service 用同一 zoneinfo 算法计算范围、调用触发记账并推进水位；renderer 无法直接调用或注入时钟。
- `firings.cancel {firing_id}` 仅接受 waiting，返回 `{cancelled:true}`；`firings.delete {firing_id}` 仅接受 not_run，返回 `{deleted:true}`。错误状态返回 VALIDATION_ERROR，不存在返回 NOT_FOUND。删除计划返回 `{deleted:true}`，级联删除触发但保留运行与历史 trigger。
- `runs.start` 的 schedule_id 可用于计划内手动运行；direction_ids 可覆盖尚未保存的选择。带 firing_id 时只接受 not_run，若另传 schedule_id 必须匹配，不能再覆盖 direction_ids；成功后 firing 改 started。手动来源均为 manual；定时/等待启动为 schedule。忙时返回 BUSY，失败不消耗 not_run。任务尚未创建的 failed run 不能 resume，返回可操作的 VALIDATION_ERROR。
- `cleanup.preview` 增加 `firings`；`cleanup.execute`/cleanup.completed 增加 `deleted_firings`。waiting 不作为清理候选；0 保留期仍关闭自动清理；计划配置不删除。
- 计划保存/删除、等待开始、取消、未运行变化、删除搜索及触发记录清理发送 `schedules.updated {}`。run.updated/run.stats 继续用于自动启动的运行。
- preload 具名 API：listSchedules、saveSchedule、deleteSchedule、cancelFiring、deleteFiring；startRun 接受上述扩展。主进程本机偏好具名 API `getDesktopPreferences()` / `setDesktopPreferences({show_menu_bar_icon:boolean})` 返回该偏好，默认 true，保存在 userData/desktop-preferences.json；不写业务 settings。两者沿用受信任 sender 验证。Appearance 的开关及 Runs 计划编辑器由后续 renderer 阶段接入。
