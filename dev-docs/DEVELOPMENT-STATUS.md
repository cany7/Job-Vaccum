# 开发状态

最新状态：2026-10-20 Jobs/Shortlist 评分与批次界面修正已实现并本地提交于 codex/dev，未推送（见下节）。M2 Runs 修正已通过 PR #13 合入 main（3a6816f）；运行计划本体仍属 M7。真实模型、安装包未补验，安装版分页重试遗留失败仍暂缓。


## 仓库首页简要更新（2026-10-20，Codex）

按用户要求小幅更新英文 README，介绍已实现的检索、规则过滤与去重、运行历史、岗位浏览、自动/手动评分、Shortlist 与 CSV 导出；调度、AI 引导和高级代理继续标为计划功能，保留未签名发行说明。移除首页对本地 Agent skills 准备的要求，工程约定仍以 AGENTS 为准。未修改产品代码、依赖或仓库可见性。

验证：人工核对 README 与当前实现及阶段记录，`git diff --check` 通过。纯文档修改，未重跑测试或打包；仅本地提交，不推送。

## Jobs/Shortlist 与 Runs 修正交付前验证（2026-10-20，Codex）

用户已授权 push、PR；按 AGENTS 流程开启必需检查通过后的自动合并。推送前 `git fetch origin && git merge origin/main` 已确认无需额外合并；desktop `npm test`（类型检查、构建、15 Node tests）及 `npx --no-install playwright test --grep @smoke`（6 passed，7.5 秒）通过，`git diff --check` 通过。交付包含 6d33c92、15b9c8f 的最终修改；前述“未推送”记录为当时状态，远端合并及主线 CI 结果以本次 PR/Actions 为准。

## Runs 与评分标记试用反馈修正（2026-10-20，Codex）

用户试用后明确要求三处调整，修改保留在 codex/dev；中断后确认工作区改动完整，再继续验证。沿用前次记录的本机环境及既有两个设计 skill。

- Filtered out 的 By rule 移到数字下方左侧，与 Matched 的 seen before 同行；弹出规则明细和键盘焦点行为保持。
- Tasks 最小宽度调为 1100px，Query/Location 保留可读列宽，剩余宽度留给 Notes；在自身容器中横向滚动，继续纵向滚动、固定表头、单行截断与悬停全文。Notes 按既有定义显示无结果、缺 JD 数、限流次数、警告数，以及失败原因/错误码，不是用户编辑的备注。
- 详情标题旁所有评分标记统一矩形，包括排队与评分中；与右侧标题和公司地点区域垂直居中。移除上一轮的圆形特例，保留空心描边/小时钟/蓝色以及无动画。SPEC 同步用户最新决定。

验证：desktop `npm run build` 通过；`npx --no-install playwright test tests/e2e/runs.spec.cjs tests/e2e/jobs-scoring-review.spec.cjs` 的 3 项 Runs/评分回归通过，涵盖 By rule 行位置、实际横向滚动距离、230 任务纵向滚动和固定表头、矩形尺寸及垂直居中、浅深色与 640×480。该次 Settings 用例输入 Master 得到 Maste 而失败；单独执行 `npx --no-install playwright test tests/e2e/runs.spec.cjs --grep 'Settings: searches'` 后 1 passed（10.3 秒），未改 Settings 或放宽断言，首次原因未定位。根目录 `git diff --check` 通过。实际查看 Runs 横向滚至 Notes 的截图，以及评分详情浅色 640×480、深色 1280×800 截图，布局符合本次要求。未修改后端、依赖或 Settings；未重新打包、调用真实服务。仅本地提交，不推送。

## M3 Jobs/Shortlist 评分与批次界面修正（2026-10-20，Codex）

用户授权仅此界面修正、本地 commit；开工执行 `git fetch origin && git merge origin/main`，codex/dev 已与最新主线 3a6816f 一致，工作区干净。阅读 AGENTS、README、两个设计 skill、指定 SPEC/CONTRACTS/M3/B08/B14 章节，以及浏览器中的「Jobs：批次筛选与评分」评审板。仅修改共用 renderer、相关 E2E 和本记录；后端、协议、依赖及 lockfile 未变。

### 实际交付

- 重评失败保留旧分色块（包括 0 分），右上角橙点；仅从未成功才显示橙色 `!`。详情 Score 行显示旧分、原评分时间和模型 ID，下一行橙字 `Last attempt failed` 与原因。排序/范围筛选仍使用已有旧分。
- 排队为灰色空心描边色块与小时钟；评分中为蓝色空心描边色块。无动画；详情标题旁使用小圆形标记，避免像方形操作按钮。
- Score all 打开时使用现有 `jobs.list` 查询总数及同筛选已有分数数（无最低分条件时加 `score_min:0`；已有更窄最低分时保留，避免扩大范围），未评分数为差值。确认框固定本次筛选、显示三个数量及条件标签，无筛选时写 `Every job in Jobs (N) is scored`（Shortlist 对应自身池子）；不显示模型 ID/主机。查询中或失败不能提交，Cancel 默认聚焦；创建时数量变化仍使用原有提示。
- 共用菜单鼠标打开聚焦容器、不预选项目，键盘打开聚焦首个可用项；方向键、Esc、返回触发按钮继续有效，全部项禁用时仍可 Esc。高亮使用浅灰行底色及深色对应色，不再用主按钮强调底色。
- 批次编辑器移除 All batches，已有 Remove filter 表示全部；多选、首次发现语义、失效批次清除不变。

### 验证环境与实际结果

macOS 27.0.1 arm64；Node 26.12.0、npm 11.20.0、Python 3.13.12、Electron 44.9.0；沿用本机既有独立依赖环境。全部岗位、Key、模型响应为合成测试数据。

- desktop `npm test`：类型检查、生产构建、15 Node tests 通过。
- desktop `npx --no-install playwright test tests/e2e/jobs-scoring-review.spec.cjs tests/e2e/scoring-ui.spec.cjs tests/e2e/lists.spec.cjs tests/e2e/runs.spec.cjs`：既有 15 项全部通过（列表、三主题浅深色、请求失败/空状态、批次、评分成功/失败/停止等）；新增用例因测试点击了 Shortlist 行内控件而未打开详情失败。改为点击分数单元格；此前一次新增用例将 `+ Filter` 错写成 `Add filter`，也已修正。
- desktop `npx --no-install playwright test tests/e2e/jobs-scoring-review.spec.cjs`：新增 B14 用例通过。验证首次失败/旧分失败/0 分、排队/评分中、旧分排序和范围筛选、同筛选计数、Shortlist 计数、条件标签、模型/主机不展示、鼠标/键盘菜单、Cancel 焦点、计数加载/错误时不可提交、reduced-motion、窗口无整体溢出。相关 16 项 E2E 分批通过。
- 根目录 `git diff --check`：通过。

### 截图检查与限制

实际运行 Electron 并查看 Graphite 浅色/深色、1280×800 与 640×480 截图：Jobs 失败详情、排队详情、Score 菜单、Score all 确认框，Shortlist 旧分 0 的失败详情。旧分、橙点、橙字原因清楚可见，空心标记可区分；窄窗详情内部滚动，确认按钮可见，页面无整体溢出。截图保存在本地忽略目录 `tmp/job-vaccum-app/M1 lists */jobs-review/`，不纳入产品或提交。

未运行后端全套 pytest、完整 Desktop E2E 或重新打包；未调用真实模型/抓取服务。本轮未涉及 M4–M7、Settings 设计调整或此前暂停的安装版问题。按用户要求仅本地提交，推送/PR 等待另行确认。

## M2 Runs 静态审阅与交付前检查（2026-10-20，Codex）

- 静态审阅 Claude 提交 a6ca964，未发现阻止合并的代码问题；未修改产品代码。
- 在 claude/dev-env 合并 origin/main（60b23c5），只产生 DEVELOPMENT-STATUS 文档冲突，合并保留 Runs 已实现记录及主线已确认的 Jobs 评分与批次设计。
- 沿用上述本机环境执行：backend `uv run --locked pytest -q`：181 passed（20.05 秒）；desktop `npm test`：类型检查、构建与 15 Node tests 通过；`npm run test:e2e:smoke`：6 passed（7.4 秒）；`git diff --check` 通过。
- 本轮未重复完整 E2E、视觉检查或安装包验证，未使用真实抓取或付费模型。用户已授权推送、PR 自动合并并同步两个开发分支；远端结果以 PR/Actions 为准。

## M2 Runs 修正实现（2026-10-20，Claude，本地提交未推送）

### 授权与范围

用户授权 M2 范围的 Runs 修正（IMPLEMENTATION-PLAN M2 末项）；计划功能本体（schedules、到点触发、等待队列、未运行记录）属 M7，本次未做。读过 AGENTS、dev-docs/README、两个设计 skill（`.agents/skills/apple-design/SKILL.md`、`.agents/skills/emil-design-eng/SKILL.md`）、本文件上一节、SPEC v0.7「窗口布局与列表」「运行计划与进度」、CONTRACTS runs.* 与运行计划段、ACCEPTANCE R16/B13 及设计画布 Runs 页原型。工作区 `/Users/tim77/PycharmProjects/job-vaccum-gui-claude`（claude/dev-env worktree），从 origin/main 18ed54d 合并本地 codex/dev 的文档提交 f58ec32 后开始；依赖与 lockfile 未变，独立执行 `uv sync --locked`、`npm ci` 并从本机缓存安装 Electron 44.9.0 二进制。

### 实际交付

- 后端：迁移 004 给 runs 加可空 trigger_json（schema_version=4）。runs.preview/start 接受 direction_ids（null/省略=全部；未知 ID 忽略；空数组、剩余为空或所选搜索无启用 query 返回 VALIDATION_ERROR），只为所选且启用的方向生成任务，快照记录 direction_ids。runs.start 与 jobs.score 记 `{source:"manual"}`；schedule_id/firing_id 随 M7。RunSummary 返回 searches（快照名称，方向删除后仍显示）和 trigger。
- 运行状态色（三主题共用，不用强调色）：Running 蓝、Completed 绿、Partly completed 橙（进度条失败段同色）、Failed 红、Stopping/Stopped/Interrupted/空闲灰、Waiting 类为灰空心圆（用于任务表的等待任务）。
- Runs 页：顶栏只有页面名（无运行按钮、无计数、无 Next run 横幅）。左栏「Schedules +」→ 分隔线 → 历史卡片（第一行开始时间与新发现数／评分运行岗位数／运行中任务进度，第二行状态点、状态与所跑搜索，评分运行写 Scoring completed 等；无来源标签）。+ 打开「New run」面板：搜索标签多选（All searches 或具体搜索，已关闭的搜索不可选）、Run now、按所选搜索的任务计划摘要与 Edit searches。配置不全时左栏顶部一行「Can't run yet: add a query.」及设置链接，不显示错误码、不用红字，所有运行按钮禁用并在悬停说明原因。
- 运行详情：标题为所跑搜索＋状态，副标题为来源（Manual／Scheduled，旧运行按 Manual）与起止时间；右上角运行中为 Stop（停止中为禁用的 Stopping…），结束后为 Run again（按该轮搜索、当前配置；运行中、配置不全或所选搜索已全部删除时禁用并说明）。统计卡 Matched 下小字「N seen before」（Matched − New）；Filtered out 的「By rule」打开纵向弹出卡片，列出本轮开启的规则（缺标题/描述与 Part-time 恒开，排除公司有名单时列出）及数量，Esc／点别处关闭并返回焦点。任务表逐页（200/页）取回全部任务，不分页、表内滚动、表头固定、每行单行截断，悬停看全文；表格占满详情剩余高度。评分运行详情保留 Jobs／Scored／Failed。
- 侧边栏底部一行状态（可点击进入 Runs）：后台异常（红字）＞ Running · 3/8 tasks（评分阶段为 Running · scoring 2/4）＞ Stopping… ＞ Last run 10/19 21:29（无运行时 No runs yet）；不再显示 Backend ready 与第二行运行文字。窄条只显示同色圆点，悬停为该行文字。Next run 随 M7。
- 全应用日期：`10/19 21:29`、表格／详情日期 `10/17`，非今年 `2025/12/03`；Jobs/Shortlist 表格、详情、Runs、批次选项与筛选标签、日期范围标签一致。
- E2E 就绪信号由「Backend ready」文字改为 `.sidebar-status[data-connection=ready]`。

### 实际命令与结果（macOS 27.0.1 arm64，Node 26.12.0，npm 11.20.0，Python 3.13.12，Electron 44.9.0）

| 命令／检查 | 结果 |
| --- | --- |
| backend `uv run --locked pytest -q` | 181 passed，22.81 秒；新增所选搜索任务生成/快照/searches/trigger/全局去重与批次/删除后 VALIDATION_ERROR/评分运行 trigger，及 003→004 迁移保留旧运行（trigger null）；原 schema 断言改为 4 |
| desktop `npm test` | 类型检查、构建通过，15 Node tests passed |
| desktop `npx --no-install playwright test`（第一次完整运行） | 24 passed / 3 failed：desktop.spec 两项仍断言 schema 3 与旧「No runs yet」标题（随后修正）；lists.spec:549 请求失败用例超时 30 秒 |
| desktop `npx --no-install playwright test tests/e2e/desktop.spec.cjs` | 11 passed |
| desktop `npx --no-install playwright test tests/e2e/lists.spec.cjs:549 --trace on`；整份 lists.spec | 1 passed；7 passed。本轮未改 ListView/列表请求逻辑，完整运行中的超时原因未定位，不宣称已修复 |
| desktop 最终完整 `npm run build && npx --no-install playwright test` | **27 passed，2.1 分钟**（含 lists.spec:549） |

runs.spec 覆盖：三条历史（含 230 个任务的运行）卡片文字与状态色实测（橙 rgb(194,97,12)、绿 rgb(27,115,57)）、侧边栏一行状态与灰点、顶栏无运行按钮、标题/来源/起止时间、Run again 可用、Matched seen before、By rule 五条规则含 0 及 Esc 返回焦点、任务单元格 title、230 任务全部取回且表内滚动时表头和详情不动、每行 ≤34px、640×480 无页面溢出；New run 选 Software 后预览 1 task、Run now 防重复点击并以 `{direction_ids:[Software]}` 调用、运行中 + 面板 Run now 禁用及原因、Stop/Stopping…/Stopped、Run again 复用所选搜索；新安装左栏一行提示不含错误码并链接设置，评分配置提示链接 Filters & scoring。

### 视觉检查（实际查看截图）

临时脚本（已删除，不入库）生成并查看：1280×800 浅色/深色的部分完成详情、By rule 弹出、New run 面板、评分运行、配置不全、运行中（假 IPC）；640×480 浅色/深色详情、滚动后的任务表、New run、卡片键盘焦点环；Jobs 详情「found 10/20」与批次选项「10/19 23:12 · 0 new」。据此把任务表最小宽度与列宽收窄，使 1280 宽时 Notes 列可见（仍截断，悬停看全文）。新增界面无动画；reduced-motion 沿用既有按钮规则。

### 未完成与限制

- 计划（Schedules 列表、开关、时间/重复、Save、等待/未运行卡片、Next run 状态行、runs.start 的 schedule_id/firing_id）均属 M7，未实现；左栏 Schedules 区目前只有 +。
- 未重新打包或验证安装副本；未运行真实网站抓取或真实模型。
- 1280 宽时任务表 Notes 列较窄，长说明依赖悬停查看。

## Runs 页与运行计划设计修正（2026-10-20，Claude，仅文档）

M2/M3 界面评审后与用户确定，已同步 SPEC v0.7（窗口布局、运行状态色、日期格式、运行计划与进度、设置分页）、PIPELINE §8、CONTRACTS、DATA-MODEL、IMPLEMENTATION-PLAN（M2 修正、M7）、ACCEPTANCE（R01、R16、S01、S05、S06、B13）。原型见设计画布 Runs 页原型：https://claude.ai/artifact/5ByVdzguJxgv5XBswmV2Y7

- 计划改为闹钟式：多个（≤10）、每个可选搜索、不选星期即只跑一次（跑后自动关闭）、在 Runs 页管理；Settings 不再有运行计划分区，菜单栏图标开关移到 Appearance。
- 冲突排队：到点忙时 waiting，结束后按到点先后开始；每计划最多一个等待；退出/崩溃记未运行。不自动补跑，错过记未运行（每计划只留最近一条及累计次数），可手动 Run now 或删除；不阻止系统休眠。
- Runs 页：计划区（运行中/等待置顶，其余按时间早到晚）＋分隔线＋历史卡片；顶栏无运行按钮，Run now 在计划详情，Stop／Run again 在运行详情；状态色 Running 蓝、Completed 绿、Partly completed 橙、Failed 红、停止灰、等待/未运行灰空心圆；Matched 加「N seen before」，Filtered out 的 By rule 弹出逐条数量；任务表不分页、表内滚动；配置不全时左栏一行提示，不显示错误码。
- 侧边栏底部一行状态（后台异常＞运行中＞停止中＞Next run＞Last run），不再显示 Backend ready；窄条圆点同色。
- 全应用日期改为数字：MM/DD HH:MM、表格 MM/DD，非今年 YYYY/MM/DD。
- Jobs 评分与批次（画布「Jobs：批次筛选与评分」全部建议采纳）：重评失败仍显示旧分加橙色小点，只有从未成功才显示「!」，详情写旧分时间与「Last attempt failed」；排队/评分中改为空心描边标记；Score all 确认框写总数、将重评数和未评分数，不显示模型 ID 和服务主机（以后有多个命名模型配置时显示配置名称），无筛选时文案改为「Every job in Jobs (N) is scored」；菜单鼠标打开不预选、高亮改浅灰；批次编辑器去掉 All 项，移除筛选即全部。同步 SPEC、CONTRACTS、IMPLEMENTATION-PLAN（M3）、ACCEPTANCE B14。
- 待做：M2 范围的 Runs 修正已于同日实现（见上节）；上面的 Jobs 修改已于同日实现（见顶部 M3 修正记录）；计划功能本体随 M7。Settings 新分区的评审意见尚未与用户确认，未写入文档。

## M3 前端审阅修复（2026-10-19，Codex）

