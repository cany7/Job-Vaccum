# M1 交接 prompt

M1 分三步交给不同 Agent，按顺序执行，每步单独 commit。第 1 步只改造 M0 的桌面界面，第 2 步做后端数据，第 3 步做列表和业务界面。每段 prompt 可直接复制给 Agent。

设计参考：`tmp/m1-design/*.html` 是设计画布导出的静态页面，用浏览器打开查看。01 是已确认的整体原型，02–06 是细节（选择与分页、Shortlist、Settings、对话框、空状态与错误），07、08 是浅色、深色配色。02–06 仍是旧的亮蓝配色，颜色一律以 SPEC 配色表为准。图中的中文说明是设计意图，界面文案用英文。

## 第 1 步：外壳与 M0 界面改造（前端）

> 阅读根目录 AGENTS.md、dev-docs/README.md，然后读 SPEC「界面结构」「窗口布局与列表」（含配色表）「设置分页」，ARCHITECTURE 第 6 节，CONTRACTS 中关于本机 UI 偏好的段落，IMPLEMENTATION-PLAN 的 M1，ACCEPTANCE B09、B11、B12，以及 DEVELOPMENT-STATUS 的两轮设计决定。设计参考见 tmp/m1-design/01-Merged.html、04-Settings.html、06-States.html、07/08-Palette*.html。用户已授权 M1。
>
> 本步只把 M0 的开发面板改造成 M1 的应用外壳，不做岗位数据、迁移、列表或 Shortlist，这些属于后续步骤。M0 后端不需要修改。SPEC 中用户确认的主题切换优先于 AGENTS.md 里「不增加主题」的旧表述。
>
> 任务：
> 1. main/index.ts：默认窗口 1280×800，最小 640×480；隐藏原生标题栏（hiddenInset），红绿灯位置对齐 48px 高的顶栏，顶栏作为拖拽区。保留单实例、关窗驻留、有界退出和 IPC 发送方校验。
> 2. preload 和 main 各新增一个具名白名单方法：退出应用（走现有 before-quit 流程），以及在 Finder 中显示数据目录。不暴露任意路径或命令。
> 3. renderer 用外壳替换 App.tsx 的卡片面板：
>    - 顶栏：红绿灯留位、侧边栏开关（⌃⌘S）、页面名、右侧操作区。
>    - 侧边栏：展开 200px，折叠为 52px 窄条，红绿灯始终在顶栏。展开时有搜索框（本步只放占位，不接数据）、Jobs、Shortlist、Settings 和连接状态；Searches 区等第 3 步有数据后再加。不显示 Runs。
>    - 窗口窄于约 1100px 时自动折叠，拉宽后恢复；手动折叠的保持折叠，折叠状态存本机 UI 偏好。
>    - 主区域是圆角卡片。Jobs 和 Shortlist 本步显示 SPEC 规定的空状态文案，并在 DEVELOPMENT-STATUS 写明列表在第 3 步实现。
> 4. Settings：卡片内左侧是分区目录，本步做两个分区：
>    - Appearance：模式 System／Light／Dark；浅色主题和深色主题各自从 Graphite／Pine／Ink 选，存本机 UI 偏好，即时生效。
>    - About：版本、后台状态、数据目录（Show in Finder）、数据库状态、Run diagnostics。Ping 只在开发构建显示。M0 的 Connection／Status／Diagnostics 卡片移到这里后删除原面板。
> 5. 样式：
>    - 按 SPEC 配色表，用 CSS 变量实现三套主题 × 浅色、深色，加增强对比度，去掉 M0 的亮蓝。
>    - 状态和分数颜色变量先定义好，供第 3 步使用。
>    - 按钮分为描边默认按钮和唯一的实心主按钮。
>    - 保留 M0 的焦点环、reduced-motion 和长文本处理。
> 6. 错误状态：
>    - 启动失败是整窗口页面：先写原因和处理办法，再显示数据目录和 Quit 按钮，错误代码用小号灰字放在最后。
>    - 后台进程意外退出时挡住界面，只提供 Quit。
>    - 只做本步实际用到的组件；提示条、骨架行等等用到时再做。
> 7. 测试：
>    - 改写 tests/e2e/desktop.spec.cjs 中针对 Ping、诊断卡片和旧布局的断言。
>    - 新增覆盖：外壳渲染；折叠与重启后保持；窄窗口自动折叠；主题和模式切换及重启后保持；启动失败页 Quit 可用；后台崩溃状态；640 宽无页面级横向溢出；键盘焦点；reduced-motion。
>    - 后端测试保持通过。
>    - 打包一次 arm64 DMG，确认安装副本的标题栏和红绿灯正常。
>
> 开始写前端前，按 AGENTS.md 读取两个设计 skill。完成后运行 npm test、npm run test:e2e、uv run --locked pytest -q，实际截图检查三套主题的浅色、深色以及窄窗口；更新 DEVELOPMENT-STATUS（交付、命令、结果、未完成项），本地 commit，不推送。未实际检查的项目不要写成通过。

## 第 2 步：M1 后端（可交给 Codex）

