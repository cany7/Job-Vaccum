# M8 / M9：本机 MCP 接入开发设计

本文记录 2026-10-23 用户确认的后续开发范围，是 SPEC 与 IMPLEMENTATION-PLAN 的补充契约。M8 完成岗位、Shortlist、计划和运行状态的接入；M9 开放搜索及全局配置编辑。实际实现进度和验证结果只在 [DEVELOPMENT-STATUS](DEVELOPMENT-STATUS.md) 维护。

## 1. 使用场景与阶段边界

Agent 可以筛选 Jobs / Discover 的岗位、批量加入 Shortlist、读取单岗位完整 JD，再由用户已有 Skills 执行投递，最后通过 MCP 更新 Shortlist 状态和备注。用户也可以经 MCP 直接记录在其他渠道投递的岗位。Agent 可以读取和修改已有计划，并查看正在进行或已经结束的运行。

| 阶段 | 范围 | 前置条件 |
| --- | --- | --- |
| M8 | 本机 MCP、岗位查询、Shortlist 写入与手动记录、Searches 只读、Schedules 读取/修改、运行预览、Runs 状态与进度、App 状态 | 已有岗位/配置业务接口与 M7 计划、后台生命周期可用 |
| M9 | 新增/修改 Searches 与 Queries，读取/修改既有全局抓取业务配置 | M8 接入及端到端验证完成 |

本阶段不负责 Skills 编写或修改、Google Sheets 同步、浏览器投递动作、自动申请材料生成、投递历史时间线或单独的投递日期字段。只使用当前状态、notes、added_at、updated_at；修改备注会更新 updated_at，它不是精确投递日期。

此次工具范围不包含启动/停止/恢复 Run、运行失败诊断、删除工具、新建/删除 Schedule、模型凭据管理或公开插件发布。后续增加这些能力需另行确认，不因底层已有命令而全部透出。

## 2. 接入与进程职责

```text
Codex / Claude / 其他 MCP 客户端
    → Electron main 中的本机 Streamable HTTP MCP 服务
    → 共用业务调用入口
    → 既有 JSON Lines 协议
    → 既有 Python service / repository
    → SQLite
```

- 第一版要求 App 运行，可关闭前端窗口并留在后台；显式 Quit 后 MCP 停止。沿用已有数据目录、单实例与 service 生命周期。
- Electron main 使用官方 TypeScript MCP SDK 实现协议适配。复用既有 Python service 的串行写入、事务、校验和错误返回，不新增第二个数据库写入者或独立守护进程。
- 把现有 main 业务调用中必要的凭据注入与请求逻辑提取为小的共用入口，供 IPC 和 MCP 使用；保留 IPC 的发送者校验。没有 renderer 时也能正常调用。
- 仅监听 loopback，使用本机访问 token，校验 Host/Origin；不监听公网或局域网地址，不引入账号系统和 OAuth。连接地址及 token 在本机配置，秘密不进入工具结果、日志、快照或 Git。
- 只有明确列出的 tools 可调用；不提供任意 SQL、任意 service method 或文件访问工具。查询标为只读，写入工具按真实行为声明。
- MCP 写入通过原业务路径提交后，沿用对应的业务事件，使已打开的界面正常刷新。不建立第二套缓存、同步数据库或事件历史。
- 提供 Codex / Claude 的 MCP 连接示例。工具描述用一两句话交代用途和必要限制；M8 不打包 Skills 或插件商店发布材料。

## 3. 命名与数据模型

前端 Jobs / Shortlist 与后端 `scope=discover/applications`、`applications.*`、`directions` 的现有命名关系保留。Searches 的 ID 就是 directions 的 ID；MCP 筛选和计划选择可直接使用读取到的 `direction_ids`。

- `jobs` 保存岗位内容，抓取岗位与手动岗位使用同一实体表。
- `applications` 保存 Shortlist 关系和 status、notes、added_at、updated_at；不是另一个岗位实体表。notes 只属于 Shortlist 记录。
- `schedules` 保存计划选择和时间规则；`runs` 是实际执行记录。waiting / not_run 属于计划触发记录，可能没有 run_id，不能伪造成一个 Run。
- “所有岗位/运行”指当前保留的数据；现有清理规则仍适用，不增加永久运行归档。

