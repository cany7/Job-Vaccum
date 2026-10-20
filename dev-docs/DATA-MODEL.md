# 数据模型与持久化约定

## 1. 一条岗位只存一行

`jobs` 是核心对象。公司、标题、完整 JD、地点、链接和当前评分直接是岗位字段，不单建 JD 或评分版本系统。两个池子都读取同一条 job；Applications 只是该岗位的用户管理信息。

JSON 数组适合保存来源展示信息、命中的 query，避免给每个附加字段都建一张表。方向关联与唯一查重键用辅助表，便于重命名、筛选和数据库防重。这些行只保存 ID 和关系，不复制岗位正文。

下表是首版物理模型建议，开发可以微调字段名，但不能改变唯一约束、删除语义和 API 返回对象。

## 2. 表与约束

所有 ID 为稳定 UUID 字符串；事件及管理时间存 UTC 毫秒整数，UI 转换到用户时区；date_posted 以来源 YYYY-MM-DD 日期精度保存。SQLite 外键在每个连接开启，迁移用单独 schema_version 表。

| 表 | 字段与约束 |
| --- | --- |
| jobs | id PK；title/company/location/description/job_type；salary_min/max/currency/interval；date_posted；job_url/job_url_direct；first_seen_at；sources_json、queries_json；company_key；score 可空，CHECK 0..10 整数；score_reason、scored_at、score_model；score_state；last_score_error |
| job_identities | kind（platform_id/direct_url）、value、job_id FK jobs ON DELETE CASCADE；PK(kind,value)，job_id 索引 |
| directions | id PK、name、enabled、sort_order |
| queries | id PK、direction_id FK directions ON DELETE CASCADE、expression、enabled |
| job_directions | job_id FK jobs ON DELETE CASCADE、direction_id FK directions ON DELETE CASCADE；PK(job_id,direction_id) |
| applications | job_id PK/FK jobs ON DELETE CASCADE；status、notes、added_at、updated_at |
| runs | id PK、kind（pipeline/rescore）、status、created_at/started_at/finished_at、config_snapshot_json（含所选方向 ID）、stats_json、error_json、trigger_json（source=manual/schedule、schedule_id、firing_id，可空） |
| run_tasks | id PK、run_id FK runs ON DELETE CASCADE、kind、stable_order、spec_json、status、attempt_count、stats_json、error_json；UNIQUE(run_id,stable_order,kind) |
| run_jobs | run_id FK runs ON DELETE CASCADE、job_id FK jobs ON DELETE CASCADE、is_new；PK(run_id,job_id) |
| settings | key PK、value_json；正式配置和引导草稿分 key 存储，均无秘密 |
| schedules | id PK、enabled、direction_ids_json（null=全部，否则非空数组）、time_local（HH:mm）、weekdays_json（空=只跑一次）、timezone（IANA）、created_at、updated_at；最多 10 行由 service 校验 |
| schedule_firings | id PK、schedule_id FK schedules ON DELETE CASCADE、scheduled_at、outcome（started/waiting/not_run/cancelled）、reason（asleep/app_closed/waited_too_long，可空）、missed_count、run_id 可空；UNIQUE(schedule_id,scheduled_at)；按 retention_days 清理 |

保留上述 12 张表（另有 schema_version），不合并 jobs 与 applications，不新增抓取检查点表。job_directions 和 run_jobs 是多对多关联表；job_identities 是一对多查重身份表。run_tasks 不保存抓取结果文件引用。抓取任务 stable_order 在运行开始时确定；评分任务按登记顺序分配并持久化，续跑不重新编号。

JobSpy 升级不新增表。job_url_direct 与 sources_json 中 direct_url 均允许为空；该基线的 LinkedIn 不提供外链时，使用 job_url 打开平台页面，不为缺失值建立 identity。抓取器输出按列名映射到业务字段：min_amount/max_amount → salary_min/salary_max；缺失值转 NULL，0 不作缺失。DataFrame 转换规则见 PIPELINE。任务的脱敏错误使用 error_json，warnings/缺 JD 计数等必要诊断随 stats_json 保存；不持久化原始 DataFrame.attrs 或完整响应。

`description` 保存完整 JD。sources_json 元素如 `{site,id,url,direct_url}`，queries_json 元素如 `{query_id,direction_id,text}`；规范化后以稳定键去重。JSON 只用于集合内容，不是反复追加的无界运行日志。

`job_identities.value` 的平台 ID 编码为规范 JSON `[site,id]`，避免字符串拼接碰撞；直链使用已确认的 URL 归一化规则。不使用公司＋标题作为跨运行唯一键。内容去重沿用原版完整字符串比较：先用 company_key 查询同公司候选，再从 description 计算归一化 JD 并精确比较，随后应用既定外链规则。不保存内容摘要或新增哈希字段；同一运行可在内存缓存归一化文本，直接以公司名和完整文本组成的元组分组。

应用状态枚举：`new/applied/oa/interviewing/offer/rejected/ghosted`。加入默认 new。notes 修改和状态变化都更新 updated_at，added_at 不变。