> 阅读根目录 AGENTS.md、dev-docs/README.md、SPEC（岗位发现、投递清单、数据模型与留存、CSV 导出）、DATA-MODEL、CONTRACTS、IMPLEMENTATION-PLAN 的 M1、ACCEPTANCE 中 D 组及 M1 出口列出的各项，以及 DEVELOPMENT-STATUS。第 1 步的外壳已提交。
>
> 本步只做 Python 服务与协议，不改界面：
> - 迁移 002：jobs、identities、directions／query、job_directions、applications；状态枚举为 new/applied/oa/interviewing/offer/rejected/ghosted。
> - repository 和命令：jobs.list/detail（完整 FilterSpec、排序白名单、分页、total）、applications.add/add_many/update/set_status/remove/restore、directions.save/delete/reorder、cleanup.preview/execute 与自动清理（可注入时钟）、export.csv（range=filtered/all、include_jd、UTF-8 BOM）、合成岗位导入（开发用）。
> - Electron main 和 preload 为新命令加具名白名单方法和 TS 类型，renderer 暂不调用。
> - 测试覆盖 D 组相关项：重复加入、并发、撤销移出与撤销改状态、清理边界、导出覆盖全部页、多方向不重复。
>
> 契约与文档不一致时，先改 CONTRACTS 等文档，再改代码。完成后运行后端测试和现有前端测试，更新 DEVELOPMENT-STATUS，本地 commit，不推送。

## 第 3 步：M1 列表与业务界面（前端）

> 阅读根目录 AGENTS.md、dev-docs/README.md、SPEC「窗口布局与列表」「批量浏览、筛选与排序」「岗位详情」「投递清单」「CSV 导出」「设置分页」、IMPLEMENTATION-PLAN 的 M1、ACCEPTANCE 中 B01–B04、B09–B12、D18、D19，以及 DEVELOPMENT-STATUS。设计参考为 tmp/m1-design 全部页面。前两步已提交，后端命令已可用。
>
> 在现有外壳上接真实服务，完成 M1 剩余界面：
> - 共用表格：点表头排序、列宽拖动、列显示菜单、横向滚动、评分色块、单行理由。
> - 筛选行：选择按钮及两页各自的条件菜单、N selected、筛选标签、+ Filter、Clear all、分页（50/100/200）。
> - 详情抽屉：Markdown JD、窄窗口下变为浮层；折叠窄条的搜索弹出框和 Searches 弹出列表。
> - Jobs：Add to Shortlist 及结果提示。
> - Shortlist：状态下拉、详情和行内编辑备注、Set status、Remove 不确认＋Undo（applications.restore）。
> - 右下角提示条；Settings 的 Searches 和 Data 分区（含删除确认、清理确认与预览）。
> - 导出对话框：格式切换在只有 CSV 时隐藏。
> - 加载骨架、空结果、请求失败横幅。
>
> 不做 Score 菜单（M3）、Batch 筛选（M2）和 Runs。完成后跑全部测试，截图检查主要页面的三套主题浅色和深色，更新 DEVELOPMENT-STATUS，确认 M1 出口全部通过后本地 commit，不推送。

## 第 2 步执行时确认（2026-10-19）

用户已确认 `run_ids` 批次筛选留到 M2，本步不提前建运行表。其余 M1 筛选与数据协议实现见 CONTRACTS「M1 第 2 步实施补充」。本 worktree 接手时 HEAD 为 M0 的 fa491d0；用户已说明第 1 步由 Claude 在另一 worktree 并行开发。本次仅完成第 2 步，不改 renderer、不擅自合并其他 worktree；后续汇合两个步骤再进入第 3 步。实际验证和提交见 DEVELOPMENT-STATUS。


## 第 1、2 步汇合（2026-10-19）

用户已授权将 m1-shell 合入 main。汇合包含外壳 `4d6c9f4`、窄窗口折叠修复 `d097fa0`、后端 `cd16158` 和导出／响应大小修复 `dbd5e0d`。当前为第 1、2 步的组合交付；第 3 步尚未开始，不能认定 M1 全部出口已通过。

第 1 步原 tmp/M1-STEP1-STATUS.md 记录已迁入 DEVELOPMENT-STATUS；getAppInfo/quit/showDataFolder 已同步 CONTRACTS；模块 README 和 E2E 已合并双方接口、schema 2 及当前连接文案。依用户要求本轮不重跑测试，不重打安装包；各分支既有验证、合并检查及仍缺原生红绿灯目视验收的边界见 DEVELOPMENT-STATUS。后续第 3 步从 main 继续，不再套用“第 2 步 renderer 仍为 M0”的历史描述。

汇合提交：`97d1744 merge: combine M1 shell and backend delivery`（main，本地，未推送）。


## 前两步补验完成（2026-10-19）

用户随后授权完成未完成项并明确不进入第三步。合并后的 73 后端／9 Node／10 开发 E2E 通过；当前 DMG 安装副本 7 E2E 通过、3 项开发导入专用场景按设计跳过，另完成冻结后端 200 条合成业务验证。原生窗口通过 CUA 实际检查，系统共享指示覆盖红绿灯已获用户明确确认正常。此前“尚未重跑／未重打安装包／红绿灯未验”的记录是汇合当时的历史状态，当前前两步这些项目已关闭，实际命令、证据及边界见 DEVELOPMENT-STATUS 文末。本轮仅修正 E2E 在 Quit 后读取已释放 process channel 的清理逻辑，产品功能未改，第三步仍未开始。

补验相关测试修正提交：`226b3b0`（main，本地，未推送）。


## 第 3 步完成（2026-10-19）

用户授权后在 main 上完成第 3 步：列表与业务界面接真实服务，新增具名 openLink 与 markdown-it 依赖（CONTRACTS「M1 第 3 步界面接入」）。73 后端／9 Node／17 开发 E2E 通过，新 DMG 安装副本 14 通过、3 项开发导入场景按设计跳过。M1 三步交付完成；run_ids 批次、Runs、Score 菜单仍属 M2／M3。命令、结果与限制见 DEVELOPMENT-STATUS 文末。
