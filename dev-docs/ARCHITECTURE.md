# 工程架构与初始决定

## 1. 新项目边界

当前仓库作为产品 repo，应用代码集中于 `job-vaccum-app/`；根 `AGENTS.md` 与 `dev-docs/` 纳入 Git，原项目保持只读参考。应用代码、依赖声明、lockfile、测试、打包配置与开发文档一起维护；`.agents/` 仍仅在本地准备。

目标目录（目前仅建立环境骨架；其余按开发阶段创建）：

```text
job-vaccum-gui/
  AGENTS.md                   # 开发约定，Git 跟踪
  .gitignore
  dev-docs/                   # 工程设计文档，Git 跟踪
    DEVELOPMENT-STATUS.md     # 开发状态与验证记录
  job-vaccum-app/
    .python-version
    .node-version
    desktop/
      package.json
      package-lock.json
      tsconfig.json
      vite.config.ts
      src/
        main/                 # 窗口、后台计划、Python 生命周期
        preload/              # 具名白名单接口
        renderer/             # React 页面、组件、样式
        shared/               # TS 消息类型等必要共用定义
        env.d.ts
      tests/                  # 前端及 Electron 单元测试
    backend/
      pyproject.toml
      uv.lock
      src/job_vaccum/
        service/              # 命令分发、配置、任务协调
        storage/              # sqlite3、SQL 迁移和查询
        domain/               # 岗位、筛选与去重
        workers/              # JobSpy 抓取子进程
        llm/                  # HTTP 协议、线程池及限速
        proxy/                # Mihomo 控制与调度
      tests/                  # Python 单元及集成测试
    fixtures/                 # 共用合成数据，无私人数据
    tests/                    # 跨进程/端到端测试
    packaging/                # Python/Electron 打包配置及资源
  tmp/job-vaccum-app/          # 开发运行数据，忽略、不提交
```

`.venv/`、`node_modules/`、构建产物及本机运行数据均不提交。目录不是必须提前创建的模块清单；小功能可以先用单文件实现，按实际规模拆分。无需新增通用 schema/契约工程或内部工作区包管理体系。

开发路径相对新工程或当前仓库根目录解析。开发运行数据与临时文件写入仓库已忽略的 `tmp/job-vaccum-app/`。独立发布后用 Electron 的用户数据目录作为运行根目录，不把数据库写进 App bundle，也不写死用户名或机器绝对路径。Mihomo 路径是用户选择的外部路径。

## 2. 技术选择

- Electron + React + TypeScript；Vite 构建前端，使用简单路由和表格，不引入服务端框架。
- Python 3.13 + JobSpy；产品自己的依赖与 lockfile 独立。JobSpy 采用下述已审阅提交作为新工程基线，不沿用私人 pipeline 的 1.1.82；开发环境安装/导入已验证，打包仍需验证，不跟随浮动 main。
- SQLite，使用 Python 标准库 sqlite3 与显式 SQL 迁移；首版无需 ORM 或独立数据库服务。
- 产品自己的 LLM HTTP 调用使用 requests，四种协议各一个薄适配器，无提供商 SDK、Agent 框架或自动模型选择。
- Python 打包优先验证 PyInstaller onedir；Electron 打包优先验证 electron-builder。这些是工程起点，M0 若证明不可用可替换工具并记录原因，不改变产品范围。
- 仅 macOS arm64。最低系统版本在 M0 结合所锁 Electron 版本和实际测试环境记录；不能对未测试版本宣称支持。

### JobSpy 依赖基线