jobs.score_state：`unscored/pending/running/succeeded/failed`。无分数不使用 0 占位；重评运行中或失败时可保留旧 score/reason/scored_at，状态描述本次操作。UI 有旧分时显示旧分和时间，同时显示本次失败，不抹掉旧成功结果。

索引至少覆盖 first_seen_at、score、applications(status,added_at)、job_directions(direction_id,job_id)、job_identities(job_id)、runs(created_at)、run_tasks(run_id,status) 和 company_key。列表使用参数化 SQL，动态 sort 字段白名单；JSON JOIN 不得制造重复岗位行。

### 自动评分状态

settings 保存 auto_score_enabled（boolean，默认 true），runs.config_snapshot_json 固定本轮值，无需新增表。关闭时新岗位 score_state=unscored、score/reason/scored_at 为空，不创建 score 类型 run_tasks。unscored 表示没有排队，与 pending 区分；开关变化及历史命中均不为其自动补建任务。手动评分（岗位发现或清单的 Score）按 rescore 运行登记任务并转为 pending，岗位集合在创建运行时固定。本文的岗位与待评分任务原子提交约束仅在本次需要评分时适用。

## 3. 写入事务

### 岗位入库

每个抓取任务的 DataFrame 在内存完成筛选与批内去重，service 串行匹配本轮已入库岗位和历史岗位；同轮关系通过 run_jobs 查询。一次短事务提交该批岗位与身份/方向/来源关联、run_jobs、按自动评分开关创建的待评分任务、任务统计及完成/失败状态。结果提交后即可浏览和评分。不建设结果重复投递与响应重放机制；成功任务不再次提交，未提交任务可从头重抓，失败任务重跑后的任务统计替换而不累加。run_jobs.is_new 首次写入后不因后续重复命中变为 false。

已有岗位只合并来源与 query/方向集合，不覆盖 description、first_seen_at 或 score。历史命中不重新评分。开启自动评分时，新增岗位以 pending 与评分任务一起落库，再派发首次评分，避免入库后崩溃造成漏评。先入库代表固定，后续更完整记录不替换正文或触发重评。

多个累计身份意外命中多个历史实体时，首版不做全库实体合并：以稳定排序查到的第一条匹配为目标，已归属另一实体的唯一键不抢占，记录简短诊断。此路径不能丢失 Applications 或触发唯一约束导致整轮回滚；合成测试覆盖。没有证据的历史公司＋标题不能作为匹配依据。

### 加入、更新与移出清单

加入使用 applications.job_id 唯一约束，重复请求返回 already_present，不能覆盖旧状态或备注。撤销移出时按 remove 返回的原字段重新插入 applications 行（受 job_id 唯一约束）；撤销批量改状态时只写回 status 与 updated_at。不保存撤销历史。批量改状态只更新指定 applications 行的 status 与 updated_at，不触及 notes；不存在的清单记录逐项返回 not_found。批量移出仅删除指定 applications 行；不删除 jobs、identity 或方向。重新加入产生新管理记录和时间，旧备注不恢复。

重评完成只更新 jobs 的评分字段；不对整条 job 执行带旧数据的覆盖式保存，避免覆盖同时修改的备注。pipeline 与手动评分共用运行互斥，后发运行请求返回 BUSY；本轮每个 job 只登记一个评分任务。

### 方向维护

改名仅修改 directions.name，列表关联查询即时显示新名称。排序只修改 sort_order，任务稳定顺序不按 sort_order 生成。

删除方向在一笔事务中删除 query、job_directions 和 jobs.queries_json 中该方向的元素，保留 jobs 与 sources_json。已启动运行的任务快照不变；任务完成发现方向已删除时仍可入库并关联 run，但不能重建方向或写回已删除标签。运行的配置快照用于诊断，不作为岗位显示标签的来源。

单独删除 query 后可保留岗位上已命中的 query 文本；不因此删除方向标签。此文本不依赖 query 行继续存在。

## 4. 清理：保存清单中的完整岗位

运行日志与岗位内容不建立“删日志就删岗位”的所有权关系。job_directions、sources_json、queries_json 不依赖 run_jobs 才能展示。

settings 保存 retention_days（非负整数，默认 14；0 关闭自动清理）；清理每次读取当前设置，时间以 UTC 毫秒计算，不使用 run 快照。保存设置本身不删除数据，下一次清理检查应用新期限。

retention_days=0 时跳过岗位、运行记录、计划触发记录及日志的自动过期清理，必须在计算 cutoff 前判断，不能把 0 当作立即过期。手动清理仍可执行；运行结束的临时文件清理和日志大小轮转不受影响。

自动清理候选（retention_days>0）：`first_seen_at < now - retention_days * 86400000 AND NOT EXISTS applications(job_id)`。设置页手动清理候选：全部 `NOT EXISTS applications(job_id)`。在串行写入事务内重新检查清单关系，不能沿用过时的预览结果。