- 从 origin/main 18d548c 同步到 codex/dev 后修改，无后端、协议、依赖或数据结构变更。
- 详情 Score / Rescore 与工具栏共用实际运行及配置阻止条件。停止运行后，后端按既有契约保留的 pending 不再被误判为仍在评分；运行中仍禁止发起评分。
- 模型表单修改、已保存 Key 替换或删除会使旧连接测试结果失效。在途测试保留等待/取消状态，但配置变化后其结果不再显示为当前配置的成功或失败；未变化配置的测试照常显示结果。
- 两项回归使用合成岗位/Key 和受控本地 HTTP 响应，覆盖停止后 pending 岗位从详情重新评分、运行中按钮禁用、测试等待期间改模型、重新测试新模型、删除 Key 后清除成功提示。

实际验证（沿用本机锁定环境）：

| 命令／检查 | 结果 |
| --- | --- |
| desktop `npm run build` | TypeScript 检查及生产构建通过 |
| desktop `npx --no-install playwright test tests/e2e/scoring-ui.spec.cjs --grep 'Model test results follow\|Stopped scoring leaves'` | 停止后评分用例通过（6.9 秒）；连接用例末尾等待成功提示失败，失败快照位于 Searches |
| desktop `npx --no-install playwright test tests/e2e/scoring-ui.spec.cjs --grep 'Model test results follow' --trace on` | 1 passed（13.1 秒）；未改产品代码、放宽断言或增加自动重试，首轮切页原因未确认，不宣称已修复该偶发现象 |
| 根目录 `git diff --check` | 通过 |

未重跑完整后端、Node、E2E 套件，未打包、调用真实服务或处理此前暂停的安装版分页问题。远端结果以本次 PR/Actions 为准。

## M3 前端：模型连接、评分模板与手动评分（2026-10-19，Claude，本地提交未推送）

### 授权与范围

用户要求按文档完成 M3 前端部分，完成后本地提交、不 push。读过 AGENTS、dev-docs 的 README/SPEC/IMPLEMENTATION-PLAN/CONTRACTS/ACCEPTANCE/ARCHITECTURE/PIPELINE/DATA-MODEL 相关章节，及两个设计 skill（`.agents/skills/apple-design/SKILL.md`、`.agents/skills/emil-design-eng/SKILL.md`）。开工时 claude/dev-env 与 origin/main（484210b）一致。只改 renderer、其 E2E 及本文件/CONTRACTS 说明；未改 Python、main、preload、shared 类型、依赖或 lockfile，未新增 service 命令或业务表。

### 实际交付

- **Settings › Model**（新分区，位于 Filters & scoring 与 Proxy 之间）：四协议选择；Base URL 带协议示例、自动追加的后缀和最终 endpoint 预览（Gemini 含 URL 编码的 model ID），非本机 http 提示用 https；Model ID（Gemini 拒绝 models/ 前缀）。请求参数 temperature、最大输出 token（Anthropic 标必填，本地拦截空值，不补默认）、OpenAI 两协议的 reasoning effort 文本 / Anthropic、Gemini 的 thinking JSON 对象（本地仅校验对象语法）、Anthropic 版本头（预填 2023-06-01）；每项旁显示实际发送的协议字段名。空值为 null 不发送，0 照常发送；切换协议只发送该协议相关字段，不按模型名做任何适配。Save 写正式配置，Discard 还原；页头说明调用会发送的内容。
- **API Key**：密码框单独 Save key / Replace key，经既有 setModelKey 存 safeStorage，界面不回显，只显示是否已保存；Remove key。读取失败时显示 model_key_error（原因在前、代码在后）及处理办法，测试与评分禁用并说明，抓取不受影响。
- **Test connection**：用表单当前（可未保存）字段调用 testModel；等待中可 Cancel；成功「Connected」，失败显示受控原因、错误码、HTTP 状态及按 401/403、404、400/422、网络、限流给出的检查建议，输入不丢失。离开该分区时取消进行中的测试，不显示迟到结果。等待 model.test.completed / operation.failed 事件，复用既有 operation 等待机制。
- **Filters & scoring**：新增 Markdown 评分模板编辑（占位示例，⌘↩ 保存，Discard）。保存后若自动评分关闭，在下方询问「Turn on / Not now」，不自动开启；自动评分开启时不允许清空模板并说明原因。自动评分说明在缺模型或 Key 时提示运行无法开始。
- **Score ▾**（Jobs：Score、Export、Add to Shortlist；Shortlist：Set status、Score、Export、Remove）：Score selected (N)；Score all N matching… 先弹确认框，写明数量（当前筛选全部页）、筛选摘要、模型 ID 与服务主机，默认焦点 Cancel，确认后提交 FilterSpec。缺模型/Key/模板、Key 不可读、已有运行或请求进行中时按钮禁用，悬停说明原因。jobs.score 不自动重发，返回后重查运行状态；成功提示条「Scoring N jobs · View progress」打开该次运行，服务端数量与确认数不同则注明。
- **详情抽屉**：Score / Rescore（有旧分时）同一入口；已排队/评分中或被阻止时禁用并说明。打开的详情在外部变更（评分结果）后重新读取，列表仍只提示「Results updated · Refresh」，不重排。失败时保留旧分并显示「!」、原评分时间和受控错误（M1 已有显示）。
- **Runs**：额外读取 runs.list kind=rescore，搜索运行与手动评分运行合并为一个历史（批次筛选仍只用 pipeline）。评分运行显示「Scoring · N jobs」，详情为 Manual scoring、评分进度、Jobs/Scored/Failed，「N failed」打开按 Score: Failed 筛选的 Jobs。stopping 时显示仍在进行的任务与模型请求数。无法运行原因按 AUTH_ERROR/API key 链到 Model 设置。
- 窄窗口：页面名不再被压缩，≤760px 隐藏顶栏副标题（数量在分页处仍可见），解决 Shortlist 四个按钮时标题被截断。

### 实际命令与结果（macOS 27.0.1 arm64，Node 26.12.0，npm 11.20.0，Python 3.13.12，Electron 44.9.0；依赖与 lockfile 未变）

| 命令／检查 | 结果 |
| --- | --- |
| desktop `npm test` | 类型检查、构建通过，15 Node tests passed |
| desktop `npx playwright test`（构建后） | **25 passed，1.9 分钟**：原 22 项（仅 runs.spec 的 Save 选择器加 exact，及假 runs:list 区分 kind）＋新 `tests/e2e/scoring-ui.spec.cjs` 3 项 |
| backend `uv run --locked pytest -q` | 179 passed，20.28 秒（后端未改，仅确认） |
| 根目录 `git diff --check` | 通过 |

新 E2E 使用真实 Electron/main/preload/Python 与本地假 Chat Completions HTTP server（合成岗位、合成 Key）：无模型时 Score 禁用及原因；四协议 endpoint 预览、Anthropic 必填/thinking JSON/非法 URL 本地拦截；空白 Key 拒绝、Key 去空白后保存、不出现在设置中；未保存字段测试（temperature=0 发送、空字段不发、设置仍为 null）；401 失败提示与输入保留；保存后配置与预期完全一致；删除/重存 Key；重启后损坏 model-key.enc 显示错误、Score 原因更新。模板保存后询问且未自动开启、Turn on 生效、开启时不能清空。Score all 30 确认框数量/模型/主机及 Cancel 焦点且零请求；勾选 2 条评分（一成功 7 分、一 HTTP 400 失败保留旧分 2 分并显示「!」及 HTTP 400）、运行期间 Score 禁用、View progress 打开评分运行、1 failed 进入失败筛选；搜索收窄后 Score all 1 matching、详情自动更新分数、Rescore；Shortlist 菜单；Runs 历史 3 条评分运行；全部请求带同一 Bearer Key。服务端 RPM 10，评分用例约 20 秒。

### 视觉检查（实际查看截图）

1280×800 浅色：Model（Chat Completions 已连接、Anthropic 未保存含必填错误）、Filters & scoring 模板与询问、Jobs Score 菜单、Score all 确认框、评分中详情（排队标记、Rescore 禁用）、Runs 评分运行完成、失败岗位详情；深色：失败详情、Model；640×480：Model、Shortlist、Jobs，无页面溢出，无页面错误。发现并修复 640 宽 Shortlist 标题被截断。新增界面无动画；菜单与确认框沿用既有键盘导航、Esc 和焦点返回，reduced-motion 沿用既有按钮规则。

### 未完成与限制

- 没有真实模型服务测试条件，四协议仅 Chat Completions 经本地假 server 走通界面链路；其他三协议界面只验证本地校验与预览（后端协议契约测试为既有交付）。未调用付费模型，未读取私人凭据。
- 未重新打包或验证安装副本；安装版分页重试遗留失败未处理。
- 续跑（Resume）及 interrupted 处理仍属 M4；AI 生成模板/方向、「从示例开始」入口属 M5，本轮只提供占位示例文本。
- Runs 页布局仍待用户确认；评分运行详情不逐岗位列出任务（任务只有 job_id），失败岗位通过 Jobs 失败筛选查看（包含其他运行的失败）。


## M2/M3 推送前快速审阅（2026-10-19）

范围：已有 M3 修复提交 47d940d 与九个 M2 未提交文件；本地已含 PR #8（db6b470）。本轮检查凭据读取失败边界、取消派发实际尝试次数、清理后缺失岗位续跑，以及预置城市不覆盖已存配置、整轮规则统计和 renderer/shared 契约。未发现阻塞交付问题，未新增产品代码修复。用户本轮明确授权提交并推送，取代此前暂不提交/推送的限制；已 fetch，origin/main 无新增提交。

环境沿用上节本机环境与锁定依赖。本轮仅定向验证，没有重跑完整套件或重新打包：

- desktop `npm run build`：类型检查和生产构建通过（本聊天前一轮分页核查执行，之后产品代码未改）。
- backend `uv run --locked pytest -q tests/test_pipeline.py::test_preset_cities_stable_and_saved_empty_preserved tests/test_pipeline.py::test_run_rule_counts_all_tasks_and_replacement tests/test_scoring.py::test_resume_after_retention_keeps_receiver_alive_and_reports_missing_jobs tests/test_scoring.py::test_cancel_while_score_start_notification_is_blocked_does_not_send_or_count`：7 passed，0.30s。
- desktop `node --test tests/business-ipc.test.cjs tests/model-credentials.test.cjs`：3 passed。
- desktop `npx --no-install playwright test tests/e2e/runs.spec.cjs --grep 'history, progress' --output ../../tmp/pr7-push-review`：1 passed，1.7s。
- desktop `npx --no-install playwright test tests/e2e/lists.spec.cjs --grep 'request failures, skeleton rows' --trace on --output ../../tmp/pr7-targeted-review`：1 passed，3.8s（本聊天前一轮）；首次带标题起始锚点的筛选未匹配用例，纠正筛选后执行成功。
- 根目录 `git diff --check`：通过。远端 CI 结果以本轮 PR/Actions 为准，不把此前完整测试记录写成本轮重跑。

遗留交接：M1 列表分页/请求失败重试，在 M2 安装回归发现。`desktop/tests/e2e/lists.spec.cjs:549` 的用例导入 125 条合成岗位，拦截 jobs:list 为延迟 2500ms 的 TIMEOUT，点击 Next page，待错误出现后恢复处理器，点击 Try again；第 577 行预期 51–100 of 125，旧安装版实际 101–125 of 125，原聊天单项复验仍失败。当前开发版同一测试通过，`ListView.tsx` 重试仅增加 reload，请求沿用 pageNumber；该逻辑本轮未改，原因仍未定位。旧安装包/trace 已按先前用户要求清理，本轮未重建安装版。后续先记录分页点击、jobs:list 的 scope/page/page_size、响应与页码变化，区分应用状态问题和自动化交互/启动时序问题；不能直接放宽断言或标记已修复。

## M2 收尾补验（2026-10-19，本地未提交）

工作区 `/Users/tim77/.codex/worktrees/m2-completion/job-vaccum-gui`，分支 `codex/m2-completion`，从最新 origin/main db6b470 开始。原工作区存在其他未提交修复，因此隔离实施；本轮产物不包含那些修复。用户明确要求完成后不要 commit/push，未创建 PR。

交付：后端缺少 cities 设置时提供用户给定的 19 个美国城市，稳定 UUID、原顺序及半径、全部启用；Philadelphia 缺失参数按已声明假设为 enabled=true、25 miles。已保存的自定义城市和空数组不覆盖。整轮 filter_reasons 对全部任务的当前计数求和，重跑替换而不重复累计，历史运行可从任务恢复聚合；list/detail/event、shared 类型与 Runs 的 Filtered by rule 展示同步更新，无新表/依赖。按用户最新要求覆盖 ARCHITECTURE 原“少量城市启用”初值。

实际验证（macOS 27.0.1 arm64、Node 26.12.0、Python 3.13.12、SQLite 3.54.0、Electron 44.9.0）：

- 独立环境 `uv sync --locked`、`npm ci`；未复制 .venv/node_modules，未升级 lockfile。
- backend `uv run --locked pytest -q`：174 passed，21.67s；新增城市默认值/稳定性/用户清空与编辑保护、跨任务分页聚合/统计替换/历史计数测试。
- desktop `npm test`：类型检查、构建及 13 Node tests passed。
- desktop `npx --no-install playwright test tests/e2e/runs.spec.cjs`：3 passed，13.8s。首轮新规则区复用 run-totals 导致旧测试定位不唯一，已收窄总数区域定位后通过；窄窗口及 reduced-motion 无页面溢出，检查了截图。
- `npm run package:mac`：arm64 App/DMG 构建成功；只读挂载 DMG，ditto 复制到 `tmp/M2 installed/Job Vaccum.app` 后卸载挂载卷。构建日志 `tmp/m2-package.log`。
- 安装副本 `JV_EXECUTABLE=… npx --no-install playwright test`：17 passed、4 skipped、1 failed（既有 request failures/skeleton/Markdown 用例 30 秒超时）。4 项为原有开发专用/未开放安装验证的评分测试；不宣称整套全过。M2 Runs 的 3 项安装版测试通过。
- 用户授权真实条件：直连、software engineer、San Francisco, CA、25 miles，每平台目标 1 条。测试临时 DB 的运行快照限定每平台 results_wanted=1、max_attempts=1、单任务超时 120 秒，关闭自动评分；没有改变产品默认参数。由 DMG 安装副本的冻结后端 resume 该停止的测试运行，经过真实 spawn→JobSpy→筛选入库→运行完成；cwd=/、PATH=/usr/bin:/bin。
- 真实结果：Indeed 和 LinkedIn 均 succeeded，各 1 条入库、1 次尝试，无缺 JD、无 warnings/429；Indeed 1 次 HTTP、LinkedIn 2 次 HTTP（含详情）。整轮 succeeded，received=2、new=2、filtered=0、scoring.total=0。诊断 frozen=true、arm64、schema=3/WAL、原生 curl 和 SQLite 读写通过。证据 `tmp/m2-live-result.json`、`tmp/m2-live.log`、`tmp/m2-live-stderr.log`，均不入 Git。无私人凭据、代理或付费模型调用。

- 安装版失败单项带 trace 复验仍失败：请求失败后点 Try again，分页实际为 101–125 of 125，断言预期 51–100 of 125（lists.spec.cjs:577）。未改列表分页代码或放宽断言；保留为本轮安装回归未通过项，不能宣称 M2 全部出口无遗留。trace 在 tmp/job-vaccum-app/e2e-results/ 中。
- `node ../../tmp/check-installed.cjs`：临时隐藏本 worktree 的 backend/.venv、backend/src、desktop/src、desktop/dist 后启动安装副本成功，finally 全部恢复；全新数据目录 settings/Locations 显示 19 条，Philadelphia 为 25 miles；640px、reduced-motion 无横向溢出，已检查 tmp/m2-presets-installed.png。验证运行不依赖项目 Python 或源码，使用受限 PATH 与 cwd=/。

本机未签名测试包；未测试第二台物理 Mac，未做签名/公证。M3 UI 与 M4–M7 不在本次范围。先前“未进行 M2 真实抓取/安装包验证”的记录描述当时状态，本轮结果以本节为准；完整安装版回归的单项超时仍须单独记录复验结果。

## 当前交接摘要（2026-10-19）

- 文档管理：按用户最新要求，AGENTS.md 和 dev-docs/ 从本次提交起纳入 Git；.agents/ 仍本地忽略。下方历史记录中的“开发文档仅本地维护”不再是当前规则。

- M0、M1 已完成；M2 第 1 步（检索后端、运行协议、桌面桥接）已通过 PR #2 合入。M3 后端现已实现实际评分与四协议（PR #7）。M2 第 2 步 renderer（Runs 页、手动配置、批次筛选与失效提示）已完成，Runs 页**布局待确认**；M3 Custom/Score/rubric 界面已在 claude/dev-env 本地提交（见上方 M3 前端节），M4 及后续阶段未完成；M2 真实抓取及安装补验结果见收尾记录，完整回归仍有遗留失败。
- M3 后端轮本地验证为 **172 项后端、13 项 Node 测试及类型检查/构建、19 项完整开发版 E2E**，另 M3 桥接 E2E **1 passed**；M2 第 2 步合并该主线后的验证见文末。历史 PR 的 CI/测试只描述当时版本；远端交付按必需 CI 流程确认。
- 最新审阅修复本地验证：**177 项后端、15 项 Node 测试及类型检查/构建、4 项相关桌面 E2E**（Runs、设置、M3 桥接）。没有本轮完整 E2E/安装包/云端 CI 结果；本地提交暂不推送。
- M2 已验证 DMG 安装副本与两平台各 1 条真实抓取，该包基于 db6b470 加 M2 收尾改动，不含后来提交的 M3 审阅修复。真实代理、付费模型、第二台物理 Mac、正式签名与公证仍未验证。既有 E2E request failures / Markdown 场景曾间歇性超时，复验通过，但根因未确认修复。
- 当前仅两个活动目录：`job-vaccum-gui` 使用 `codex/dev`，`job-vaccum-gui-claude` 使用 `claude/dev-env`；main 无目录签出。默认本地提交，获准推送交付后创建/更新 PR 并开启 auto-merge；必需 CI 通过后合并，不绕过保护。
- Python/Node 以项目版本文件为准，使用 uv 独立环境与 npm lockfile；不要求 pyenv，也不限制 uv 下载解释器。当前操作命令见下方「启动、测试和构建命令」。

以下为各次交付的历史记录，未按时间完全排序。历史段落中的“当前”“未推送”“未合并”“未完成”、旧分支/目录及旧环境仅描述当时状态；后续已完成事项以上方摘要及相应补验/合并记录为准，保留原始测试结果，不把历史通过写成本轮重验。

## M3 审阅修复：清理续跑、取消派发与模型凭据（2026-10-19，本地交付）