2026-10-18 源码审阅基线为 [1988484ac76ff9ae57784750346842e967e8ba10](https://github.com/speedyapply/JobSpy/commit/1988484ac76ff9ae57784750346842e967e8ba10)（2026-10-14 提交）。当时正式 Release/PyPI 为 1.3.0，但该提交包含发布后的严格参数校验、标准 logging、空结果列结构及 DataFrame.attrs 诊断等改动，不能用 `python-jobspy==1.3.0` 代替这个提交。

- 建立工程时用完整 Git SHA 固定源码，并在独立 lockfile 固定解析后的依赖；不使用浮动分支。运行配置快照记录 jobspy_commit，开发交接记录同时保存包版本和 SHA，不能仅凭版本字符串识别此基线。
- 首版显式限定 linkedin/indeed，每个任务只调用一个平台，不采用库的默认平台集合；不做新平台接入或分页恢复。
- 对外仅依赖 scrape_jobs 和 DataFrame 输出，不复用旧内部 Scraper/JobResponse/create_session API。HTTP 观测必须接触内部网络层时，限于工作进程中的小适配点，随 SHA 做回归验证。
- 新依赖使用 curl_cffi 代替 tls-client，且 pandas/markdownify 等约束已变化。即使只启用两个平台，JobSpy 的模块导入仍需要相关依赖；不得仅按启用平台裁掉 curl_cffi。Python 版本按 .python-version（当前 3.13.12），uv 创建独立虚拟环境；2026-10-19 用户确认跟随 main 的环境约定，不强制 pyenv 或禁用解释器下载；本机 arm64 已验证安装、JobSpy/pandas/curl_cffi 导入和 SQLite 读写。M0 仍需验证 PyInstaller 收集及完整 App 打包，不把开发环境导入通过视为发行兼容验证。

来源：[锁定提交的公开入口](https://github.com/speedyapply/JobSpy/blob/1988484ac76ff9ae57784750346842e967e8ba10/jobspy/__init__.py)、[依赖](https://github.com/speedyapply/JobSpy/blob/1988484ac76ff9ae57784750346842e967e8ba10/pyproject.toml)、[网络封装](https://github.com/speedyapply/JobSpy/blob/1988484ac76ff9ae57784750346842e967e8ba10/jobspy/util.py)。

## 3. 进程职责

```text
React UI
   │ 白名单 preload API
Electron main ── 文件对话框、凭据加密、外链、窗口、周期触发
   │ JSON Lines stdin/stdout
Python service ── 配置、SQLite、事务、运行状态、命令调度
   │ 内部消息 / 受控子进程
工作进程 ── JobSpy 抓取
Python service 内线程池 ── LLM HTTP（统一并发/RPM）
   │
可选 App 专用 Mihomo 实例
```

Python service 是业务数据的唯一所有者。写入通过一个串行写入队列，抓取网络调用在子进程、LLM 调用在 service 内线程池完成；不得边等待网络边持有事务。UI 查询可以在独立只读连接执行，启用外键、WAL 和有限 busy timeout。

工作进程不直接修改用户数据库；JobSpy 返回的 DataFrame 在内存处理，通过内部通道返回结构化记录、诊断和任务结果，不落抓取 JSON/CSV 或 manifest。service 串行校验、去重匹配并按抓取任务原子提交岗位、按本轮自动评分开关需要创建的待评分任务和完成状态。抓取与评分独立调度、允许重叠；评分无需等待整轮抓完，所有 LLM 调用仍共享全局并发/RPM。长任务接受后立即返回 operation/run ID，不能阻塞接收停止命令或清单操作。抓取 HTTP 观测仅在抓取工作进程中使用，不能污染其他网络请求。

Electron 获取单实例锁。Python service 还应持有该数据目录的进程锁，阻止误启动两个服务；锁不局限于某个运行目录。

## 4. 本地数据与凭据

运行目录建议包含 `app.sqlite3`、`logs/`、`tmp/`、加密凭据文件。外部导出目标由用户通过保存对话框指定。

模型 Key 和带认证的代理信息由 Electron main 使用 safeStorage 加密保存，只在需要时通过私有进程通道注入内存；renderer 只收到 `has_key`，不回显已保存明文。SQLite、配置快照、命令日志中不含秘密。加密不可用时明确报错，不静默明文落盘。[Electron safeStorage 文档](https://www.electronjs.org/docs/latest/api/safe-storage)

关闭主窗口（红色关闭按钮）只关闭前端页面，保留 Electron main、Python service 和计划时钟；无人打开页面时仍到点启动任务。Dock 图标只在窗口打开时显示；菜单栏图标（Electron Tray）默认显示、可在设置关闭，提供打开窗口、状态与退出。两者都隐藏时可从 Spotlight/应用程序文件夹再次打开，单实例锁使其恢复原窗口。显式 Quit/Cmd+Q 执行有界退出，不承诺退出后调度；具体停止与退出规则见 PIPELINE。电脑休眠/关机时不保证准点运行，唤醒或重新打开后最多补跑一次；不添加系统守护进程、开机自启或自动唤醒。应用崩溃后依靠数据目录锁确认旧 service 已退出再恢复持久状态，不扫描遗留 PID 自动杀进程；Mihomo 端口占用明确报错。

## 5. 工程初值

下面是待实测的工程初值，不是费用预算。高级设置允许调节对应参数。

| 参数 | 默认模式 | 高级模式初值 |
| --- | --- | --- |
| LinkedIn results_wanted | 10 / 任务 | 100 / 任务 |
| Indeed results_wanted | 100 / 任务 | 200 / 任务 |
| 非代理池检索并发 | 全局 1 | 每平台 1，可调 |
| LLM 并发 | 1 | 4，可调 |
| LLM RPM | 10 | 30，可调 |
| 整条抓取超时 | 600 秒 | 600 秒，可调 |
| 网络任务最多尝试 | 3 | 3，可调 |
| LLM 连接／读取超时 | 10 / 120 秒 | 同左，可调 |
| 重试基础间隔 | 5 秒 | 5 秒，可调 |
| 发布时间范围 | 72 小时，0 表示不限 | 同左 |
| Indeed 国家 | usa | usa |

RPM 约束所有实际 LLM 请求起始时间，包括重试、连接测试、引导和重评。采用不突发的间隔调度；不是每分钟花费上限。高级模式字段必须为合法正数，RPM 不为空；可选模型生成参数与这些运行参数分开。

Mihomo 初值：8 个端口、每端口并发 2、批次 2、起始端口 7901、控制端口 9099、出口冷却 300 秒、最大候选 30、延迟阈值 1000ms、压力退避 30 秒、保留节点等待 5 秒、429 比率阈值 0.15。界面允许修改；端口冲突报错，不抢占其他服务。

默认方向在引导中生成，不默认启用私人 AI/ML/DE/Backend 四分类。城市提供通用美国城市条目；2026-10-19 用户明确指定 19 个美国城市全部默认启用及各自半径，覆盖原“初始只启用少量城市”的初值；用户可增删启停。规则初始为保守通用配置：无效空记录和测试招聘可启用，其余资格／层级／专业排除由用户选择，不继承个人身份假设。

## 6. 界面实现边界

英文导航：Jobs、Shortlist、Runs、Settings；搜索方向在界面上称 Searches。内部标识（scope=discover/applications、applications.* 命令、directions 表）不随界面名称改变。共用 JobDetail drawer。窗口隐藏原生标题栏（红绿灯由系统绘制），侧边栏可折叠为窄条，主区域为圆角卡片；两页共用表格组件，支持列宽调整、选择显示的列和横向滚动，默认窗口 1280×800、最小 640×480，布局、选择、分页、提示条和错误状态见 SPEC「窗口布局与列表」。列表默认首次发现倒序，评分排序时无分数在后，稳定以 job ID 作为最后排序键。

Shortlist 的 Remove 删除清单关系，显示勾选数，不弹确认，右下角提示条提供 Undo；全选仅当前页，翻页清除当前选择，不假装已选择所有筛选结果。Settings 的 Clear job data 保留 Shortlist 和配置，两个动作文案不可混用。

首次引导：模型连接 → 求职方向 → 规则 → 粘贴简历文本及生成 rubric → 检查运行。每步可 Skip；跳过 rubric 时 auto_score_enabled 保存为 false。Jobs 与 Shortlist 共用表格组件。简历只用 textarea，不做上传、文件解析或 OCR。各步骤草稿自动保存；AI 结果编辑后 Apply 才写正式配置，失败保留输入。不在后台自动生成或评分。

渲染 JD/rubric 时关闭原始 HTML 或执行严格清洗，不执行岗位内脚本。外链经 main 限制为 http/https 并由系统浏览器打开。renderer 不获得任意 shell、文件或数据库访问能力。

## 7. 早期安装验证

M0 必须做最小 arm64 安装包：在不依赖项目 .venv、shell PATH 或用户 Python 的条件下启动 Python，导入锁定提交的 JobSpy 和 curl_cffi，确认所需原生库可加载，完成协议握手及临时数据库读写。不能等全部 UI 做完才验证 Python 能否随包工作。

正式发行再补签名、公证、许可声明和卸载说明。若缺少签名凭据，可交付明确标记的本机测试包，不宣称已完成公开发行。公开包采用文件白名单，禁止把整个私人仓库作为打包输入。