手动岗位只需给 jobs 增加一个明确的来源标记，例如 `origin=scraped/manual`，迁移时已有岗位标为 scraped。Jobs / Discover 排除手动来源，Shortlist 通过 applications 关系读取两类记录。其他既有字段和表继续复用，不拆成两张岗位表。

## 4. M8 工具契约

### 4.1 岗位与 Shortlist

| Tool | 输入与行为 | 返回 |
| --- | --- | --- |
| `list_jobs` | 既有 FilterSpec 的适用字段、sort、page/page_size、view；固定 discover 范围并排除手动岗位 | 一页岗位摘要或 IDs，以及匹配总数和分页信息 |
| `list_shortlist` | 同上，固定 applications 范围，支持状态及加入/更新时间筛选 | 一页 Shortlist 摘要或 IDs，以及匹配总数和分页信息 |
| `get_job` | job_id | 一个岗位的完整详情，含完整 JD、来源、链接、薪资、queries、方向、评分信息；存在 Shortlist 关系时包含管理字段 |
| `add_to_shortlist` | job_ids，去重后 1..200 个；复用 applications.add_many | 每个 ID 的 added / already_present / not_found 和计数 |
| `create_shortlist_job` | title 必填；company、location、job_type、description、job_url、job_url_direct、date_posted、status、notes 可选 | 新建岗位 ID 和 Shortlist 管理信息，不回传完整 JD |
| `update_shortlist_job` | job_id；可部分更新 status/notes；手动岗位还可更新上述岗位内容字段 | 岗位 ID 和更新后的管理信息，不回传整份岗位详情 |
| `set_shortlist_status` | job_ids，去重后 1..200 个，目标 status | 每项 updated / not_found 和计数，不返回整份岗位详情 |

状态沿用 `new/applied/oa/interviewing/offer/rejected/ghosted`，新建默认 new。省略字段保持原值；允许清空的可选内容沿用既有空值约定，title 不允许清空。工具不能修改 ID、来源标记、抓取时间或直接写入计算得到的评分。

筛选复用 [CONTRACTS](CONTRACTS.md) 的 FilterSpec：文本、direction_ids、来源、公司、地点、岗位类型、评分范围/状态、是否已加入清单、清单状态、首次发现/发布日期、加入/更新时间及薪资条件。数组内 OR、不同维度 AND，稳定排序以 job ID 作为最后排序键。文本匹配沿用当前 title/company/location 的行为，不新增 JD 语义搜索。

保留已有 run_ids 筛选语义（首次发现关系），但不为 MCP 新增专用 list_run_jobs 或“某次运行全部命中结果”的查询关系；用户主要通过日期筛选岗位。缺失来源、Search 或日期的手动记录不伪造这些信息，按正常空值规则筛选。

### 4.2 手动岗位与写入语义

- 使用独立的手动创建校验，不要求抓取记录的完整字段或完整 JD。初始评分为空、score_state=unscored，不自动创建评分任务。
- 同一事务创建 jobs 和 applications，使手动岗位直接进入 Shortlist，并受现有长期保留保护。不能只插 jobs 后等待另一次加入调用。
- 手动岗位的内容可后续编辑；抓取岗位的原始内容仍按当前规则保留。两类 Shortlist 记录都可修改状态和备注；包含手动内容编辑的写入也更新 updated_at。
- 内容修改与管理字段修改需要原子提交，使用现有规范化/约束维护派生字段，不能通过 MCP 绕过后端校验。
- 沿用现有去重规则和数据库身份约束，接受字段少的手动岗位无法识别成同一岗位。不新增公司＋标题模糊去重、自动合并、JD 补全、hash 或记录历史；既有抓取命中也不自动覆盖旧正文。
- 批量加入重复 ID 不覆盖状态、备注和加入时间。复用当前事务和逐项结果；一批失败不撤销之前已经成功的批次，也不自动重放写入。

批量工作流固定为：先翻页收集全部符合条件的 ID，再按每批最多 200 个执行加入。特别是 `in_applications=false` 时，不边读后续页边加入，以免筛选结果集合缩小而漏掉记录；不为此新增快照表或后台批量任务。

### 4.3 Searches、Schedules、Runs 与 App