用户先要求逐项核查审阅发现，合成复现确认后授权修复四项，并明确「先不要 push」。工作区保持 codex/dev；从干净的 25fe8e6 执行 `git fetch origin`、`git merge origin/main`，快进同步 M2 renderer 的 PR #8（db6b470），保留该 Agent 的全部设计与记录。本轮仅后端、main/shared 类型、测试和开发文档修改，renderer/preload/依赖/lockfile/JobSpy SHA/数据库迁移均未改。

- 清理续跑：派发前岗位不存在时，该评分任务记 failed/NOT_FOUND，保留任务 ID 和历史尝试数，不发 LLM、不恢复已清理岗位；循环处理其他待评分任务，正常更新运行统计与终态。测试用真实接收循环和自动留存清理，覆盖 stopped/interrupted × 全部删除/混合存活四种组合，确认 surviving 岗位继续评分、全部缺失时 failed、混合时 partial、后续 Ping 仍响应。
- 取消派发：worker 从阻塞的请求开始通知返回后、真正 transport 前再次检查 cancel；未发请求返回 CANCELLED。worker 结果附实际调用数，由串行写库循环结算最终 attempt_count，避免已排队的开始通知虚增次数；保留此前累计数。已有在途成功/重试/续跑回归继续通过，不改变有限重试、RPM 或 Retry-After 策略。
- 凭据读取失败：main 保留加密文件、私有清除 service 当前模型 Key；不清除在途运行已捕获的凭据。getSettings 返回非敏感配置、has_key=false 及可选 model_key_error（受控 AUTH_ERROR）。无需模型的 preview/start/resume 继续可用；由 service 根据正式配置或原 resume 快照判断是否需要 Key，需要时返回 AUTH_ERROR，其他输入错误仍按原校验返回。jobs.score/model.test 在解密失败时保持拒绝。没有明文回退或自动恢复凭据文件。
- Key 输入：合法单行 Key 去首尾空白后再加密保存；空白和含 CR/LF 的输入仍拒绝。Node 和真实 Electron→Python→本地 HTTP 测试均检查实际使用的 Key 无首尾空格/制表符。

CONTRACTS 与 shared.Settings 同步可选 model_key_error；ACCEPTANCE 增加 A15/A16/R14/R15。M3 设置界面尚未实现，本轮只提供可供前端展示的错误字段，不宣称 renderer 已显示新提示。未扩展截图中的可暂缓重构、事件优化、Retry-After 上限或调度公平性建议。

环境：macOS 27.0.1（26A434）arm64，Python 3.13.12 / SQLite 3.54.0，uv 0.13.1，Node 26.12.0 / npm 11.20.0，既定 Electron 44.9.0；复用既有独立环境，未升级依赖。

| 实际命令 / 目录 | 结果 |
| --- | --- |
| backend `uv run --locked pytest -q tests/test_scoring.py tests/test_llm.py` | 60 passed，17.37 秒 |
| backend `uv run --locked pytest -q` | 177 passed，18.64 秒 |
| desktop `npm test` | 类型检查、生产构建、15 Node tests passed，Node 测试 12.12 秒；含加密不可用/解密失败、原快照判定、无秘密回显和 Key trim |
| desktop `npm run build && npx --no-install playwright test tests/e2e/scoring.spec.cjs tests/e2e/runs.spec.cjs --trace retain-on-failure` | 4 passed，20.0 秒；M2 Runs/设置兼容与真实 M3 HTTP 链路。故意损坏测试目录的加密文件后，配置与 auto_score=false 的预览仍可用；需模型时 AUTH_ERROR，原文件保留，无额外模型请求 |
| 根目录 `git diff --check`；renderer diff | 通过；renderer 无本轮修改 |

测试全用合成数据、fake LLM 或 loopback HTTP；没有真实岗位抓取、代理、付费模型、私人凭据或新安装包验证。按用户要求只本地提交，未 push、未创建新 PR、未触发本轮 GitHub CI；此前远端推送授权不适用于这次修复。

## M3 后端、协议与 main/preload（2026-10-19）

用户授权仅 M3 Python 服务、协议及 main/preload，renderer 交由另一 Agent 并行开发，并明确授权推送、PR、开启自动合并。工作区 `/Users/tim77/PycharmProjects/job-vaccum-gui` 的 codex/dev 从干净的最新 origin/main fb1e0a6 开始；未生成额外 worktree、未修改其他 Agent 的目录，未修改 renderer、依赖声明/lockfile、JobSpy SHA 或数据库表。

交付：

- requests 四种直接 HTTP Custom 适配器：原 Base URL 路径、协议后缀及认证头、非流式最终文本、多块输出与 thinking 排除、空值省略/temperature=0、Anthropic 必填上限及 Gemini model ID 校验；无提供商/模型名适配。错误使用受控脱敏消息，HTTP status 单独返回，不存原始响应。
- 一个 service LLM 线程池/全局不突发限速门，默认并发 1、RPM 10；10/120 秒连接/读取超时、三次预算、5/10 秒退避及可取消的 Retry-After 秒数。连接测试与每次评分/重试共用；fake LLM 只作为测试依赖，可成功、无效、失败或延迟。
- 复用 M2 待评分任务，批次入库后评分与后续抓取重叠；本轮一岗位一任务，只读取固定主体 title/company/description 与运行快照 rubric，不复制 JD、不跨岗位复用。同输入不同 job 仍各自请求。自动评分关闭仍正常完成，历史命中不补评。
- jobs.score 接收去重 1..200 job_ids 或完整 FilterSpec，创建时固定全部匹配集合（验证超过一页）；建立 rescore，与 pipeline 共用互斥。0 分正常成功；重评失败保留旧分/理由/时间/模型。评分只写评分字段，运行中状态/备注修改保留。
- model.test 支持未保存的非敏感模型字段；operations.cancel 取消排队/等待/重试，已发测试结果丢弃，仍占并发直到结束。评分 stop 保存在途成功结果，取消未发任务；resume 跳过成功任务，使用原快照和修正 Key；基础重启恢复回归通过，M4 全故障矩阵仍未交付。
- main safeStorage 加密 model-key.enc（0600），不可用或解密失败清楚报错，无明文回退；私有 internal.credentials 按字段更新模型 Key/代理凭据，不互相清除。新增 preload scoreJobs/testModel/cancelOperation/setModelKey/deleteModelKey，public 仅 has_key。CONTRACTS 已写出命令、事件、输入/错误和前端接法；模型测试成功用 model.test.completed，避免已有 CSV operation.completed 消费方误认导出。

实际验证环境：macOS 27.0.1（26A434）arm64，Python 3.13.12（uv 独立 .venv）、SQLite 3.54.0、uv 0.13.1、Node 26.12.0、npm 11.20.0、Electron 44.9.0。未重装或升级依赖。

| 目录 / 实际命令 | 结果 |
| --- | --- |
| backend `uv run --locked pytest -q` | 最终 172 passed，19.09 秒；四协议本地 HTTP、错误/空/截断/拒绝/超时/重试/脱敏、共享并发/RPM、205 岗位固定集合、抓取评分重叠、停止/续跑/备注并发、真实接收循环响应先于事件、满队列取消不阻塞接收循环 |
| desktop `npm test` | 类型检查/生产构建及 13 Node tests passed；safeStorage 边界使用合成 mock，验证加密不可用、解密失败、重载、删除与不泄露 |
| desktop `npx --no-install playwright test tests/e2e/scoring.spec.cjs` | 1 passed，7.0 秒；真实 Electron/main/preload/Python 与本地 HTTP，实际 safeStorage 加密、测试、0 分提交及删 Key |
| desktop `npm run test:e2e -- --trace retain-on-failure` | 19 passed，56.5 秒；原 18 项与新增 M3 链路，未放宽超时/断言，未加入自动重试 |
| 根目录 `git diff --check` | 通过；renderer diff 为空 |

初次后端回归 114/117 通过，三项失败来自旧 M2 仅登记评分、无 Key 的阶段前提；补入 fake LLM/合成 Key 并更新为评分执行后的断言。新增固定集合用例曾误假设 importer 新增岗位全为 unscored（fixture 自带部分成功分），已改为直接检查 run_jobs 固定集合边界。收尾复核发现取消未发 future 的通知若同步写满 inbox，可能阻塞其消费线程；改为与 worker 一样异步投递，保留响应先于事件，新增满队列回归。172 项最终通过；随后单独 M3 桥接再次 1 passed，7.7 秒。完整 19 项 E2E 是追加该局部修正前的结果，未宣称再次整套重跑。没有修改业务断言以隐藏实现失败。