删除 jobs 时级联删除该岗位的 identities、directions 关系和 run_jobs；清单中的 jobs 根本不进入候选集合。清理 runs 只删除 run_tasks、run_jobs 等运行信息，保留所有剩余 jobs、Applications 和方向／来源集合。

运行记录、计划触发记录和日志按创建/触发时间保留 retention_days 天；手动清理删除全部运行记录、日志与临时文件，保留配置和凭据。与 pipeline/rescore/AI operation 互斥，忙时返回 BUSY，自动清理延后；UI 不显示成功直到完成。清理期间清单写入串行协调，避免加入与删除竞态。

数据库清理使用事务；文件清理独立执行，不保存待删路径或文件清理恢复状态。App 自有 tmp/ 在启动及运行结束、相关子进程退出后清空，失败记录日志。日志使用标准轮转并按 retention_days 期限清理；手动清理失败须报告未完成项，不显示全部成功，也不回滚已完成的数据库清理。禁止删除用户 Mihomo 配置、用户导出 CSV 或 App 数据根目录外的文件。

移出清单不重置首次发现时间，已过期岗位在下一次清理中删除。清单保护没有额外复制 JD 的步骤。

## 5. 查询、导出与统计

列表和导出共用同一份 FilterSpec（见 CONTRACTS），导出不使用当前页行集合代替全部筛选结果。方向过滤用 EXISTS，避免一个岗位多个标签造成重复分页或 CSV 行。清理后运行详情中数量保留为当时统计，岗位链接只展示仍存在的实体，不伪造已清理结果。

方向统计是运行快照统计；方向改名使用当前名字，方向已删时可隐藏该方向分项，但保留全局统计。不可为了展示历史统计重新创建标签。

CSV 包含评分时间、可用薪资单位、方向集合、来源集合、完整日期；JD 按用户选择导出。采用 UTF-8 BOM。不要再生成四分类 high/mid 文件。

批次筛选使用 `EXISTS run_jobs(run_id IN ... AND is_new=1)`，每个岗位只归属首次发现它的运行；运行记录被清理后对应岗位只在 All 中可见，不为此保留运行或复制关系。筛选、排序及导出按 CONTRACTS 扩展，沿用现有 11 表和字段；不新增浏览状态表。来源数组使用 SQLite JSON 查询的 EXISTS，方向/run 关联也使用 EXISTS；先筛选岗位再计数分页，稳定排序以 job_id 结尾。批量加入 applications 依赖 job_id 唯一约束，重复加入不覆盖状态、备注或加入时间。浏览偏好保存到 Electron 本地 UI 偏好，不使用抓取中间文件。索引在现有基础上结合实际列表查询计划添加，优先验证 date_posted、score_state 及清单 updated_at，避免为所有筛选组合建立索引。

## 6. 迁移与崩溃恢复

全新数据库从迁移 001 开始，按序执行迁移；不导入私人 JSON、CSV 或 Sheets。应用启动先完成迁移再接收写命令。测试至少覆盖空库、已有首版库重启、迁移失败回滚。

只有确认前次 service 已终止后，才把 runs/tasks 的 running 状态转为 interrupted/pending。抓取不保存结果 JSON、manifest 或分页检查点；成功任务的岗位变更已原子提交，恢复时跳过，其余任务从头重抓。已入库岗位的评分独立恢复，无须等待抓取完成。重评分中断时保留旧成功 score；首次评分中断时保持无分数。未来迁移不能通过删库重建实现。

## M1 第 2 步落地说明（2026-10-19）

迁移 002 建立 jobs、job_identities、directions、queries、job_directions、applications（001/settings 原样保留）。字段名 salary_currency/salary_interval 与 API salary 对象映射；date_posted 保留来源 YYYY-MM-DD 精度，其他事件时间为 UTC 毫秒。M1 仅 synthetic importer 合并已知合成实体的集合，不代替 M2 的抓取筛选及身份/内容去重。

用户明确确认本步不提前建运行表，run_ids 筛选留到 M2。runs/run_tasks/run_jobs 及 schedule_firings 按所属阶段追加迁移；M1 cleanup 的运行数固定 0，不宣称验证了未建立表的级联清理。清理当前 jobs 时 identities/job_directions 级联删除，directions/query 配置保留。

## M2 落地约定（2026-10-19）

迁移 003 增加 runs/run_tasks/run_jobs，既有 002 数据原地保留；schedule_firings 留 M7。2026-10-20 设计修正：runs.trigger_json 随 M2 Runs 修正迁移加入（旧运行为 null，按手动显示），schedules 与 schedule_firings 在 M7 迁移建立。任务 kind=retrieval/score，统计 JSON 不保存原始记录或 attrs。settings 各正式字段分别存 key，草稿使用 draft:search/rubric；普通代理认证仅运行时内存。M2 评分任务事务登记，但执行留 M3，存在 pending 评分的运行保持 running/scoring。

M2 内容匹配使用现有 sources_json 中后来补入的有效 direct_url 参与不同外链边界判断，避免首个 LinkedIn 代表没有外链时误合并不同外部岗位；不回填或替换代表主字段。