| Tool | 输入与行为 | 返回 |
| --- | --- | --- |
| `list_searches` | 只读当前已配置方向与 queries，包含启用状态 | 稳定 ID、名称、queries 及启用状态，供岗位筛选和计划引用 |
| `list_schedules` | 读取全部已有计划，沿用最多 10 个计划的约束 | 计划配置、next_at 及简要调度情况 |
| `get_schedule` | schedule_id | 指定计划配置及简要调度情况，不展开日志 |
| `update_schedule` | schedule_id，部分更新 enabled、direction_ids、time、weekdays、timezone | 更新后的计划配置 |
| `preview_run` | 可选 schedule_id 或 direction_ids，两者互斥；均省略时沿用全部启用搜索 | 当前配置下的计划/搜索选择、任务数量与执行参数预览，不创建 Run 或展开全部任务 |
| `list_runs` | page/page_size；可选 kind、statuses、创建时间范围、schedule_id；不指定 kind 时包括 pipeline 与 rescore | 一页状态、时间、阶段、进度和数量摘要 |
| `get_run` | run_id | 指定运行的同类状态、进度和数量摘要 |
| `get_app_status` | 无业务参数 | 服务可用性、是否忙、当前运行/operation 的简要状态，不返回秘密或用户输入正文 |

Schedule 的 time 为 HH:mm，weekdays 为周一 0 至周日 6，空数组表示一次性，timezone 为 IANA 时区。direction_ids 的 null/数组语义及启用方向规则沿用现有计划契约。修改只影响后续执行，不改写历史 Run 快照。

Schedule 只负责搜索选择和时间规则，抓取仍使用全局配置，不增加每个计划独立的城市、平台等配置。M8 只修改已有计划，计划创建继续使用现有 App 入口。

Run 状态沿用 `running/stopping/succeeded/partial/failed/stopped/interrupted`。进度分别给出抓取/评分任务的 total、succeeded、failed、active、pending、cancelled，以及 received、filtered、matched、new 等数量；不要只给一个无法解释的百分比。摘要不包含任务明细、完整配置快照、岗位数组、日志或失败原因。list_runs 与 get_run 对相同字段使用一致定义。

Runs 普通列表默认 50 条、上限 50，按创建时间倒序并以 ID 稳定排序；全部匹配记录通过分页读取。计划最多 10 个，可一次读取；Searches 复用当前配置的只读信息，不另外建设搜索配置服务。

## 5. 返回字段与分页：简单规则

### 5.1 岗位列表

`view=summary` 为默认。保留 id、title、company、location、job_type、score、score_reason、score_state、scored_at、first_seen_at、date_posted、是否在 Shortlist。Shortlist 列表再包含 status、notes、added_at、updated_at；普通 Jobs 列表省略 notes。详情保留现有完整管理信息。

摘要不包含 description/JD、来源链接/申请链接、命中 queries、方向关联数组、薪资详情、评分模型、错误信息。它们统一通过 get_job 读取。筛选条件可以使用未在摘要中返回的字段。

| 模式 | 默认数量 | 最大数量 | 规则 |
| --- | --- | --- | --- |
| 岗位摘要 / Shortlist 摘要 | 50 | 50 | 一次调用一页，完整保留摘要字段 |
| 同一列表工具的 `view=ids` | 200 | 200 | 只返回 ID 数组和分页信息，不返回岗位对象 |
| 单岗位详情 | 1 | 1 | 返回完整字段和完整 JD |
| 批量加入 / 状态写入 | 无默认 ID | 200 | 只回传结果和计数，不附带岗位详情 |

沿用 page（默认 1）、page_size，不改用 offset/cursor。省略 page_size 时按 view 使用上表默认值；显式 page_size 为 1..对应上限，超限按参数错误处理。一页不会在服务端自动读完所有后续页。

摘要返回 `{items,total,page,page_size,has_more}`，ID 模式返回 `{ids,total,page,page_size,has_more}`。total 是全部匹配数量；has_more 根据本页位置和实际返回数计算。最后一页可以少于 page_size。没有总数快照或游标持久化保证，沿用当前分页查询的事务一致性。

### 5.2 输出预算决定