本阶段提交 6e9ca06 已推送 codex/dev，并创建 [PR #7](https://github.com/cany7/Job-Vaccum/pull/7)，已附加到当前 Codex chat。该 PR 已开启过 auto-merge；为加入最后的取消通知修正暂时关闭，补丁验证/推送后重新开启。最终必需检查、自动合并及 main CI 结果以 GitHub PR/Actions 与本轮交付报告为准，未绕过保护。

限制：没有用户提供的真实模型/网站/代理条件，未访问真实网站、调用付费模型或读取私人凭据；四协议本地 HTTP 通过不代表全部线上模型兼容。M3 renderer 交互、M4 完整故障注入、M5 AI 引导生成、M6/M7 仍由对应阶段交付。未重新打包或验收安装副本，不沿用 M0/M1 安装结果证明本轮版本。

## 环境准备后的修复同步与复验（2026-10-19）

用户告知测试已修复并授权更新 main 与环境 worktree。执行 git fetch origin，主目录 main 使用 git pull --ff-only，codex/migration-dev-env worktree 使用 git merge origin/main，均快进到 ed5c114（远端 PR #1 合并提交）。本次拉取的唯一文件变动为 fff930d：模拟后端启动失败测试的 startupMs 从 100 调整为 1000。

两个目录分别重新执行 `uv run --locked pytest -q` 与 `npm test`：各自后端 **73 passed，2.42 秒**；各自前端类型检查、构建及 **9 项 Node tests 全部通过**（约 12.38 秒）。此前 startup-error 失败已通过此次复验关闭。依赖声明和 lockfile 未变，复用各自独立环境。未运行 UI E2E 或安装包验证，未开始 M2，未自行修改产品代码或测试，未创建提交、推送或合并远端 PR。


## 主目录 main 环境准备（2026-10-19）

用户追加授权为主目录配置开发环境。本轮在 `/Users/mm64/PycharmProjects/job-vaccum-gui` 的 main（bf2b067）操作，仅安装独立依赖及验证，未改产品代码、测试或 lockfile，未开始 M2，未提交、推送或合并。

- 复用已准备的 pyenv Python 3.13.12、Node 26.12.0、npm 11.20.0、uv 0.13.1；环境为 macOS 27.0.1（26A434）arm64，GitHub 访问沿用已验证的 cany7 登录与 SSH origin。
- backend：`uv sync --locked --python "$(pyenv root)/versions/3.13.12/bin/python"` 成功，在主目录创建独立 backend/.venv，未从 worktree 复制环境。保留 python-downloads=never 和 JobSpy 固定 SHA `1988484ac76ff9ae57784750346842e967e8ba10`。
- backend：`uv run --locked pytest -q`，**73 passed，6.05 秒**。
- desktop：`npm ci` 成功，安装 319 个包；既有 8 项 moderate 漏洞，未升级依赖。
- desktop：`npm test` 类型检查、构建通过，**8 passed / 1 failed**（11.44 秒）。与独立 worktree 相同，`startup-error produces visible startup failure`（tests/backend.test.cjs:26）在 startupMs=100 时先触发超时，消息未匹配预期 BUSY。未修改测试或实现，不标记为全部通过。
- 未运行 UI E2E 或安装包验证。跟踪文件保持干净；本节仅为本地忽略的环境与验证记录。


## M1 完成时的进度摘要（历史）

2026-10-19：**M1 第 3 步（列表与业务界面）完成，M1 三步全部交付**。之后的界面微调：Searches 选中常驻底色、搜索框与状态圆点不再被裁切、齿轮设置图标、详情浮层只留左侧阴影、提示条最多 2 条（d5bfd33）；详情抽屉可拖动调宽（最小 320px，宽度共用并保存）、侧边栏开关位置固定（707cd55 详情抽屉、020cd5e 开关位置；原误提交 51b249a 已拆分重写并强制推送）。改后 17 项 E2E 中一次整套运行有 1 项（request failures…）超时，单独和整组重跑均通过，视为偶发。Jobs／Shortlist 共用表格、筛选行、详情抽屉、提示条、导出对话框、Settings › Searches／Data 已接真实后端；73 项后端、9 项 Node、17 项开发版 E2E 通过，新 arm64 DMG 安装副本 14 项 E2E 通过（3 项仅开发环境导入场景按设计跳过）。run_ids 批次筛选、Runs、Score 菜单仍按计划留 M2／M3。详见文末「M1 第 3 步」。

第 1、2 步汇合及补验记录（历史）：合并基线 97d1744，73 项后端、9 项通信、10 项开发版 E2E 通过，当时 DMG 安装副本 7 项 E2E 通过并通过冻结后端合成业务验收；原生红绿灯由用户确认正常。

以下 M0 记录为历史：

2026-10-18：**M0 完成**，本轮按用户授权接续 Claude 未完成的前端，未进入 M1。接手时只有未提交的 `desktop/src/renderer/{App.tsx,api.ts,main.tsx,styles.css,index.html}`，没有 main/preload、运行脚本或完整安装包；这些已有界面被保留并接入真实后端。

后端基础提交：`9da24e0 feat: add M0 backend service and arm64 packaging foundation`。本轮完整桌面/打包提交见下方交接记录；不推送。AGENTS.md 与 dev-docs 按约定仅本地维护，不强制入库。

## 设计评审决定（2026-10-18；M1 范围已实现，批次筛选、Score 菜单、引导、后台图标随 M2–M7 实现）

M1 前的产品设计调整，已同步 SPEC v0.5、CONTRACTS、DATA-MODEL、PIPELINE、ARCHITECTURE、IMPLEMENTATION-PLAN、ACCEPTANCE：

- Discover 与 Applications 统一为紧凑行列表＋详情抽屉，JD 以 Markdown 渲染；新增英文状态文案。
- 批次筛选：下拉多选抓取运行＋All，只显示在所选运行首次发现的岗位（run_jobs.is_new），FilterSpec run_id → run_ids[]。
- 手动评分扩展到两个池子：工具栏 Score 菜单（勾选 / 当前筛选全部，先确认数量），命令 applications.rescore → jobs.score。
- 引导各步可跳过；评分模板为空时自动评分只能关闭。
- 后台呈现：Dock 图标仅窗口打开时显示，菜单栏图标默认显示且可关闭，运行中退出需确认。
- 保持不变：留存期仍按首次发现时间计算；Discover 不加「不感兴趣」标记。
- M1 UI：M0 诊断移到 Settings › About，按钮分主次，启动失败改为整窗口错误页。

## UI 设计决定（2026-10-18 第二轮；已在 M1 实现，Runs 入口随 M2 加入）

在设计画布上讨论 M1 界面后确定，已同步 SPEC v0.6「窗口布局与列表」、CONTRACTS、DATA-MODEL、ARCHITECTURE、IMPLEMENTATION-PLAN（M1）、ACCEPTANCE（B01、B09–B12、D18、D19）、DATA-MODEL 状态枚举。M1 界面原型及细节图在设计画布（仅本人可见）：https://claude.ai/artifact/5ByVdzguJxgv5XBswmV2Y7

- 浅色为主；隐藏原生标题栏，顶栏横跨窗口（红绿灯、侧边栏开关、页面名、操作按钮）；顶栏下方侧边栏灰底铺满，主区域为圆角卡片。
- 侧边栏顶部搜索（标题、公司、地点），方向列表在侧边栏；可折叠为约 52px 窄条，折叠后点搜索图标或 ⌘F 弹出搜索框、悬停 Searches 图标弹出方向列表；折叠开关在顶栏红绿灯旁。
- 操作按钮在顶栏（Jobs 唯一主按钮 Add to Shortlist）；卡片顶部筛选行为可移除的筛选标签、+ Filter 与 Columns ▾。
- 窄窗口（< 约 1100px）：侧边栏自动折叠，详情改为浮层；最小宽度 640。
- 两页共用表格组件：单行、不分组、不折行；评分色块；公司单独一列；理由单行截断，完整内容看详情；方向列写全部方向名且不自动隐藏。
- 列宽可拖、列可显示／隐藏、超宽横向滚动；列布局和侧边栏折叠状态存本机 UI 偏好。
- Shortlist 仍为表格，只是另一个池子，多 Status、Notes 列。
- Shortlist 增加批量改状态：工具栏 Set status ▾，命令 applications.set_status（ACCEPTANCE D18）。
- 点击列表头排序；sort 白名单增加 location、job_type 及清单 status（ACCEPTANCE B10）。
- 界面改名：Discover → Jobs，Applications → Shortlist，Directions → Searches（Runs、Settings 不变）；内部标识不改。上方第一轮记录里的旧名保留原样。
- 清单状态改为 New、Applied、OA、Interviewing、Offer、Rejected、Ghosted（枚举 new/…）；去掉 Closed 和 Not interested（不想要的直接移出）。
- 搜索暂不包含 JD 正文，只搜标题、公司、地点。
- 理由长度之后由用户调整评分模板控制，应用不做额外处理。
- M1 分三步交接（外壳改造 → 后端 → 列表与业务界面），prompt 见 dev-docs/M1-HANDOFF.md；设计画布的静态导出在 tmp/m1-design/（仅本地，未入库）。
- 默认窗口 1280×800；M1 不显示 Runs 入口，M2 加入。
- 筛选行：左侧选择按钮（点方框全选/取消全部，▾ 按条件勾选当前页，不含 None）与「N selected」；筛选标签后有 Clear all；右侧分页「1–50 of 214 ‹ ›」，点数字选每页 50/100/200。
- 移出清单不弹确认；右下角小号黑底提示条带 Undo 链接（⌘Z 同效），批量改状态同样可撤销；新增 applications.restore，remove/set_status 返回修改前数据。确认框只留删除搜索和清理岗位数据。
- 导出对话框：格式切换（仅一种格式时隐藏）+ 共用范围 + 格式选项，便于以后加其他导出格式；首版只有 CSV。
- Settings：卡片内左侧分区目录，M1 为 Searches、Data（含清理预览）、About（M0 诊断移入，Ping 仅开发构建）。
- Shortlist 详情：状态下拉、多行备注（失焦或 ⌘↩ 保存）；表格内可直接改状态、双击编辑备注。
- 空状态与错误：骨架加载、两种空结果文案、请求失败横幅可重试、后台退出和启动失败只给 Quit；错误先写原因，代码小字在后。
- 配色：三套主题 Graphite（默认）、Pine、Ink，各有浅色和深色版；浅色和深色模式各自选主题，可自由组合；模式 System／Light／Dark（默认 System），在 Settings › Appearance 设置，存本机 UI 偏好。状态与分数颜色三套共用、各有含义（New 浅青、Applied 蓝、OA 紫、Interviewing 琥珀、Offer 绿、Rejected 红、Ghosted 灰），色值见 SPEC 配色表（ACCEPTANCE B12）。画布中除配色画板外的细节图仍为旧蓝色，实现以 SPEC 为准。

## M0 实际交付（历史）

- Python 3.13 独立包，UTF-8 JSON Lines protocol v1，ready/app.status/app.ping/app.diagnostics；入口校验、受控错误、stderr 日志、1 MiB 行限制。
- 数据目录进程锁，SQLite 外键/WAL/5000ms busy timeout、显式迁移事务；001 只建 schema_version/settings，失败回滚，未来版本拒绝，不删库重建。此阶段接收循环是唯一数据库写入口。
- 真实 Electron main，产品单实例锁，绝对路径无 shell 启动一个 service；流式 UTF-8 分块/多行解析、ready 版本检查、请求 ID 匹配、启动/请求超时、进程退出结算。无自动重启、重发或操作重放。
- 具名 preload 白名单，sandbox/contextIsolation 开启，Node integration 关闭；验证 IPC 来自当前主窗口主 frame/已知文件。限制导航/新窗口/webview，CSP 不允许联网和内联脚本，默认拒绝权限请求。
- React 最小英文窗口、系统字体与间距变量、真实连接/空闲状态、Ping、离线诊断；启动错误/崩溃/加载/请求错误反馈。读过并应用两个本机 Apple/Emil skills；没有新业务页面、主题切换或动效依赖。
- 关闭窗口保留 main/service；Dock activate / Show Job Vaccum 重开同一后端，显式 Quit/Cmd+Q 关闭 stdin，等待 10 秒，必要时 SIGTERM/1 秒后 SIGKILL，再有限等待退出。没有提前实现 M7 调度。
- arm64 PyInstaller onedir 完整收集，electron-builder 白名单打包 `.app` + DMG。App 内 backend 与 _internal 在 Resources/backend，数据放 Electron userData，均无产品运行中的开发机绝对路径。

## M0 环境与构建产物（历史）

- macOS 27.0.1 / build 26A434，arm64。
- pyenv Python 3.13.12、uv 0.13.1；backend/.venv；python-downloads=never。JobSpy 固定 SHA `1988484ac76ff9ae57784750346842e967e8ba10`，包版本 1.3.0 未替代 SHA。
- pandas 3.0.6、curl_cffi 0.16.3、SQLite 3.54.0、libcurl 8.21.0；PyInstaller 6.22.3/hooks-contrib 2026.8。
- Node 26.12.0 / npm 11.20.0；既定 TS 7.0.2、React 19.3.1、Vite 8.3.4、Electron 44.9.0 未升级。
- 本轮仅新增必要构建/测试依赖 electron-builder 26.15.3、@playwright/test 1.64.1，package-lock 同步。无浏览器下载，直接用 Electron 测试。
- `job-vaccum-app/release/mac-arm64/Job Vaccum.app` 约 365 MiB；`job-vaccum-app/release/Job-Vaccum-0.1.0-arm64.dmg` 约 155 MiB；产物均被忽略。
- App Info.plist 声明最低 macOS 15.6（随包 Python dylib 的 minos）；仅实测 27.0.1，不能宣称其他版本已验证。Electron 本身 minos 13.0。

## 启动、测试和构建命令

以下从仓库根目录开始，各代码块单独执行；更多接口说明见 backend/README.md、desktop/README.md。

```sh
cd job-vaccum-app/backend
uv sync --locked --python "$(cat ../.python-version)"
uv run --locked pytest -q
```

```sh
cd job-vaccum-app/desktop
npm ci
npm run dev
```

`dev` 先检查并构建再开 Electron，没有 HMR；改代码后重开。开发数据在忽略的 `tmp/job-vaccum-app/desktop`，正式 App 在 `~/Library/Application Support/Job Vaccum`。`npm start` 打开已有构建。

```sh
cd job-vaccum-app/desktop
npm test
npm run test:e2e
npm run package:mac
```

`npm test` 构建后执行 Node tests，`test:e2e` 构建后执行 Playwright Electron。`package:mac` 构建全部前后端和 DMG；`package:dir` 只做完整 App。日志本次保留在忽略的 `tmp/m0-desktop-package.log`。

已安装 App 的窗口测试（绝对路径替换为安装位置，不执行 build）：

```sh
cd job-vaccum-app/desktop
JV_EXECUTABLE="/absolute/install/Job Vaccum.app/Contents/MacOS/Job Vaccum" npx --no-install playwright test
```

已有无窗口协议冒烟也仍可用，见 backend/README.md 及 `job-vaccum-app/tests/electron-backend-smoke.cjs`。

## M0 实际验证结果（历史）

| 验证 | 结果及边界 |
| --- | --- |
| Python pytest | 24 passed，0.68 秒；迁移/事务/持久化、输入错误、真实子进程分块 UTF-8、锁及异常退出、EOF、数据库损坏 |
| TS main/preload/renderer + Vite | typecheck/build 通过；TS7 已移除 node10 resolution，采用 Node16/CJS（sandbox preload 仅 require Electron） |
| Node 通信测试 | 9 passed，约 11 秒；Unicode、多个/乱序响应、版本错误、无 ready、启动 BUSY、畸形/超大 stdout、退出/超时迟到结果、Quit 结算。无 ready 测试实际覆盖 10 秒后终止 |
| 开发 App 窗口 E2E | 4 passed，4.0 秒；真实 Python ping/原生依赖/SQLite、最小宽度 640/长字符串、键盘 Tab/焦点、reduced-motion、重复实例、关窗重开相同 backend PID、退出无遗留 backend、损坏库启动错误、SIGKILL 错误与旧状态保留 |
| UI 受控状态 | 4 个场景中的一个在 Electron IPC 边界注入 starting 与 800ms 延迟/错误，检查 Loading/disabled/错误文本/保留输入；明确为合成 UI 状态，不冒称真实业务失败。真实后端入口校验另经集成测试返回 VALIDATION_ERROR |
| arm64 安装包 | `npm run package:mac` 成功；`file` 验证 Electron/后端/native curl 为 arm64；App.asar 仅 dist、package.json 和必要运行依赖，无 repo/dev-docs/tests/私有数据 |
| DMG 安装隔离 | hdiutil 只读挂载 DMG，ditto App 到 `tmp/job-vaccum-app/M0 installed app/Job Vaccum.app`，卸载卷后运行。临时改名隐藏 backend/.venv、backend/src、desktop/src、desktop/dist，finally 恢复；App cwd `/`、PATH `/usr/bin:/bin`、含空格安装/数据路径；同一套 4 E2E 全过（5.8 秒），诊断显示 frozen/Bundled，原生 curl 加载及 SQLite 写读回滚成功 |
| 默认正式数据目录 | 另启动安装副本不传 data-dir，实际 app.isPackaged=true、userData 为 `~/Library/Application Support/Job Vaccum`；诊断成功；原生标题栏/AX 结构检查通过；实际发送 Cmd+Q 后 App 退出，ps 无本 App/backend 遗留 |
| 视觉检查 | 实际查看连接成功、640 宽长文本与焦点、启动失败、starting/loading/请求错误截图；无水平溢出，页面可滚动，原生窗口/标题栏可用。截图/合成数据留在忽略的 tmp/job-vaccum-app，未声称业务岗位列表已验收 |
| npm audit | 生产依赖 0 项；全部依赖报告 8 项 moderate，来自 electron-builder 开发工具的传递链。未用 force 自动升级/降级既定依赖；公开发行前复核 |

前端局部审阅（保留 Claude 既有设计）：

| Before | After | Why |
| --- | --- | --- |
| dark + increased contrast 仍使用浅色用的灰字 | 加深色高对比 token | 保持可读性 |
| 键盘按下按钮也 scale | :active 排除 focus-visible，reduced-motion 保留颜色/透明反馈 | 高频键盘操作不位移 |
| renderer 内独有 API types | 移到 shared，由 main/preload/renderer 引用 | 同一协议契约，不另建 schema 工程 |

## M0 交付时的限制与下一阶段（历史）

- M0 出口已满足当前开发 Mac 的等效独立安装验证；**没有第二台干净物理 Mac**，没有 Developer ID 签名/公证，仍是本机测试包。使用默认 Electron 图标；公开发行、完整第三方许可清单和最终发行检查在 M7。
- 没有 M1 岗位/清单/方向/CSV/清理；settings 暂无读写 API，没有配置引导、抓取、LLM、计划调度及业务中断恢复。app.status 的 None/Not configured 是此阶段真实状态。001 不补塞业务表，M1 新迁移追加。
- 仍须保持网络在事务外、业务数据仅 Python 写，M2 fake scraper/M3 fake LLM 按后续阶段实施；不从旧项目取凭据。本次未读改旧私人项目、未抓网站、未调付费模型。
- M0 协议没有新增业务命令；CONTRACTS 已补齐桌面超时/生命周期实现说明。下一阶段简短 prompt 见 `dev-docs/M0-HANDOFF.md`；开始 M1 仍需用户授权。

## M0 本轮提交（历史）

本地提交：`fa491d0 feat: complete M0 desktop integration and arm64 app packaging`。源码、配置、lockfile、测试、模块 README 已入库；提交后跟踪工作区干净。此状态及其他 dev-docs 仍只在本地维护；未推送。


## M1 原型讨论

2026-10-18：按用户要求创建 Pages 中的 M0 定位说明与 M1 可点击 UI 原型：https://chatgpt.com/space/page_ebdfa00c67e0819197dc6182ba50a64b 。包含 Discover、共用详情、Applications、方向维护、清理及 CSV 范围；虚构数据与本地模拟交互，无产品代码变更，不表示已实施或授权实施 M1。已在本地沙箱预览检查宽/窄布局、当前页全选、批量加入防重反馈、备注保存、导出跨页计数、0 天关闭清理与清理保护确认。Page 已保存原生可交互 embed；仍等用户反馈确定方向。

同日按用户要求在同一 Page 添加“顶部导航与独立阅读页”第二套原型，原侧边导航方案及其状态保留。新方案演示全宽列表/申请表格、筛选与分页、当前页批量加入、独立 JD 阅读、上下岗位切换、返回列表、状态与备注、设置和 CSV 范围；连续审阅与位置保持仅提前用于布局讨论，不变更阶段验收范围。使用虚构岗位，未修改应用代码或确认工程设计。通过 Visualize render.py 生成本地沙箱预览并用 CUA 实际检查默认宽度、360/320 像素窗口（根元素无横向溢出）、空结果、5 项批量加入（4 项新增、1 项保留）、备注保存与状态同步、保留天数错误/0 关闭、跨页 8 项含 JD 导出预览；修复本地状态回传覆盖保存反馈的问题。Page 写入回执及回读确认双 embed、独立文件引用和全宽元数据；桌面应用的 Page 视图受工具访问限制，未宣称已检查云端实际渲染。本轮仅原型与忽略的状态记录，无新增源码提交；M0 提交保持 fa491d0，未启动 M1。


## M1 第 1 步：外壳与 M0 界面改造（2026-10-19）

本记录从 m1-shell worktree 的 tmp/M1-STEP1-STATUS.md 迁入；该临时文件现仅保留迁移指引，不另存第二份状态文档。分支基于 M0 fa491d0，交付提交为 `4d6c9f4 feat: M1 app shell with sidebar, themes and Settings`，窄窗口折叠修复为 `d097fa0 fix: save sidebar collapse made in a narrow window`，均已随本轮汇入 main，未推送。

以下测试、打包和视觉结果沿用分支交付记录，不表示本轮合并后重新执行。第 1 步保持后端不变；汇合后使用第 2 步的 schema 2 与完整具名业务接口。列表、搜索和业务控件仍属于第 3 步。

### 实际交付

- main：默认 1280×800、最小 640×480；`titleBarStyle: hiddenInset`，`trafficLightPosition {x:18, y:17}` 对齐 48px 顶栏；窗口底色按系统深浅色取侧边栏色。保留单实例、关窗驻留、有界退出与 IPC 发送方校验（校验抽成 `assertSender`）。
- 新增具名 preload 方法：`quit()`（走现有 before-quit 有界退出）、`showDataFolder()`（`shell.showItemInFolder(dataDir)`，不接收路径参数）。另加只读 `getAppInfo()` 返回 version/arch/packaged/data_dir（数据目录仅用于显示，家目录写作 `~`）：About 需要显示版本与数据目录、启动失败页需要显示数据目录、Ping 需按 `app.isPackaged` 只在开发构建显示，renderer 无其他来源。不暴露任意路径或命令。
- renderer 外壳：顶栏（红绿灯留位、侧边栏开关 ⌃⌘S、页面名、右侧操作区占位，整条为拖拽区，按钮 no-drag）；侧边栏展开 200px／折叠 52px 窄条，含搜索框、Jobs、Shortlist、Settings 和后台连接状态；不显示 Runs、不显示 Searches 区（第 3 步）。窗口 <1100px 自动折叠（不写偏好）、拉宽恢复；任何宽度下的手动展开/折叠都存本机 UI 偏好，窄窗口中手动展开只在拉宽前临时生效（审阅 P2 修复：原先窄窗口中的手动折叠未保存，拉宽后会恢复展开）。主区域为圆角卡片。
- Jobs／Shortlist 显示 SPEC 空状态文案（No jobs yet／Your Shortlist is empty）。**列表、筛选行、详情抽屉在第 3 步实现。**
- 侧边栏搜索框（含折叠窄条的搜索图标）本步为禁用占位，⌘F 与弹出框在第 3 步接数据时实现。
- Settings：卡片内左侧分区目录，本步只有 Appearance 与 About。Appearance：模式 System／Light／Dark（radio 组），浅色、深色主题各自从 Graphite／Pine／Ink 选（带固定配色缩略图），存本机 UI 偏好（renderer localStorage `jobVaccum.ui`，位于 userData），即时生效，System 跟随 prefers-color-scheme 变化。About：版本、Backend、数据目录（Show in Finder）、Database（app.status 的 schema/journal，失败可重试）、Ping（仅开发构建）、Run diagnostics。M0 的 Connection／Status／Diagnostics 卡片面板已删除。
- 样式：按 SPEC 配色表以 `<html data-scheme data-theme>` + CSS 变量实现 3 主题 × 浅/深色；增强对比度（prefers-contrast: more）加深边框和次要文字；状态、分数、提示条颜色变量已定义供第 3 步使用（Pine 浅色的 6–7 分为青灰，取自设计画板）。去掉 M0 亮蓝。按钮分描边默认按钮与唯一实心主按钮（`.button-primary`）。保留焦点环、reduced-motion（只保留 opacity 过渡）和长文本换行。侧边栏切换、主题切换均无动效。
- 设计画板浅色次要文字 #76767b 等在侧边栏底色上仅 3.4–4.2:1，不满足 SPEC 4.5:1；改为 Graphite #5e5e63、Pine #5a605b、Ink #575d68（在侧边栏、选中导航、勾选行底色上均 ≥4.87:1）。深色主题、状态与分数色值按 SPEC 原值，对比度均 ≥4.7:1（脚本计算）。
- 错误状态：启动失败为整窗口页（无侧边栏，保留顶部拖拽条）：先写原因和处理办法，再显示数据目录与 Show in Finder、Quit Job Vaccum（默认焦点），错误代码小号灰字在最后。后端启动失败只有 stderr 文本（如 `ERROR BUSY: …`、`ERROR STARTUP_ERROR: …`），renderer 识别 BUSY／STARTUP_ERROR 给出可读说明，其他 Electron 侧消息原样显示；后端未修改。后台意外退出：卡片显示 "Job Vaccum's backend stopped" 与 Quit（alertdialog，聚焦 Quit），侧边栏 inert 并变淡、顶栏开关禁用，代码 `BACKEND_EXITED · code/signal` 在最后。未做提示条、骨架行等本步未用到的组件。
- 顺带修复：`playwright.config.cjs` 的 outputDir 原为 `../../../tmp`，实际写到仓库外 `~/PycharmProjects/tmp`；改为仓库根忽略的 `tmp/job-vaccum-app/e2e-results`。
- desktop/README.md 同步。

### 分支交付时记录的命令与结果（macOS 27.0.1 arm64，Node 26.12.0，Python 3.13.12）

worktree 准备：`uv sync --locked --python "$(pyenv root)/versions/3.13.12/bin/python"`；`npm ci --prefer-offline`（npm 未执行 electron 安装脚本，另行 `node node_modules/electron/install.js` 从本机缓存取得 Electron 44.9.0 二进制；依赖与 lockfile 未变）。

| 命令 | 结果 |
| --- | --- |
| `npm test` | 9 passed（Node 通信测试，未改） |
| `npm run test:e2e` | 7 passed，约 11 秒（开发构建） |
| `uv run --locked pytest -q` | 24 passed（后端未改） |
| `npm run package:mac` | 成功；DMG 约 155 MiB，日志 `tmp/m1-shell-package.log`（位于 m1-shell worktree，2026-10-19 合并后随 worktree 删除） |
| DMG 安装副本 E2E | hdiutil 只读挂载，ditto 到 worktree 的 `tmp/job-vaccum-app/M1 installed app/`（已随 worktree 删除），卸载后 `JV_EXECUTABLE=… npx --no-install playwright test`：7 passed；Ping 行在安装副本中不显示（packaged） |

E2E 覆盖：窗口 1280×800／最小 640×480／`getWindowButtonPosition()={18,17}`、顶栏 drag 与按钮 no-drag；外壳渲染与两页空状态、无 Runs；About 真实 status/诊断/Ping；preload 键白名单、ping Unicode 与 VALIDATION_ERROR；单实例、关窗重开同一 backend、Quit 无遗留；折叠＋重启保持、展开＋重启保持；1000 宽自动折叠、拉宽恢复、手动折叠拉宽后仍折叠、1000 宽内先展开再手动折叠拉宽后仍折叠（该用例在修复前代码上失败）；模式与主题切换即时生效、浅深主题互不影响、System 跟随 emulateMedia、重启保持、状态色三主题一致、增强对比度变量变化；640 宽三页及 About 诊断无页面级横向溢出、窄宽临时展开；键盘 Tab 到模式 radio 与按钮的焦点环、方向键切换模式；reduced-motion 只剩 opacity 过渡；损坏库启动失败页（原因在代码前、默认焦点 Quit、点击后进程退出）；SIGKILL 后端后阻挡界面、侧边栏 inert、只有 Quit 且点击后退出；注入 starting/延迟/超时错误状态。

### 分支交付时记录的视觉检查

- 实际查看 Playwright 截图：Jobs、Shortlist、Settings › Appearance／About（1280 宽），折叠窄条、640×480 About/Shortlist，Graphite／Pine／Ink 的浅色与深色（Appearance 页与 Jobs 页），启动失败页，后台退出页，starting／loading／请求错误。
- **未完成：** 原生红绿灯与标题栏的像素级目视检查。Playwright 截图不含系统绘制的红绿灯；`screencapture -l` 无屏幕录制权限失败；用 computer use 截图安装副本的请求被拒绝。目前只有 API 层证据（hiddenInset、按钮位置 {18,17}、顶栏为拖拽区）。需人工打开安装副本确认红绿灯竖直居中于 48px 顶栏且不压住侧边栏开关。

### 修复与剩余项

窄窗口内手动切换现在也保存 sidebarCollapsed，自动窄窗口折叠不改偏好；已增加“1000px 手动展开后折叠，再拉宽仍折叠”的回归断言。原生红绿灯的目视检查仍未完成，不能用 API 位置断言或 renderer 截图代替。getAppInfo/quit/showDataFolder 已在 CONTRACTS 补齐，原记录中待汇入文档的事项已处理。

## M1 第 2 步：后端数据与协议（2026-10-19）

以下为第 2 步独立交付时的历史记录；其中“未合并／renderer 未改”的描述仅指该次交付，不代表当前 main。

### 授权与范围

- 用户授权 M1-HANDOFF 第 2 步。第 1 步由 Claude 在另一 worktree 并行实施；本步仅 Python/storage/service、Electron main/preload/shared types 以及对应测试和模块 README，未改 renderer、未替换外壳、未擅自合并其他 worktree。
- 用户已明确确认：run_ids 批次筛选留 M2，不提前建立运行表。M1 非空 run_ids 返回可读 VALIDATION_ERROR；空数组为 All。CONTRACTS、DATA-MODEL、IMPLEMENTATION-PLAN、ACCEPTANCE、M1-HANDOFF 已同步本地约定，未强制加入 Git。

### 实际交付

- 002 从已有 001 迁移，不删库重建；jobs、job_identities、directions、queries、job_directions、applications，7 个清单状态和 5 个评分状态、分数整数约束、外键级联和所需索引。
- repository 与 jobs.list/detail；多维 FilterSpec（run_ids 除外）、参数化 SQL、排序白名单、NULL 始终在后、ID 稳定次序、同一快照 items/total；多方向/来源 EXISTS 不放大分页，摘要不读返 JD。发布时间保留来源日期精度，不用发现时间代替。
- applications.add/add_many/update/set_status/remove/restore；短事务、防重、逐项失效反馈，批量出错整笔回滚；撤销移出恢复完整原字段，撤销改状态只恢复 status/updated_at，不覆盖后来备注，不存撤销历史。
- directions.save/delete/reorder 与 queries.save/delete，settings.get/save 的 M1 retention_days 配置和方向/query 返回。改名即时显示，方向删除清理 query 标签/关系而保留 jobs/来源；只删 query 保留已命中文本。
- cleanup.preview/execute；自动启动检查和运行期间 60 秒检查，可注入时钟，当前配置/严格 cutoff/0 关闭，清单保护在写事务重新检查。App 自有 tmp 启动清理独立于留存，logs/tmp 文件失败报告 failed_files；数据库提交不回滚，不遍历外部符号链接，不创建待删恢复表。
- export.csv：UTF-8 BOM、可选完整 JD、评分时间及薪资单位、方向/来源一行、清单状态备注及时间；filtered 覆盖全部页，all 仅按 scope 导出。独立只读 WAL 快照线程流式写 CSV，不阻塞主接收循环；operation_id、完成/失败事件、app.status.operations，导出期间 cleanup/第二个 export 返回 BUSY。
- main 原生保存面板产生一次性 token；renderer 无任意路径/命令入口；main 私下解析 destination_path，拒绝 App 数据目录内目标，Show in Finder 仅接受本会话成功导出的 token。onServiceEvent 具名通知，仍需查询当前数据。
- 显式开发标志启用的公开合成岗位导入（默认 125 条）：2 个方向、query、多来源、空分/0 分及长 JD；再次导入不覆盖正文/首次发现/评分/清单。开发 Electron 开启，packaged main 与 frozen Python 都拒绝导入。不是 M2 抓取与去重实现。
- 自动清理需要接收循环可在无请求时唤醒；新增专用输入线程，数据库及协议输出仍只由服务循环操作。修复输入线程占用标准 stdin 缓冲锁导致 SIGTERM 退出异常，现有真实进程关闭/崩溃/锁测试已通过。

### 实际验证环境与命令

环境保持既定版本，无依赖或 lockfile 变更：macOS 27.0.1 build 26A434 arm64，pyenv Python 3.13.12，SQLite 3.54.0，uv 0.13.1，Node 26.12.0，npm 11.20.0；Electron/TS/React/JobSpy SHA 保持原锁定值。测试默认禁止网络，仅合成岗位，无私人项目/凭据/真实网站/付费模型。

从 backend 执行：

```sh
uv run --locked pytest -q
```

最终 **65 passed，1.08 秒**（原 24 项 + 41 项 M1 测试）。覆盖 M0 空库/重启与 001→002 保留配置、迁移 002 失败回滚、约束/外键；过滤/分页/NULL 与状态排序；重复及并发加入、批量事务失败回滚、状态与备注并发修改；两种撤销和已删除岗位；方向维护；严格留存边界、0/自定义/重启/下一次检查、清单保护、过时预览及加入竞态、文件失败后已提交数据保留、外部文件保护；125 条全页 CSV/多方向不重复/BOM/长 JD/清单字段；真实服务事件、异步导出失败/接收响应性/BUSY、启动与周期清理、开发/frozen 导入限制。

从 desktop 执行：

```sh
npm test
npm run test:e2e
```

最终 **9 Node 通信测试通过（约 11 秒）**；TS main/preload/renderer typecheck 与 Vite 构建通过；**5 Electron E2E 通过（5.3 秒）**。原 4 个窗口测试保留（只适配 schema=2 和新增具名 API 清单）；新增 1 个 M1 真实桥接场景，验证合成导入、列表/清单/Undo、125 条导出、token 一次性/伪造路径拒绝、导出后 Finder 令牌、保存面板取消、拒绝写 App 数据目录、退出重启保留配置及清单。仅系统保存面板与 Finder 打开动作为测试替身，CSV 和后端实际执行。没有增加产品测试钩子。

`git diff --check` 通过；renderer 路径 diff 为空。没有新增 UI，未宣称已检查 M1 表格、主题、外壳或窗口设计。

### 验收限制与后续汇合

- 本步数据与协议已完成；第 1 步由另一 worktree 的 Claude 完成后再汇合，第 3 步接真实业务界面。M1 的 B09–B12 和岗位/清单 UI 出口未由本步验收，不能写成 M1 全阶段通过。
- runs/run_tasks/run_jobs 和 schedule_firings 仍属于 M2/M7；清理中 runs 数为 0，不创建占位表，不声称已验证 D02/D07/D10 的真实运行行为。D15/D16 在本步覆盖岗位和 App 自有文件，运行/计划记录随后接入统一 retention。D01 仅为稳定合成实体的多关系集合；真正抓取身份/内容去重留 M2，真实评分并发留 M3。
- 本步未重打 DMG、未验证安装副本；release/ 仍为此前 M0 产物，不能用于判断本步数据功能。按照第 2 步验收运行开发后端/前端测试；安装包汇合验收按后续步骤执行。
- CSV 失败会发 operation.failed，可能留下部分文件，不自动重试或恢复；文件清理失败返回 failed_files，后续 Data UI 必须显示未完成项。M0 现有日志仍主要走 stderr，测试用 App 自有文件验证期限和失败，不冒称已有运行日志系统。
- 源码、测试及模块 README 单独本地 commit，不推送。dev-docs/AGENTS 继续仅本地维护。

本步本地提交：`cd16158 feat: implement M1 backend data management and named desktop APIs`。提交后跟踪工作区干净；未推送。

## M1 第 2 步问题修复（2026-10-19）

用户报告并授权修复 P1（CSV 外部符号链接绕过数据目录保护）和 P2（合法大列表响应被当作损坏协议终止连接）。修复前已在自动删除的隔离临时库确认：数据库头被 CSV 覆盖后导出才失败；200 条 × 6,000 字节备注的清单响应为 1,347,631 字节，真实 Backend 返回 WORKER_EXITED 并进入 failed。

实际修改：

- main 在发放保存 token 和执行 export 时均解析实际数据目录/目标；已有目标用 realpath，新文件用真实父目录加文件名，token 保存已解析路径。目标不可解析或在真实数据目录内时受控拒绝。Python 接收命令校验及实际导出入口再次解析，禁止在检查前以 w 模式打开文件。无依赖变更、无备份/恢复/重试流程。
- protocol 输出在写入任何字节之前统一序列化检查；正常响应超过 1 MiB 时发送同 request id 的 RESPONSE_TOO_LARGE，保留连接及已有数据，不截断备注、不隐式更改分页、不提高上限。Electron 的真正损坏/超大消息保护保留。
- applications.update 和 remove 的完整响应在事务提交前用同一序列化检查；超限抛出受控错误并回滚该次操作，批量移出不会已经生效却丢失 Undo 快照。
- CONTRACTS、ACCEPTANCE 和模块 README 已同步；未改 renderer，不触碰另一 worktree 的 Step 1。

实际验证（沿用上节 macOS 27.0.1 arm64 / Python 3.13.12 / Node 26.12.0 环境，纯合成数据，无网络）：

- backend：`uv run --locked pytest -q`，**73 passed**。新增文件/父目录链接保护、外部安全目录可导出、worker 接受任务后目标被替换的拒绝、数据库头与查询完整、超大列表及批量移出后状态不丢、较小批量 Undo、中文转义字节和 1 MiB 精确边界、更新响应提交前检查。
- desktop：`npm test`，**9 passed**；typecheck/Vite build 通过，真正 malformed/oversized peer 仍受保护。
- desktop：`npm run test:e2e`，**7 passed，5.8 秒**。两个新增真实 Electron/Python 回归：通过数据目录别名启动，符号链接/父目录/选定后替换目标不能覆盖数据库，诊断与岗位查询成功；200 条 × 6 KB 备注的列表和移出返回 RESPONSE_TOO_LARGE，随后小页/Ping 成功且 connection=ready，移出回滚后 200 条完整保留，50 条移出再 Undo 全恢复。
- `git diff --check` 通过；没有新增界面，本轮未重打 DMG、未做安装包验证。旧 M0 安装产物不包含此修复。

修复本地提交：`dbd5e0d fix: protect CSV destinations and bound business responses`。最终后端 73 passed（1.09 秒）；提交后跟踪工作区干净，未推送。


## M1 第 1、2 步汇合（2026-10-19）

用户授权将 m1-shell 合入 main，并合并文档记录。合并父分支为 main `dbd5e0d` 和 m1-shell `d097fa0`；保留双方原提交及三个问题修复，不 squash，不推送，不开始第 3 步。

实际处理：

- 解决 desktop/README.md、main/index.ts、shared/api.ts、tests/e2e/desktop.spec.cjs 四个冲突。main 同时保留窗口外壳／getAppInfo／Quit／Finder 与 registerBusinessIpc、开发导入标志和发送方校验；JobVaccumApi 保留 BusinessApi 及三个桌面方法。preload/protocol 的自动合并结果已核对，未丢失双方具名方法。
- E2E 保留 7 个外壳场景及 3 个数据／回归场景（共 10 个，未在合并后执行），白名单取双方方法全集，数据库断言统一 schema 2；后端场景连接状态断言由旧 M0 的 Connected 适配为外壳 Backend ready。
- 第 1 步临时记录迁入本文；原临时文件仅保留已迁移指引。CONTRACTS 增补 getAppInfo/quit/showDataFolder、偏好及 schema/protocol 说明；M1-HANDOFF 补充汇合状态；desktop README 同步组合交付。

本轮检查：

- 首次在仓库根运行 `npm run typecheck` 因该目录没有 package.json 而退出（未运行编译）；随后在 job-vaccum-app/desktop 正确执行 `npm run typecheck`，main/preload/renderer 类型检查通过。
- 在 desktop 执行 `node --check tests/e2e/desktop.spec.cjs`，语法检查通过；此命令没有执行测试。
- 按用户要求未重复运行 npm test、Playwright E2E 或 pytest；未启动 UI、未重新构建 DMG、未验证合并后的安装副本。此前后端修复记录的 73 pytest／9 Node／7 E2E 及第 1 步 24 pytest／9 Node／7 E2E 均为各自分支验证，不作为合并后全套通过的证据。
- 原生红绿灯目视验收仍未完成；列表／Shortlist 业务界面、Searches／Data、筛选与导出 UI 仍留第 3 步。M1 全阶段验收未完成。
- AGENTS.md 和 dev-docs 继续仅本地维护，不强制加入 Git。另一 worktree／分支及其测试产物保留，未删除。

本轮合并提交：`97d1744 merge: combine M1 shell and backend delivery`，两个父提交为 `dbd5e0d`／`d097fa0`。`git diff --cached --check` 通过，无残留冲突标记；提交后跟踪工作区干净。dev-docs 保持 Git 忽略，仅本地保存，未推送。


## M1 第 1、2 步未完成项补验（2026-10-19）

用户要求完成此前未完成项，并明确“不进入第三步”。本轮仅补齐合并后验证、当前 arm64 安装包、安装副本及原生窗口验收；没有修改产品功能、依赖、迁移或界面，没有进入第 3 步。

### 实际验证与结果

环境为 macOS 27.0.1 / 26A434，arm64；沿用既定 Python 3.13.12、Node 26.12.0、Electron 44.9.0、JobSpy SHA 及 lockfile。所有业务测试使用隔离目录及合成岗位，不使用私人数据、真实抓取或付费模型。

| 命令／检查 | 本轮结果 |
| --- | --- |
| backend：`uv run --locked pytest -q` | 73 passed，1.18 秒 |
| desktop：`npm test` | 构建／typecheck 通过，9 Node tests passed，约 11 秒 |
| desktop：`npm run test:e2e` | 合并后首次 10 passed，10.1 秒 |
| desktop：`npm run package:mac > ../../tmp/m1-merged-package.log 2>&1` | 完整 renderer/main/preload、PyInstaller onedir、arm64 App 与 DMG 构建成功 |
| DMG 安装 | hdiutil 只读挂载，ditto 复制到含空格路径，卸载卷后运行；没有从挂载卷运行 |
| 安装副本：`JV_EXECUTABLE="/absolute/install/Job Vaccum.app/Contents/MacOS/Job Vaccum" npx --no-install playwright test` | 首次 6 passed／1 failed／3 skipped；失败在 Quit 后测试 finally 再调用 Playwright process()，应用已退出、进程 channel 已释放，业务断言未失败 |
| 修正测试清理后，同一安装副本执行上述命令 | 7 passed，3 skipped，7.4 秒；3 项开发导入专用用例按设计跳过 |
| 修正测试清理后，desktop：`npx --no-install playwright test` | 开发版完整 10 passed，9.4 秒；没有重新运行无改动的 Python／Node 测试 |
| 安装副本冻结后端合成业务检查 | 通过；见下文，补足安装版三个开发导入用例不能直接执行的业务验证 |
| `file` 检查安装 Electron／冻结服务 | 二者均 Mach-O arm64；随包含迁移 002，诊断 SQLite schema 2／WAL |
| 原生窗口与退出 | CUA 实际查看窗口、浅色 Jobs、深色／折叠 Settings、About；点击离线诊断，Runtime=Bundled、arm64、JobSpy SHA、curl 与 SQLite 写读通过。Cmd+Q 后本次进程退出码 0，ps 无本 App／backend 遗留 |

### 本轮唯一跟踪代码变动

`desktop/tests/e2e/desktop.spec.cjs` 的 launch helper 在启动后保存 Node 子进程引用（ownedProcess），PID、exit 事件和 finally 读取该引用。避免 Quit 后 Playwright 已释放 process channel，再调用 application.process() 导致清理阶段误报。没有修改产品 main/preload/renderer/backend，也没有添加产品测试钩子。此修改只属于前两步既有生命周期测试。

### 安装与产物位置

- 当前 DMG：`job-vaccum-app/release/Job-Vaccum-0.1.0-arm64.dmg`，162,479,617 字节（约 155 MiB）。本机未签名测试包，不作为 M7 公开发行。
- 安装副本：`tmp/job-vaccum-app/M1 merged installed inj3vhtv/Job Vaccum.app`；来自本轮 DMG，挂载卷已卸载。
- 测试均从 cwd `/`、PATH `/usr/bin:/bin` 启动安装程序，使用隔离 data-dir。实际诊断为 frozen/Bundled。本轮没有临时改名隐藏开发源码或 .venv，不冒称再次完成该项隔离实验；此前 M0 的隐藏源码／环境安装验证记录仍为历史证据。
- 手工原生窗口检查数据仅在上述安装目录的 native-data，未触碰正式用户数据；检查后已退出测试 App。
- 构建日志：`tmp/m1-merged-package.log`；E2E 截图与数据仍在忽略的 `tmp/job-vaccum-app/`。

### 冻结后端业务验收

临时验收脚本保存在 `tmp/m1-merged-frozen-check.py`，仅属本机合成测试，不入产品包。复现命令从 backend 执行：

```sh
uv run --locked python ../../tmp/m1-merged-frozen-check.py "/absolute/install/Job Vaccum.app" "/absolute/repository/root"
```

宿主开发 Python 只生成一次性合成数据库（200 岗位、200 条清单、每条 6 KB 备注）；实际被测进程是安装副本内的冻结服务，以 cwd `/`／精简 PATH 独立执行，然后再次启动检查持久化。成功数据目录为 `tmp/job-vaccum-app/M1 frozen data 28t5m_a_/`。

验证冻结依赖／原生诊断、schema 2、禁止开发导入；大列表／大批移出／中文转义响应返回 RESPONSE_TOO_LARGE，保留连接及提交前数据；小页可读；改状态与移出 Undo 保留原管理字段；手动清理保护全部清单；外部符号链接指向数据库被拒绝且数据库头未变；全部 200 条含 JD／BOM CSV、无重复行；重启后 retention=0 与 200 条清单保留。未用开发导入开关绕过 packaged/frozen 限制。

### 原生红绿灯验收结论

CUA 原生窗口截图包含系统绘制的窗口控件；AX 中关闭／最小化／全屏按钮存在，窗口 API 与 E2E 的 hiddenInset／{18,17}／48px 顶栏断言通过；展开和折叠两种顶栏的侧边栏开关、标题可见且无挤压。截图中的 macOS 屏幕共享标识覆盖红绿灯区域，用户在本轮明确确认“屏幕共享的图标遮挡住了红绿灯，是正常的，没问题”。因此该项按原生窗口实际检查及用户确认关闭；不宣称获取了无遮挡的红绿灯像素截图，不修改系统共享指示或原生按钮。

### 当前边界

前两步的合并后测试、安装包验证、原生窗口确认均已完成。第 3 步的表格、详情、Searches／Data、筛选与导出界面尚未开始；M1 全阶段验收仍需第 3 步完成。签名／公证、第二台物理 Mac 和其他 macOS 版本不是本轮交付范围。安装产物与本地工程文档保持忽略，未推送。

本轮测试修正提交：`226b3b0 test: preserve Electron process references after Quit`（main）。产品运行文件与构建 DMG 时的 97d1744 相同，仅 E2E helper 变动；无需因包外测试代码变更重打 DMG。`git diff --check`／`node --check` 通过，提交后跟踪工作区干净；未推送。


## M1 第 3 步：列表与业务界面（2026-10-19）

### 授权与范围

用户在前两步验收合并后授权第 3 步（「你现在开始完成第三步」）。按 M1-HANDOFF 第 3 步在 main 上实施；读过 AGENTS.md、SPEC 相关章节、IMPLEMENTATION-PLAN M1、ACCEPTANCE B01–B04／B09–B12／D18／D19、CONTRACTS、本文件及两个设计 skill（apple-design、emil-design-eng），设计参考为 tmp/m1-design 全部页面（颜色以 SPEC 配色表为准）。未做 Score 菜单（M3）、Batch 筛选（M2）、Runs（M2）。后端未改。

### 实际交付

- 共用表格（JobTable）：单行 34px、粘性表头；点表头排序（评分/时间首次降序、文字升序，再点反向，箭头与 aria-sort），理由/备注/方向/来源/链接不可排序；拖动表头分隔线调宽（拖动时 1:1，松开写偏好）；Columns ▾ 与右键表头勾选列、Reset columns；列总宽超出时卡片内横向滚动；评分色块（8–10 绿、6–7 冷色、0–5 灰、— 未评分、… 排队、↻ 评分中、! 失败，悬停说明）；方向列写全部方向名；Jobs 已加入行标题后有 ✓（In Shortlist）。
- 筛选行：选择按钮（点方框全选当前页／有勾选时全部取消，▾ 按两页各自条件替换勾选：Jobs 为 All、Score 8+/6+、Unscored、Scoring failed、Not in/In Shortlist；Shortlist 为 All、7 个状态、Applied · no update 14+ days）、N selected、Shift 连选、可移除筛选标签、+ Filter（Searches、Score 范围与评分状态、In Shortlist、Status、Company、Location、Type、Source、Found、Posted 含 unknown、Added、Updated、Salary 含币种/周期）、Clear all（仅有筛选时出现）、分页「1–50 of 125 ‹ ›」及每页 50/100/200 与首页/末页、Columns ▾。各编辑器为草稿，Apply/Return 生效，非法输入在编辑器内提示且不应用。换页、改筛选／排序／每页条数时清空勾选并回到第 1 页（侧边栏搜索与方向变化同样处理）。
- 详情抽屉：上一条/下一条（按当前页顺序，边界禁用）、公司/标题/理由/评分时间与模型/失败原因、地点、类型、发布与发现时间、薪资、方向、query、来源、加入与更新时间；Add to Shortlist 或「In Shortlist」、Open posting ↗；Shortlist 另有状态下拉、多行备注（失焦或 ⌘↩ 保存、Esc 放弃，显示 Saved）和 Remove from Shortlist。JD 用 markdown-it（html: false、禁用图片）渲染，链接经 main 用默认浏览器打开。窗口 <1100px 时详情浮在表格右侧，不挤压列。操作后岗位仍在当前结果则保持位置；离开结果时选中原位置的下一条（末尾为上一条）。
- 键盘：↑↓/J K 移动当前行（详情跟随）、Return 打开详情（Shortlist 且显示 Notes 列时编辑备注）、Esc 关闭详情、X 勾选、S 加入清单、O 打开申请链接、? 快捷键帮助；输入框、对话框和有焦点的弹出框内不触发；焦点在按钮或链接上时 Return 交给该控件。高频操作无动效。
- Jobs：顶栏 Export 与唯一实心主按钮「Add N to Shortlist」（未选时禁用，窄窗口为「Add N」）；批量与单条加入都显示新增／已存在／已被清理数量，View 跳到 Shortlist。Shortlist：Set status ▾、Export、Remove N（红字描边）；行内状态下拉选中即保存；表格中双击备注格或 Return 进入单行编辑（Return 保存、Esc 放弃、失焦保存；单击备注格只设当前行，避免第一下打开详情遮住单元格）；批量改状态与移出不弹确认，提示条 Undo 与 ⌘Z 调用 applications.restore，已被清理的岗位单独报告。
- 侧边栏：搜索框（⌘F，标题/公司/地点，边输入边过滤当前页，有关键词时筛选行显示 Search 标签）；Jobs/Shortlist 计数；Searches 区（All searches 及各方向和岗位数，点击设为当前页方向筛选；没有方向时不显示该区）。折叠窄条：搜索图标或 ⌘F 弹出已聚焦搜索框（Esc 或点别处关闭，关键词保留）；悬停/点击 Searches 图标弹出方向列表（含数量与 Edit searches…）。顶栏显示页面名、当前方向和匹配总数。
- 提示条：右下角小号深色，约 8 秒消失，悬停或焦点在其中时保持；可撤销操作带 Undo（⌘Z），导出带 Show in Finder，加入带 View，失败为深红底并写原因与代码。最多同时 3 条。
- 导出对话框：只有 CSV 时不显示格式切换；Jobs 范围（Current filter — N jobs 及条件摘要 · all pages／All jobs — M，Ignores search and filters）、CSV 选项（含完整 JD）；Export… 打开系统保存面板，取消则对话框保留；完成提示条报告条数并可 Show in Finder，失败写明文件可能不完整。导出进行中 Export 按钮禁用。
- Settings：分区为 Searches、Data、Appearance、About（打开默认 Searches）。Searches：表格（拖动手柄或手柄上 ⌥↑/⌥↓ 排序、Rename 需 Save 且空名在输入框下提示、Delete… 确认框：红色 Delete、默认焦点 Cancel、Esc 取消，说明 query 与标签移除、岗位和清单保留）；删除后各页失效的方向筛选移除并提示。Data：保留天数（Save 才写入，非整数/负数在输入框下提示且不保存，0 关闭）、下次自动清理预览（将删岗位数、清单保留数，关闭时说明）、Clear job data… 确认框（预览删除数与保留的清单数，不可撤销，失败文件单独报告）。
- 状态：加载超过 0.5 秒才显示骨架行；「No jobs yet」与「No jobs match these filters」（含被隐藏数与 Clear filters）不同；Shortlist 空状态提示从 Jobs 加入；单次请求失败在卡片顶部显示横幅（原因在前、代码小字在后、Try again）；后台退出与启动失败沿用第 1 步。其他来源的 jobs.changed（如自动清理）显示「Results updated · Refresh」，不自动重排；本窗口自己的修改两页静默刷新。
- 本机 UI 偏好 `jobVaccum.ui` 增加每页的筛选、排序、每页条数、显示的列和列宽（读取时逐项校验；相对时间存天数）；页码、勾选、当前行和滚动只在会话内，两页常驻挂载以在切换页面时保持。

### 契约与依赖变更

- 新增 preload/main 具名方法 `openLink(url)`（仅 http/https，校验发送方，由 main 调 shell.openExternal）；CONTRACTS 新增「M1 第 3 步界面接入」节记录该方法、列表偏好、侧边栏计数来源与事件刷新规则；desktop/README 同步。
- 新增运行依赖 markdown-it 14.3.2 与开发依赖 @types/markdown-it 14.2.0（--save-exact，package-lock 同步）；npm audit 仍为原有 8 项 moderate（electron-builder 传递链），未新增。

### 实际命令与结果（macOS 27.0.1 arm64，Node 26.12.0，Python 3.13.12，依赖与 lockfile 除上述新增外未变）

| 命令／检查 | 结果 |
| --- | --- |
| backend：`uv run --locked pytest -q` | 73 passed，1.11 秒（后端未改） |
| desktop：`npm test` | typecheck/构建通过，9 Node tests passed（打包前最后一次） |
| desktop：`npm run test:e2e`／`npx playwright test` | 最终代码连续 2 次 17 passed（约 51 秒）：原 10 项（仅改侧边栏按钮定位、白名单加 openLink、Settings 先点 Appearance）＋新 `tests/e2e/lists.spec.cjs` 7 项 |
| desktop：`npm run package:mac > ../../tmp/m1-step3-package.log 2>&1` | 成功；DMG 163,160,884 字节；Electron 与冻结后端均 Mach-O arm64；app.asar 只有 dist、package.json 与运行依赖（React、markdown-it 及其依赖） |
| DMG 安装 | 只读挂载、ditto 到含空格的 `tmp/job-vaccum-app/M1 step3 installed Isqi/`、卸载后运行 |
| 安装副本：`JV_EXECUTABLE=… npx --no-install playwright test` | 14 passed，3 skipped（仅开发导入的三项按设计跳过）；新 7 项列表场景以开发后端预先写入合成数据后，由安装副本内冻结后端实际运行 |

新 E2E 覆盖：分页与首末页、每页条数与重启保持；排序方向/箭头/空分置后/不可排序列/状态按流程顺序；全选当前页与取消、按条件勾选替换、Shift 连选、换页清空勾选；批量加入逐项反馈（含已存在）与清单计数；J/K/↑↓、S、X、?、Esc，弹窗中不触发、Esc 关闭菜单时详情不关；操作后岗位离开筛选时详情转到下一条；搜索标签与 Clear all、Score 编辑器非法输入、两页筛选互不影响、侧边栏方向、无匹配空状态与 Clear filters、筛选重启保持并从第 1 页开始；窄窗口 ⌘F 弹出搜索与 Esc 保留关键词、悬停 Searches 弹出切换；删除方向确认框（Cancel 焦点、Esc 取消）与失效筛选移除提示；行内状态（含纯键盘操作与焦点返回）、表格与详情备注保存/放弃、批量改状态与 ⌘Z 撤销（备注不变）、移出与 Undo 完整恢复管理字段、清理后 Undo 报告无法恢复；导出对话框（无格式切换、两种范围计数、取消保存面板保留对话框）与真实 CSV（BOM、10 行）及 Show in Finder；Searches 改名/空名/⌥↓ 排序；Data 非法天数、0 关闭、清理确认与结果、重启保持；隐藏/显示列、右键表头、列宽拖动与重启保持、Reset columns；900 宽横向滚动且页面不溢出、窄窗口浮层详情、640×480 无溢出；提示条约 8 秒消失与保持；请求失败骨架行与横幅重试；JD 中 script/img/javascript 链接不生效、http 链接与 O 键经 main 打开、file: 链接被拒；6 种主题×模式下正文、次要文字、勾选行/当前行、主按钮、链接、7 种状态和 5 种分数色的对比度均 ≥4.5:1，状态色同一模式三主题一致。

只替换系统保存面板、Finder、默认浏览器，以及失败/Markdown 场景中注入的列表、详情响应；其余均为真实 Electron 与 Python 服务。

### 测试中发现并修复的问题

- Shift 连选的锚点在状态更新函数里读取，已被覆盖，只选中一行；改为先取锚点。
- 弹出框定位前用 visibility:hidden，首次 focus 失败（菜单打开后无焦点、窄条搜索框未聚焦）；改为透明。
- 菜单关闭时焦点没回到触发按钮（ref 已解绑）；改为焦点落到 body 或仍在弹出框内时还给触发按钮。
- 列表 Return 快捷键吞掉了焦点按钮的 Return；改为焦点在按钮/链接上时不处理。
- 任意打开的弹出框（含悬停打开的 Searches 列表）都会屏蔽列表快捷键；改为仅焦点在弹出框内时屏蔽。
- 单击备注格会先打开详情，可能遮住该格导致双击失败；单击备注格改为只设当前行。

### 视觉检查（实际查看截图）

开发构建 1280×800：Jobs（列表、详情、选择菜单、批量加入提示条）、Shortlist（状态菜单、详情备注）、Score 筛选编辑器、Settings › Searches／Data，900 宽浮层详情、640×480；E2E 生成的 Graphite／Pine／Ink × 浅色／深色的 Jobs 与 Shortlist 截图中实际查看了浅色 Graphite、浅色 Pine Shortlist、深色 Graphite Shortlist、深色 Ink Jobs，其余组合由对比度断言覆盖，截图在 `tmp/job-vaccum-app/M1 lists */themes/`。原生红绿灯与窗口选项本步未改动；用户已确认红绿灯没有问题，不需要每步重复目视检查，B09 中红绿灯一项沿用前两步的检查与用户确认。

### M1 出口对照

| 出口项 | 结果 |
| --- | --- |
| 同岗不复制正文、多方向不重复 | 后端第 2 步测试；界面方向列显示全部方向、导出一岗一行（E2E） |
| 重复加入无覆盖 | 后端测试；界面「N were already there」且不改状态备注（E2E） |
| 清理保护清单详情/评分/来源/标签 | 后端测试；界面 Clear job data 后清单 2 条保留（E2E） |
| 清理运行数据不影响岗位 | runs 表按用户确认留 M2，M1 无运行记录可清理，本项在 M2 建表时验证 |
| 重启保留数据 | E2E 多处重启后筛选、排序、列、保留天数、清单数据保持 |
| B01–B04、B09–B12、D18、D19 | 界面与后端测试通过；B04「失效运行」与批次相关部分随 run_ids 留 M2；B02 中「已清理 ID」的界面反馈文案已实现，逐项结果由后端测试覆盖 |

### 已知限制

- E2E 每次启动都会把新窗口带到前台；运行期间在这台 Mac 上打字、移动鼠标经过窗口或切换应用，事件会进入测试窗口。调试中出现过测试未输入的搜索词使结果变化、悬停/焦点保持被真实指针或失焦打断的偶发失败，已通过日志确认 App 自身事件处理正确；提示条保持检查因此最多尝试 3 条。最终两次完整运行在无干扰时全部通过；建议运行 E2E 时不要操作这台 Mac。
- Runs 入口、批次筛选、侧边栏「上次/下次运行」、Score 菜单与详情评分按钮属于 M2／M3，未实现。顶栏窄窗口按设计缩短按钮文字，未做 ⋯ 菜单。
- 仍为本机未签名测试包，默认 Electron 图标；签名、公证和第二台 Mac 不在本阶段。

本步本地提交：`59a0e92 feat: M1 job list, Shortlist and Settings data UI`（main，未推送）。提交后跟踪工作区干净；dev-docs 与 AGENTS.md 仍仅本地维护。旧的 `tmp/job-vaccum-app/M1 merged installed …` 安装副本已被本步新 DMG 取代，尚未删除。


## GitHub 私有仓库建立（2026-10-19）

用户授权创建私有仓库 `Job-Vaccum` 并上传当前项目，跨机器迁移留待后续。本轮未改产品实现；将工作区原有 7 个未提交的前端及 E2E 文件改动保存为提交 `51b249a chore: snapshot current desktop changes for repository sync`，连同已有历史推送到 https://github.com/cany7/Job-Vaccum 。`origin` 为 `git@github.com:cany7/Job-Vaccum.git`，本地 `main` 跟踪 `origin/main`。

实际命令与结果：`gh auth status` 确认当前账号 cany7；`git diff --check` 通过；desktop 执行 `npm test`，类型检查及构建通过，9 项 Node 测试通过（约 11 秒）；`gh repo create cany7/Job-Vaccum --private --source=. --remote=origin` 成功；`git push -u origin main` 成功；`gh repo view … --json nameWithOwner,isPrivate,url,defaultBranchRef` 确认私有、默认分支 main；`git rev-parse HEAD` 与 `git ls-remote origin refs/heads/main` 均为 `51b249af740340e3d1eb325cfe8746a5a4665417`，跟踪工作区干净。环境沿用本机既定配置，未安装或升级依赖。

忽略规则保持原样：AGENTS.md、dev-docs/、tmp/、虚拟环境、node_modules 与构建安装产物未上传。未执行第二台电脑迁移，未重跑 UI E2E、后端测试或安装包验收；本轮构建和 Node 测试不代表未提交 UI 改动已完成全部阶段验收。

## 项目级设计 skills 迁移准备（2026-10-19）

按用户要求，将原 `/Users/tim77/Documents/skills/` 下的 apple-design 与 emil-design-eng 完整目录复制到仓库 `.agents/skills/`；原目录保留，项目内为实际文件，未使用符号链接。两个源目录均只有 SKILL.md。AGENTS.md 改为仓库相对路径，并约定换机器一并复制 `.agents/`；.gitignore 增加根目录 `/.agents/`，AGENTS.md 与 dev-docs/ 继续保持忽略。

已执行两个目录的 `diff -rq`，均无差异；`git check-ignore -v` 确认两个 SKILL.md、AGENTS.md 与 dev-docs/ 均被对应规则忽略；`git diff --check` 通过。仅更新本地开发配置与迁移材料，未改产品代码，未运行应用测试。

重新生成桌面 `job-vaccum-local-docs.tar.gz`，包含 AGENTS.md、dev-docs/、.agents/ 与 .gitignore，供新机器解压到克隆的项目根目录。仅本地提交 .gitignore，不自动推送；本轮未实际在另一台电脑验证 skills 发现或开发环境。

## M2 第 1 步：Python 检索服务、协议与桌面桥接（2026-10-19）

### 范围与工作区

用户明确授权 M2 后端、协议、Electron main/preload 具名白名单方法和 TS 类型；renderer 全部未改。M2 整阶段尚未完成，Runs/批次筛选/手动配置界面留下一步；实际评分 worker 留 M3。本步在从开工时最新 origin/main ed5c114 创建的独立 worktree `/Users/mm64/.codex/worktrees/m2-backend/job-vaccum-gui`、分支 `codex/m2-backend` 实施，未启动子 Agent。

按要求读过 AGENTS、README、SPEC 相关章节、PIPELINE、DATA-MODEL、CONTRACTS、ARCHITECTURE 的 JobSpy/代理、IMPLEMENTATION-PLAN M2、ACCEPTANCE 相关项和既有状态。原项目 `/Users/tim77/Documents/cy-automation/job-vaccum` 不存在，未读取其代码、配置、凭据或私人结果；归一化/筛除只对文档明确语义建立独立合成回归，无法核实的旧行为不标兼容。

开发期间主线新增 8235f1d（去掉 pyenv 强制说明及 uv python-downloads 限制），用户随后明确选择「采用主线的新环境约定」。M2 分支通过 merge 同步该提交；本地 AGENTS/ARCHITECTURE 随用户选择同步，不恢复旧限制。JobSpy 完整 SHA 与所有依赖 lockfile 保持不变。

### 已交付

- 迁移 003：runs/run_tasks/run_jobs；M1 数据原地升级，失败整笔回滚。运行全量无秘密快照含方向/query/city 稳定 ID、全部业务配置、固定运行参数和 JobSpy SHA；检索任务按 query ID/city ID/platform 排序，UUID/order 跨续跑保持。重启把未完成 run 标 interrupted、running task 回 pending，并重算活跃计数。
- 正式设置按字段 patch 顺序串行保存；城市 ID、Indeed 国家、平台、规则、rubric/model 元数据、auto_score_enabled 默认 true；编辑草稿持久化和显式 apply，不覆盖未应用的正式设置。新库无评分模板时不能显式开启或运行自动评分，可关闭后完整检索。
- 默认串行检索；真实 JobSpy 在 App 所有的 spawn 子进程中执行，白名单单平台参数、LinkedIn fetch_description、Indeed country_indeed、Markdown、offset=0。整尝试 600 秒、最多 3 次、5/10 秒可中断退避；参数错误不重试。attrs 在转换前单独提取，标准 logging 到 stderr 并脱敏；本地 HTTP 适配点统计实际请求和 429，不影响 service/LLM 网络。
- DataFrame 内存列名映射、原生 Location/Enum/列表、YYYY-MM-DD、薪资及单位、NaN/NaT/pd.NA→null、合法 0 保留；不写抓取结果文件、manifest、分页状态或 hash。fake scraper 覆盖成功/零结果/部分/失败/延迟，只有测试依赖注入，无产品模拟切换入口。
- 可配置筛除、NFKC/空白/casefold 公司键、utm/通用入口直链处理、Markdown/HTML 正文精确比较。按身份→直链→同轮跨平台公司标题→历史公司/JD→同轮公司/JD 匹配；跨批含已入库同轮岗位，保留不同有效外链的内容边界，不用历史公司标题合并。首个提交代表固定；后续只补来源、身份、query 和存活方向，不覆盖正文/首次发现/旧评分。冲突身份不抢键、不合并已有实体或丢清单。
- 每任务短事务提交岗位、来源/方向/身份、run_jobs、需要的评分任务、统计与任务完成/失败状态。重试先按完整映射记录去重；失败仍提交部分可用结果；重跑替换该任务本次计数，已提交命中 ID 取并集用于方向唯一统计。事务故障不会留下半批岗位、评分任务或成功标记；历史已提交批次保留。
- auto_score_enabled=false：新岗 unscored、无评分任务、scoring 计数全 0、运行正常结束；续跑用原快照，历史 unscored 不隐式补评。true：每个新 job 原子登记独立 pending 评分任务，spec 只有 job_id，不复制 JD；M2 不执行评分，因此有 pending 时保持 running/scoring，不能假称完成。
- runs.preview/start/list/detail/stop/resume、app.status 活跃运行、run.updated/run.stats/jobs.changed；协议事件驱动刷新，响应先于运行事件。Runs detail 任务分页、方向简单统计和仍存在 job 关系，list 提供 started_at/new_job_count 且默认只 pipeline。run_ids 用 is_new=1、空数组 All、失效运行空结果、rescore 拒绝；导出共享筛选。
- 运行清理接入统一 retention：created_at 严格早于 cutoff，0 禁用自动清理；活跃 run 时清理 BUSY/自动延后。删除 run 仅级联任务/关系，存活岗位来源/query/方向/清单/分数不受影响。运行结束清理 App tmp。
- 普通代理仅 off/ordinary；无认证地址在正式设置和快照，认证 URL 在 main safeStorage 加密文件，私有 stdin 控制消息注入内存，renderer 不可调用任意 service method。运行开始/续跑解析本次凭据，运行中设置修改只影响下一次；off 清除 worker 环境代理，ordinary 两平台同地址。Node 测试替换 OS 加密边界，不触碰 Keychain 或私人凭据。
- Electron 具名白名单和类型已扩展；main 为 service 建立自有进程组，service exit 时清理持有 stdio 的 scrape 子进程，Quit 有界结束自有组，不扫描旧 PID、不影响其他服务。
- CONTRACTS、DATA-MODEL、ACCEPTANCE 已先明确本步边界和接口；backend/desktop README 更新接入说明。dev-docs、AGENTS、.agents 继续仅本地忽略，不强制入 Git。

### 验证与实际环境

本机 macOS 27.0.1 / 26A434 arm64；Python 3.13.12、SQLite 3.54.0、uv 0.13.1、Node 26.12.0、npm 11.20.0、Electron 44.9.0。JobSpy `1988484ac76ff9ae57784750346842e967e8ba10`（包显示 1.3.0）、pandas 3.0.6、curl_cffi 0.16.3；无依赖升级、无私人凭据、无网站/付费模型调用。

worktree 按要求独立安装依赖，没有复制 .venv/node_modules：backend 执行 `uv sync --locked --python /Users/mm64/.pyenv/versions/3.13.12/bin/python`（当时开工环境约定）；desktop 执行 `npm ci`（319 packages，原有 8 moderate 未变）。之后按用户确认同步主线的新解释器约定。具体最终测试与提交结果见下方「最终命令、结果与本地提交」及后续合并记录。

### 验收边界和未完成项

合成/模拟验证覆盖 D01/D02/D07、D10 runs、D15/D16 runs 保留；F 组中公司/JD/直链/身份、跨批代表固定、经验阈值/学历 OR/OPT 及冲突身份的文档边界；J01–J08 的本地输入/诊断；运行互斥、部分结果有限重试、原子提交、快照续跑、已成功任务跳过、批次即刻可见及独立评分任务登记；B04/B08 的后端批次查询/失效/导出。不能将其写成对应整组 UI、旧规则完全复现、真实网站或实际评分执行全部通过。

- 未获真实平台测试条件，未访问 LinkedIn/Indeed，也未使用真实代理；两个平台极小范围在线验证仍待用户提供条件。
- 原项目不可访问，旧 FILTERING-AND-DEDUP/资格规则完全对照尚未完成；当前资格筛除保守，仅处理文档和契约明确的条件，不继承私人假设。
- renderer 未改，M2 Runs、配置、批次筛选与失效条件提示 UI 留下一步。新增具名方法可直接接入；B04/B08 界面项仍未验。
- 实际评分、模型连接测试/Key 存储、AI 草稿生成、Mihomo、定时计划不在本步；评分开启有新增岗位时会停留 running/scoring，需后续 M3 执行或显式停止。
- 未重新打包/安装本步版本，冻结进程 spawn、safeStorage 的真实 Keychain 行为及最终安装包仍未验证；不以开发 E2E 代替安装包验证。
- 本步未推送、未建 PR、未合并回 main。

### 最终命令、结果与本地提交

| 位置/命令 | 实际结果 |
| --- | --- |
| backend `uv run --locked pytest -q` | 116 passed，2.89 秒；补入 D02 旧成功 0 分保留断言后，merge 主线再执行见下一项 |
| backend（merge 后）`uv sync --locked && uv run --locked pytest -q` | 锁定同步成功（只重建当前 editable 项目，无依赖变更），116 passed，2.95 秒 |
| desktop `npm test` | 类型检查、构建通过，12 Node tests passed，约 12.67 秒；新增运行事件、safeStorage 边界和 service 崩溃后自有子进程退出测试 |
| desktop E2E 首轮 | 15 passed / 2 failed；首次 Electron 下载占用启动时间，About 的 schema 2 断言须更新为 3。第二轮 17 passed / 1 failed，为遗漏的一处 Schema 2 文本断言；仅更新测试断言，未改 renderer |
| desktop `npm run test:e2e`（断言更新后） | 整套 18 passed，约 1.0 分钟；原有 17 项加 M2 具名配置/草稿/运行查询用例 |
| desktop 后续整套复验 | 17 passed / 1 timeout（既有 request failures / Markdown 场景，30 秒上限；无足够证据确定该次超时根因），未修改 UI 或放宽断言 |
| desktop `npx --no-install playwright test tests/e2e/lists.spec.cjs -g 'request failures' --trace on` | 单独复验 1 passed，4.3 秒 |
| `git diff --check`；与 origin/main 对比 renderer、依赖 lockfile、pyproject | 通过；renderer 和 lockfile 无变更，pyproject 与用户确认的新主线一致 |

功能提交 `20e893f feat: implement M2 retrieval service and named desktop run bridge`；同步主线 merge 提交 `897a7b9 Merge remote-tracking branch 'origin/main' into codex/m2-backend`。两者仅本地，跟踪工作区干净；main 未合入 M2。dev-docs/AGENTS/.agents 依约只本地维护。

merge 后最终 `npm run test:e2e`：**18 passed，约 1.0 分钟**，包含前述超时项。未改断言/超时重试设置；该次间歇性超时保留记录。最终未重新打包或访问真实网站。已将本步本地文档及更新后的 AGENTS 同步回主目录，便于下一步 renderer 接入；M2 代码保留独立 worktree/分支。

收尾补充：内容匹配比较代表及全部已补来源中的有效外链，覆盖「LinkedIn 首个代表无外链、Indeed 后补 A、随后同平台同 JD 外链 B」：A/B 不因代表主字段仍为空而误合并；代表主字段仍不改。新增对应合成回归，最终结果见后续补记。

补充修正提交 `46f5b94 fix: preserve distinct content links after source enrichment`（本地 HEAD）。修正后 backend `uv run --locked pytest -q`：**117 passed，2.84 秒**；main/preload/renderer 未再修改，前述最终 12 项 Node 与 18 项 E2E 结果仍对应当前桌面实现。最终跟踪工作区干净；三个本地提交未推送，M2 未合并回 main。

## PR 合并与 Git/worktree 整理（2026-10-19）

用户明确授权执行整理、推送并直接合并 PR，保留 Claude 并行开发目录，并调整 Codex worktree 名称。本轮只处理仓库、环境与本地文档，没有修改产品代码、依赖声明或 lockfile，没有启动新阶段。

### 合并和当前工作目录

- `git push -u origin codex/m2-backend`；使用正文文件创建 [PR #2](https://github.com/cany7/Job-Vaccum/pull/2) 并附加到本聊天；`gh pr merge 2 --merge` 成功。GitHub 返回 MERGED，merge commit 为 `59220d82f0c6fd7377b3aa7f36b9755a9347096a`。
- 最初项目目录执行 `git switch main`、`git pull --ff-only`，更新至该合并提交。Claude 目录在 `claude/dev-env` 执行 `git merge origin/main`（快进）并推送，保留其独立开发分支和目录。
- 为保持 Codex 管理附件一致，使用应用工具建立名称为 codex-dev 的新 worktree，并创建/推送 `codex/dev` 分支。旧 M2 worktree 通过应用工具归档，保留可恢复快照；不手工移动已登记的 Codex 管理目录。

| 用途 | 活动 worktree | 本地分支及跟踪分支 |
| --- | --- | --- |
| 主线/联调 | `/Users/mm64/PycharmProjects/job-vaccum-gui` | main → origin/main |
| Codex 开发 | `/Users/mm64/.codex/worktrees/codex-dev/job-vaccum-gui` | codex/dev → origin/codex/dev |
| Claude 开发 | `/Users/mm64/PycharmProjects/job-vaccum-gui-claude` | claude/dev-env → origin/claude/dev-env |

三者当前代码及 GitHub 三个分支均为 59220d8；后续各自在自己的开发分支提交，按授权提 PR 合入 main。主目录固定检出 main。分支并不隔离运行时数据库：并行启动应用/测试仍需各自数据目录。

### 清理和本地文件

- 删除已合入 main、没有独有提交的本地 `codex/migration-dev-env`、`claude/local-env-config-check-70062e`；用 `git worktree remove` 移除 detached 的旧环境配置检查目录（检查确认无未跟踪或忽略文件）。
- M2 成果进入 main 且 codex/dev 已推送后，删除本地/远端旧分支 `codex/m2-backend`。旧目录 `/Users/mm64/.codex/worktrees/m2-backend/job-vaccum-gui` 在 Codex 中为 archived_worktree，不再是活动 Git worktree。
- 删除分支前均核实其提交为 main 祖先；未 rebase、未 force push、未改写历史。Claude 分支及目录未删除。
- 原 M2 的 AGENTS/dev-docs/.agents 与主目录一致；旧 tmp 内的合成测试数据、截图与报告整体迁到新 Codex worktree 的 tmp。Claude 本地文档比对后确认无独有开发记录，仅旧环境约定需更新，已同步主目录的最新文档和 skills。
- 没有复制 .venv/node_modules。新 Codex worktree 执行 `uv sync --locked --python 3.13.12` 与 `npm ci`，建立独立环境；最初 uv 自动选到 3.13.13，已按声明版本重建为 3.13.12。原 main/Claude 环境先分别 `uv sync --locked` 更新 editable 项目元数据；随后核对发现 Claude 原环境为 3.13.13，也用 `uv sync --locked --python 3.13.12` 按声明版本重建。未升级依赖。JobSpy SHA 和两端 lockfile 不变。
- AGENTS/dev-docs/.agents 依约仍被 Git 忽略，三个目录分别保留并同步。已删除目录中没有唯一的本地文档被丢弃；生产凭据和真实抓取数据未读取、未用于测试。

### 合并后验证

沿用 macOS 27.0.1 arm64、Python 3.13.12、Node 26.12.0、npm 11.20.0、uv 0.13.1 及既定依赖。

| 目录/命令 | 实际结果 |
| --- | --- |
| main backend `uv sync --locked && uv run --locked pytest -q` | 117 passed，3.33 秒 |
| main desktop `npm test` | 类型检查、构建及 12 Node tests passed，约 12.59 秒 |
| main desktop `npm run test:e2e` 首轮 | 17 passed / 1 timeout，约 1.6 分钟；既有 request failures / Markdown 场景触及 30 秒上限，未改断言或超时 |
| 新 Codex backend `uv sync --locked --python 3.13.12 && uv run --locked pytest -q` | 117 passed，9.65 秒 |
| 新 Codex desktop `npm ci`；`npm test` | 安装 319 packages，原有 8 moderate 未变；类型检查、构建及 12 Node tests passed，约 12.59 秒 |
| Claude backend 初次 `uv sync --locked`；`uv run --locked pytest -q` | 同步成功；117 passed，3.83 秒；此时沿用原 3.13.13 环境，后续统一到声明版本 3.13.12 并再验 |
| Claude desktop `npm test` | 类型检查、构建及 12 Node tests passed，约 12.66 秒 |

main E2E 的带 trace 单项复验及最终核对结果见下方补充与最终整套复验记录。未打包/安装、未抓真实网站、未调用付费模型。本轮 M2 renderer 与 M3 评分的范围限制继续有效。

补充验证：main 的 `npx --no-install playwright test tests/e2e/lists.spec.cjs -g 'request failures' --trace on` 单独复验 **1 passed，4.3 秒**；Claude 按声明版本重建后 `uv run --locked pytest -q` **117 passed，8.74 秒**。通过各目录 .venv/bin/python 实际检查，三个环境现在均为 3.13.12。最后一次整套 E2E 使用 `npm run test:e2e -- --trace retain-on-failure`，保留失败 trace，不修改测试断言或超时设置。

最终整套复验：main `npm run test:e2e -- --trace retain-on-failure` **18 passed，60.0 秒**。首轮间歇性超时保留为已知测试记录，不宣称根因已修复。最终 main / codex/dev / claude/dev-env 本地及远端均指向 59220d8，三个活动 worktree 跟踪状态干净；PR #2 已合并。本节与全部本地开发文档同步到 Codex、Claude 目录。未新增产品代码提交，未改写历史；合并后的安装包及真实外部服务验证仍未执行。

### 三目录环境与文档复核（2026-10-19）

按用户追问再次核对三个活动 worktree：各有独立 .venv/node_modules，Python 均为 3.13.12、Node 26.12.0、npm 11.20.0。各目录 `uv sync --locked --check` 均返回 Would make no changes，`npm ls --depth=0` 无缺失/非法依赖，`npm run typecheck` 全部通过。各自 Python 可导入本目录 job_vaccum、锁定 JobSpy、pandas/curl_cffi，并成功创建/关闭 native Curl。Codex/Claude 的 Electron 首次使用二进制下载已补齐，三个目录均实际以 Node 模式执行 Electron，返回 44.9.0 / arm64，不依赖其他 worktree 的二进制。

解释器版本一致，但分发构建附带的 SQLite 有差异：main 使用原环境 SQLite 3.54.0，Codex/Claude 的 uv 管理解释器使用 SQLite 3.50.4；三个环境此前均通过 117 项后端测试，不为此升级依赖或改产品配置。本轮只复核安装/导入/native 执行和类型检查，未重跑整套 pytest/E2E；完整测试结果沿用本节前面的合并后验证记录。

项目文档逐文件比较：每个目录均完整拥有 AGENTS.md、dev-docs 11 份、.agents 两个设计 SKILL.md，以及受跟踪的 backend/desktop 两份 README，共 16 份；无缺失、无内容差异。本记录同步至三处，Git 跟踪状态保持干净。这些本地开发文档仍按约定被忽略，GitHub 不包含 AGENTS/dev-docs/.agents。


### 双目录工作方式（2026-10-19，取代上方三目录安排）

按用户最新要求，Codex 固定在 `/Users/mm64/PycharmProjects/job-vaccum-gui` 的 `codex/dev` 分支工作；Claude 继续使用 `/Users/mm64/PycharmProjects/job-vaccum-gui-claude` 的 `claude/dev-env`。本地 main 分支保留，但不要求任何目录签出 main。两开发分支按授权提交 PR 到远端 main，合并后各自 fetch 并 merge origin/main，执行对应联调。

本轮实际执行 `git fetch origin --prune`、`git ls-remote --heads origin`、两目录 `git status --short --branch`、`git worktree list --porcelain`；三个本地/远端分支均为 59220d8，两个工作区干净。检查确认 `.codex/worktrees/{codex-dev,m2-backend,migration-dev-env}` 仅含 `.codex-worktree-name` / `.DS_Store` 后删除这些残留目录；未删除代码目录。执行 `git switch codex/dev` 成功，跟踪 origin/codex/dev。

通过 GitHub CLI 只读检查：仓库 allow_auto_merge=false，main 无传统分支保护，rulesets 列表为空。本轮未更改远端设置、未推送或合并 PR，未重新运行应用测试（未修改产品代码或依赖）。Codex 云端自动 review 的账户设置尚未核实。此记录追加至两处本地 DEVELOPMENT-STATUS.md。


### PR CI 配置（2026-10-19，历史：当时仅本地完成，后续已启用云端）

在现有 codex/dev 工作区添加 `.github/workflows/ci.yml`：PR 到 main、main push、手动触发；三个独立检查 Backend / Frontend / Desktop E2E，固定 macos-15 arm64，Node/Python 读取项目声明，uv 0.13.1，npm ci / uv sync --locked，不升级业务依赖。新 PR 更新取消旧运行，测试不自动重试，报告和截图保留七天。

给五个既有 E2E 用例增加 @smoke 标签（启动/诊断/关闭退出、backend crash、M1 持久化导出、M2 配置查询、Jobs 加入清单），新增 `npm run test:e2e:smoke`；没有改测试断言或超时。完整 test:e2e 仍覆盖全部用例，workflow_dispatch 的 full_e2e 可选完整套。运行数据仍使用合成数据，无真实抓取或付费模型。未修改产品代码。

操作说明见 `.github/README.md`：先让配置 PR 在 GitHub 跑通，再开启 main PR 保护、三个 required checks、strict up-to-date、禁止绕过与强推，以及仓库 auto-merge；本地 Agent 用既有 gh 登录创建 PR 并 `gh pr merge --auto --merge`。不新增 PAT/App、自动 approve 或 privileged workflow。两个长期分支保留；主线推进后需 merge origin/main 并重验，冲突/失败不会自动解决。仅 push 不会自动创建 PR。

本机验证（macOS arm64，Node 26.12.0 / npm 11.20.0 / Python 声明 3.13.12 / uv 0.13.1）：
- `uv sync --locked --python "$(cat ../.python-version)"` 成功；`uv run --locked pytest -q --junitxml=../../tmp/ci/backend.xml`：117 passed，3.14 秒。
- desktop `npm test`：类型检查、构建、12 Node tests passed，Node 测试 12.61 秒。
- desktop `npx --no-install playwright test --list --grep @smoke`：恰好五项；最初在仓库根运行该列举命令失败（找不到本地 playwright），改到 desktop 后成功，没有安装额外 npm 依赖。
- `PLAYWRIGHT_JUNIT_OUTPUT_FILE=../../tmp/ci/e2e.xml npm run test:e2e:smoke -- --reporter=list,junit`：5 passed，9.7 秒。两个 JUnit 文件均实际生成。
- 临时下载的 actionlint 1.7.12 验证 workflow 成功；git diff --check 通过。

未运行 GitHub hosted CI、未启用云端 branch protection/auto-merge、未推送/提 PR/合并；未执行完整 E2E 或安装包验收。首次云端运行仍需验证 macos-15 runner 与锁定工具可用性。两处开发状态记录已同步追加；Claude 源码等待后续 PR 合并同步。


### GitHub CI 与自动合并已启用（2026-10-19）

用户明确授权全部配置、推送与合并。配置提交 c254bb5 和云端环境修复 313cf9a 通过 PR #3 合入 main：a9c743a。PR：https://github.com/cany7/Job-Vaccum/pull/3 。三项检查通过后 GitHub auto-merge 实际自动完成合并，未使用 admin bypass。

仓库 allow_auto_merge=true、allow_merge_commit=true、delete_branch_on_merge=false。main 保护要求 PR（人工批准数 0）、Backend / Frontend / Desktop E2E 三个 GitHub Actions（app_id 15368）检查、strict up-to-date；enforce_admins=true，禁止强推及删除。CI token 保持只读。后续本地 Agent 按授权用 gh 创建 PR 并逐个启用 `gh pr merge --auto --merge`；仅 push 不自动创建 PR。main 变化需同步到开发分支，冲突或测试失败阻止合并。

首次 hosted E2E 发现 runner 默认显示 1024x768 触发窄屏折叠，Electron 首次下载也占用用例 30s 超时。仅修改 CI 准备步骤：先 `npx --no-install install-electron`，再用固定 displayplacer v1.4.0 Apple binary 将云端屏幕设为 1920x1080。没有放宽断言、增加重试或改产品代码。首次事件出现排队延迟，检查期间曾关闭/重开 PR 触发一次新运行；旧运行随后被 concurrency 取消，失败记录保留。

云端验证：
- PR CI run 39326861619：Backend / Frontend / Desktop E2E 全部 success；后端 117 passed（7.56 秒），Node 12 tests，E2E 5 passed（30.7 秒）。报告/截图上传成功。
- 合并后 main CI run 39327120302：三个 job 全部 success。
- 执行 git fetch origin、两个目录分别 git merge --ff-only origin/main、git fetch origin main:main，再 push codex/dev 和 claude/dev-env。三个本地/远端分支均为 a9c743a，两个 worktree 干净。main 保留分支但没有目录签出；Codex 当前目录仍在 codex/dev。

未重新执行完整 E2E 或安装包验收。无真实抓取/付费模型调用。此记录同步两处本地 DEVELOPMENT-STATUS.md。


## 开发约定与仓库首页（2026-10-19）

- 两个活动 worktree 的 AGENTS.md 已同步：默认本地验证与提交，不自动 push；用户授权推送交付后，开发分支同步 main、验证、push、创建或更新 PR、开启 auto-merge，由必需 CI 决定合并。保留长期分支，不绕过保护，无需 checkout main。
- 新增根 README，说明产品用途、当前范围、模块入口与本地启动。核对相对链接和命令，git diff --check 通过；仅文档修改，未重复运行本地产品测试。
- 用户授权 README 进入 main；因主线要求 PR 且管理员也不能绕过，通过 PR #4 完成交付，未调整保护。提交 533e215，合并提交 c01bdb4；PR 的 Backend、Frontend、Desktop E2E 均通过。
- 两个开发目录及远端开发分支均已快进同步 c01bdb4，跟踪文件干净；AGENTS.md 与本状态文档仍仅本地维护。
- 合并后 main CI（39328347143）三项检查全部通过。


## STATUS 纳入 Git 前的本地核对（2026-10-19）

- 核对前两个活动目录的本文件均为 626 行，逐字节一致，无需手动合并，也没有仅存在于另一目录的开发记录。
- 对照本地提交历史、项目版本声明和已有交付记录，补充当前摘要，区分完整 E2E、CI 冒烟及安装包验证范围；给旧阶段记录加历史标记，更新通用 uv 准备命令，修正已补记事项的待办措辞。原始历史验证结果保留。
- 修正已同步至两个目录。本轮未运行产品测试、未查询或更改远端状态；未修改忽略规则或 AGENTS.md，未执行 git add、commit、push。本文件仍被 `/dev-docs/` 忽略，尚未纳入 Git 跟踪。


## 开发文档纳入版本控制（2026-10-19）

用户授权解除 AGENTS.md、dev-docs/ 的忽略并提交推送，随后同步两个开发分支。变更前逐文件比较两个目录，AGENTS.md 与 11 份开发文档完全一致，无需合并独有记录。更新 .gitignore、AGENTS.md 的文档维护规则和仓库 README 入口；.agents/ 继续忽略。仅文档及忽略规则变更，未改产品代码或依赖，未重复运行本地产品测试；推送后按既有 PR 必需 CI 与自动合并流程交付，实际远端结果以 PR/Actions 为准。


## M2 第 2 步：renderer 界面（2026-10-19，Claude）

### 授权与范围

用户授权 M2 前端：按 IMPLEMENTATION-PLAN M2 剩余界面，只改 renderer 及其测试，不改 Python、main、preload；缺接口只记录。开工前就设置范围提问，用户选择「筛除规则与普通代理设置也做」。明确不做：Score 菜单与模型设置（M3）、Resume 与 interrupted 专门处理（M4）。完成后按 AGENTS 推送并创建 PR、开启自动合并。读过 AGENTS、dev-docs 全部相关章节和两个设计 skill（`.agents/skills/apple-design/SKILL.md`、`.agents/skills/emil-design-eng/SKILL.md`）。分支 claude/dev-env，开工时与 origin/main（fb1e0a6）一致。

### 实际交付

- **Runs 页（布局待确认）**：SPEC 未给 Runs 布局，沿用卡片、侧列表、表格、横幅等现有组件做简洁版。侧边栏与折叠窄条新增 Runs 入口；顶部「Next run」说明 runs.preview 的任务数、各平台目标、发布时间范围、自动评分开关，不能运行时写明原因并链到对应设置分区；顶栏唯一主按钮 Run now（无效配置、已有运行或请求进行中禁用，不自动重发，返回后重查 app.status），运行中出现 Stop（stopping 时为 Stopping… 禁用）。左侧运行历史（开始时间、状态、新增数，最多 200 条），右侧详情：状态、完成时间与耗时、抓取/评分分别的任务进度（完成/失败/运行/等待/取消，无动效进度条），本轮自动评分关闭时写明；Received、Filtered out、Matched jobs、New jobs（「N new」打开按该批次筛选的 Jobs）；按方向统计表；抓取任务表（query、地点与半径、平台、状态、尝试次数、计数、失败原因、零结果「No results」、缺 JD、429、warnings，筛除原因在悬停提示），任务 50 条分页。run.updated / run.stats / cleanup.completed 事件驱动刷新列表与详情，不解析日志、不轮询。
- **侧边栏运行状态**：连接状态下方显示「Run in progress · 阶段」/「Stopping run…」/「Last run 时间 · 状态」；折叠窄条运行中状态点用强调色并在悬停提示中写出。下次运行属于 M7 计划，未做。
- **Jobs 批次筛选**：+ Filter 增加 Batch（仅 Jobs），All batches＋多选运行，选项为「Oct 18, 09:00 · 42 new」；FilterSpec run_ids 由 renderer 传给后端；标签「Batch: …」，筛选记忆存本机 UI 偏好，重启保持。运行列表变化时检查失效批次：不在列表中的运行在总数超过 200 时逐个 runs.detail 确认 NOT_FOUND，确认后移除并提示「A batch filter for a run that no longer exists was removed.」。
- **Settings › Searches**：新增 Add search、每个方向的开关、展开编辑 queries（添加、编辑需 Return/Save、空值在输入框下提示、开关、删除不确认）；勾选框即时反映、保存失败回退。下方「Locations and sites」：城市列表（开关、地点、半径英里、删除、添加，默认半径 50）、Indeed 国家（说明 LinkedIn 只用 location）、LinkedIn/Indeed 平台；整组为草稿，Save 写入，非法半径/空地点/空国家在字段下提示且不保存，可 Discard changes；勾选 LinkedIn 时提示限流与代理。
- **Settings › Filters & scoring**：自动评分开关（无评分模板时只能关闭，关闭后禁用并说明原因；开启/关闭仅影响新运行）；筛除规则：说明始终生效的公司排除/空记录/明确兼职，公司名单多行粘贴去重，7 个可选规则各有作用说明，经验年限、签证担保、工作授权、语言、毕业日期、学历输入，Save 写入、非法年限提示。评分模板编辑留 M3。
- **Settings › Proxy**：直连／普通代理二选一，地址只允许无认证 http/https/socks5 origin，本地校验后由后端再校验；Sign-in 用户名与密码由 renderer 拼成带认证的同 endpoint URL 交给既有 setProxyCredential（main safeStorage），只显示「已保存」，可替换或移除，不回显。
- **Settings › Data**：清理预览与确认框、结果提示加入运行记录数量。Settings 切换分区时回到顶部。
- 未新增依赖、业务表或 service 命令；未改 Python、main、preload、shared 类型和 CONTRACTS。

### 缺口与限制（未自行补接口）

- 后端默认 cities 为空，SPEC「预置美国城市」没有来源；renderer 未自行内置城市，新用户需手动添加（可在 M5 引导或后端默认值中补齐，需决定）。
- queries 由后端按随机 UUID 排序，没有创建顺序字段；renderer 改为按文本排序显示，以免新增 query 位置跳动。
- runs 统计只有总筛除数和每任务 filter_reasons，没有运行级「按规则」筛除汇总；Runs 页只在任务行悬停提示中显示原因，不分页汇总全部任务。
- runs.list 每页最多 200：历史、批次选项只列最新 200 次运行，更早的运行在批次标签中显示为「Earlier run」。
- Stop 时 SPEC 要求的「剩余请求数」依赖 M3 评分请求；本步只显示任务计数。interrupted 只按后端返回值显示状态文字，没有续跑入口（M4）。
- 日期输入框（毕业日期、既有日期筛选）使用 Chromium 原生控件，按系统区域显示（本机为中文格式）；未改。

### 实际命令与结果（macOS 27.0.1 arm64，Node 26.12.0，Python 3.13.12，依赖与 lockfile 未变）

| 命令／检查 | 结果 |
| --- | --- |
| desktop `npm test` | 类型检查、构建通过，12 Node tests passed（约 12.5 秒） |
| backend `uv run --locked pytest -q` | 117 passed，2.41 秒（后端未改，仅确认） |
| desktop `npm run test:e2e` | **21 passed，约 1.2 分钟**：原 18 项（仅更新两处断言：Runs 入口现在存在；Searches 页改名 Save 限定在表格内）＋新 `tests/e2e/runs.spec.cjs` 3 项 |
| `git diff --check` | 通过 |
| 同步主线：`git fetch origin`、`git merge origin/main`（PR #7 M3 后端，25fe8e6） | 仅本文件摘要冲突，手动合并两边记录；shared 类型新增项与 renderer 兼容 |
| 合并后 backend `uv sync --locked && uv run --locked pytest -q` | 172 passed，19.90 秒 |
| 合并后 desktop `npm test` | 类型检查、构建通过，13 Node tests passed |
| 合并后 desktop `npm run test:e2e` | **22 passed，约 1.4 分钟**（含主线新增 M3 桥接 scoring.spec 1 项） |

新 E2E 覆盖：预先写入的合成运行（成功、部分完成）在 Runs 页的列表顺序、状态、耗时、进度、自动评分关闭说明、总计、按方向表、失败原因/零结果/缺 JD/429/筛除原因提示；「3 new」进入批次筛选、批次编辑器多选、Shortlist 无 Batch、重启保持；Clear job data 确认含运行数、清理后批次筛选移除并提示、Runs 空状态。Run now/Stop 在 Electron IPC 边界替换 runs:start/stop/list/detail 与 app:status，并由 main 发送 run.updated 事件：验证请求进行中按钮禁用且只发一次、运行中阶段、Stop→Stopping…→Stopped、侧边栏运行文字、进度计数。新用户 Runs 显示不能运行的原因与链接；Searches 新增方向/空名、query 增改删开关；Locations 非法半径与空国家不保存、保存后后端值一致；自动评分关闭后无模板不可再开、Runs 可运行；规则非法年限、保存后后端 rules 完全一致；代理拒绝带认证地址、保存 origin、Sign-in 空值提示、在 main 内替换 safeStorage（不触碰 Keychain）后保存/移除凭据且设置中无密码、preview 接受凭据；重启后设置保持；640×480 下 Runs 与 Settings 无页面溢出。

**没有任何测试启动真实运行**：Run now 仅在替换 IPC 后点击，其余测试从不点击，未访问 LinkedIn/Indeed，未使用真实代理或付费模型。

### 视觉检查（实际查看截图）

1280×800 浅色 Graphite：Runs（列表＋部分完成/完成详情）、Searches（展开 queries）、Locations and sites、Filters & scoring（上下两屏）、Proxy、Jobs 批次编辑器；深色 Graphite Runs 空状态；640×480 Runs。发现并修复：切换设置分区保留上一分区滚动位置；语言/学历输入换行到标签下方；无代理地址时提示右对齐。640 截图中 Run now 偏灰为启用时 150ms 透明度过渡中的帧（计算样式确认已启用），非问题。新增界面无动画；高频操作（勾选、切换运行）无动效，reduced-motion 下沿用既有按钮规则。

### 未完成

- M2 出口仍需：获得测试条件后的两个平台极小范围真实抓取；M2 版本重新打包与安装副本验收。均未执行。
- Runs 页布局待用户确认后再定稿。


## M2 收尾改动迁回 Codex 工作区（2026-10-19）

按用户要求将临时 codex/m2-completion 的九个文件改动迁入 `/Users/tim77/PycharmProjects/job-vaccum-gui` 的 codex/dev，保留已提交 47d940d 的全部修复；开发状态文档合并两边记录。改动保持未提交、不 push，后续在本工作区继续。临时 worktree 及分支清理；该目录中的本轮临时数据库、真实抓取结果、日志、截图、trace、安装副本、DMG、构建产物及独立依赖随目录清理，不迁移到当前工作区。上文 tmp 路径仅记录当时验证证据，清理后不再可访问，验证结论保留在文档中。

迁移后验证：backend `uv run --locked pytest -q` 179 passed（19.29 秒），desktop `npm run typecheck` 通过，`git diff --check` 通过。临时 worktree 已通过 Codex 归档工具移除（保留应用管理的可恢复 Git 快照），codex/m2-completion 分支已删除；原临时目录及其测试/打包产物确认不存在。当前 HEAD 仍为 47d940d，九个文件保持未提交。