以约 20,000 tokens 的客户端单次工具结果预算为使用约定；它不是新增的业务参数或服务端计费机制。MCP 只输出一份完整结果载荷，避免在多个输出字段重复整份 JSON。不要添加额外的完整结果副本或大段解释性文本。

按用户提供的 6 批、18,491 条原版结果记录，对拟定摘要字段（补上 UUID、状态和时间元数据，保留完整评分理由）的紧凑 JSON 做本地 `o200k_base` 估算：

| 内容 | 平均 tokens | 样本最大值 |
| --- | --- | --- |
| 50 条岗位摘要 | 约 9,800 | 约 11,400 |
| 100 条岗位摘要 | 约 19,600 | 约 22,400 |
| 50 条 Shortlist 摘要，备注为空 | 约 11,000 | 约 12,700 |
| 单条完整原版记录，含 JD | 约 1,600 | 约 7,700 |

200 个 UUID 约 4,800 tokens；把最长的 50 条摘要集中在一页约 13,300 tokens。分词器、序列化和客户端包装会影响实际计数，这些是选定 50/200/1 的样本依据，不是跨客户端的硬保证。数据中没有 Shortlist 备注；用户明确接受备注通常一两句话、极个别超长结果由客户端处理。

不增加产品 tokenizer 依赖、服务端 token 预算器、动态缩页、逐字段字符限制、truncated_fields、长 JD 分段或超限后自动重读。标题、评分理由和备注都完整返回；保留已有 JSON Lines 消息大小上限及既有事务保护即可。样本原文和分析临时依赖不进入产品或 Git，也不作为测试夹具。

## 6. M8 后端与桌面改动

| 模块 | 需要的修改 | 复用边界 |
| --- | --- | --- |
| Electron main | MCP 服务、tool 注册、参数/返回映射、连接配置、与窗口无关的启动和关闭 | 现有 main 生命周期、访问凭据路径及 backend.request |
| main 业务调用 | 提取 IPC/MCP 共用的小型调用入口，保留各自入口校验 | 既有凭据注入、业务错误和事件转发 |
| jobs / applications | 手动来源迁移、原子创建、手动内容部分编辑、Discover 排除手动记录 | 现有实体/清单关系、筛选、事务、清理保护、状态与备注写入 |
| 列表查询 | 固定 MCP 字段投影；ID 模式只查 ID 和总数 | 现有 FilterSpec、稳定排序与计数，不先加载 JD 再丢弃 |
| schedules | 单条读取及部分更新；在串行业务路径中读取当前值、合并、执行原校验与保存 | 现有完整 save、计划触发与队列，不改历史运行快照 |
| runs | 轻量单条摘要读取，补齐 kind/status/时间/计划筛选 | 既有统计计算；不经完整 detail 加载 tasks/jobs 再裁剪 |
| service / shared | 新业务命令与必要类型、写入事件；维持原调用方兼容 | 既有协议和错误码；不引入通用 contracts/schema 工程 |

已有前端 jobs.list/page_size 等契约不受 MCP 50 条上限影响。手动岗位数据按共享列表和详情正常展示；本次未授权单独扩展前端新增/编辑表单，先交付 MCP 入口。实施产生的新数据库字段和 service 命令，随代码同步 DATA-MODEL、CONTRACTS 与模块 README，不能只改 MCP 一端。

## 7. M9 配置工具

| Tool | 输入与行为 |
| --- | --- |
| `create_search` | name、可选 enabled；返回新 ID 和配置 |
| `update_search` | search_id，部分更新 name/enabled |
| `create_query` | search_id、expression、可选 enabled；返回新 query ID 和配置 |
| `update_query` | query_id，部分更新 expression/enabled；沿用现有 query 所属 Search 不可迁移规则 |
| `get_pipeline_config` | 读取允许由 MCP 管理的全局抓取业务配置 |
| `update_pipeline_config` | 部分更新同一白名单内的配置，执行现有校验，返回保存结果 |

list_searches 沿用 M8 的读取入口，包含 queries，创建/修改后的 ID 可以直接用于岗位筛选和 Schedule 选择。create 与 update 都要实现，不只交付修改工具；名称和表达式的校验复用 directions.save / queries.save。

全局配置先覆盖已有 cities、country_indeed、platforms、rules、auto_score_enabled；遵守当前模型/评分模板等依赖校验。M6 已提供的 run_mode、advanced_parameters 可按 CONTRACTS 纳入明确白名单；若开放代理管理，再显式纳入 proxy/mihomo 的非秘密字段（包括 failed_node_cooldown_seconds）。不把尚未配置化的代码常量顺带改为新设置。

不把 settings.get 的完整内部对象直接公开。模型 Key、代理认证、简历输入、草稿等不在此工具范围；也不增加模型管理、AI 生成配置、Search/Query 删除或排序工具。配置写入只影响后续运行，在途运行和历史 Run 沿用其既有快照。

M9 主要包装 directions.save、queries.save、settings.get/save，并同步需要的字段校验、事件和契约；不增加另一套配置存储。

## 8. 实施顺序与验收

### M8

1. 补齐手动岗位来源迁移、创建/编辑、ID 查询、Schedule 部分更新与 Run 轻量查询，保持原有调用方兼容。
2. 接入 main 共用调用入口和本机 MCP，完成上述 15 个工具、连接示例和简短描述。
3. 使用合成数据，通过真实 MCP 客户端与 App/Python 链路验证完整流程，再记录实际结果。

验收围绕真实边界：

- 带 Search、分数、日期和 Shortlist 状态筛选的总数、稳定排序和分页正确；summary 每页 50、ids 每页 200；列表无 JD/详情数组，长评分理由和正常备注完整保留，详情返回完整 JD。
- 先读取跨页 IDs 再批量加入，结果无遗漏；重复加入不覆盖已有备注/状态，失效 ID 有逐项反馈，批量状态修改只作用于指定 Shortlist 记录。
- 仅填标题能创建并直接进入 Shortlist；内容/备注/状态可编辑，重启保留；Discover 不显示手动记录，清理保护其详情；原抓取内容不能经手动编辑接口覆盖。
- Schedule 单字段更新保留其他配置，非法时间/时区/搜索选择被拒绝，后续调度使用新配置，历史 Run 不变；预览不产生真实执行。
- list_runs/get_run 能区分运行中和结束状态，计数一致，支持所需筛选，返回不含诊断明细；已清理记录正常返回不存在。
- 无 renderer 时 MCP 可用，写入后已打开界面收到现有变更通知；Quit 后服务退出；无效访问 token、非允许 Host/Origin 与后端不可用有清晰错误，输出无秘密。

不为未加入的功能编写空实现或预留通用框架，不以人工生成的 JSON 响应代替真实链路验收。MCP 测试使用合成数据和既有 fake scraper/fake LLM，不连接真实招聘网站或付费模型。

### M9

1. 接入 Search/Query 的创建和部分更新，以及全局配置读取/更新白名单。
2. 验证新增 Search 和 Query 可被 list_searches 读到，并可用于计划选择和运行预览；禁用/修改按原业务规则生效。
3. 验证配置部分更新不覆盖省略字段，非法配置不落库，在途与历史运行快照不被修改，结果不含凭据；补充契约及实际交接记录。

各阶段实施后按 [ACCEPTANCE](ACCEPTANCE.md) 的既有相关项与本节新增边界验证，记录本地、真实 MCP 客户端和安装包分别验证了什么。开发态通过不代表安装包或公开插件发布通过。

## 9. M8 实施细化

业务命令、来源迁移、空值/重复身份语义、错误和事件见 [CONTRACTS 的 M8 节](CONTRACTS.md) 及 [DATA-MODEL](DATA-MODEL.md)。本机服务采用无会话 Streamable HTTP POST；连接配置存当前 App 数据目录的 `mcp.json`（0600，port/token），首次分配端口后复用，Host/Origin 精确匹配该端口的 loopback authority。详细连接步骤和可运行 SDK 客户端见 [desktop README](../job-vaccum-app/desktop/README.md#m8-local-mcp)。M9 仍独立待授权。

M6 汇合后无需增加或改造 M8 tools：preview_run 继续返回后端计算的有效抓取/LLM 参数、任务数量及自动评分开关，不返回完整代理配置或验证代理就绪。后端 runs.detail 保存的非秘密配置快照包含 proxy/mihomo；MCP list_runs/get_run 仍只返回状态、进度与业务计数，不公开该快照。代理参数读取/修改属于 M9 配置工具范围。
