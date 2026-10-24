# Job Vaccum 开发约定

## 开发入口与范围

- 先读 `dev-docs/README.md`（含阅读顺序）；产品范围以 `dev-docs/SPEC.md` 为准，按 `dev-docs/IMPLEMENTATION-PLAN.md` 的 M0–M9 阶段及依赖交付，每阶段读取相关契约；M8/M9 加读 `dev-docs/M8-M9-MCP.md`。代码在 `job-vaccum-app/`（desktop 前端、backend 后端），`dev-docs/` 是唯一工程设计来源。
- 用户最新明确要求优先。日常工程细节自行决定；只完成用户授权的阶段及对应验证，不自行增加功能、扩大范围或重做已确认的设计，不以计划、空实现或静态页面代替真实交付。
- 当前进度、验证环境及启动/测试/打包命令只在 `dev-docs/DEVELOPMENT-STATUS.md` 维护，具体操作可引用对应模块 README；不在本文件重复记录动态状态。

## 简单实现优先

- 用满足当前明确需求的最直接实现；局部问题局部修改，不顺带重构，不为假设中的规模、平台或故障增加依赖、通用框架、抽象层、持久状态或空模块。
- 不新增自定义 hash 计算或完整性校验流程；依赖使用既定版本和标准 lockfile。岗位去重与评分任务规则按 DATA-MODEL、PIPELINE，不自行增加摘要去重、跨岗位输入缓存、在途共享或结果复制。
- 不加文档没要求的重试、回退、自动修复、恢复机制、操作防重或双份存储；失败清楚报错，保留已成功提交的数据。文档要求的输入校验、数据库约束、事务、超时、有限重试和任务恢复必须保留，也不额外叠加防御层。
- 不为前端细节新增业务表，不新增通用 contracts/schema 工程或双端 JSON Schema。
- 测试围绕实际业务边界和真实失败风险，满足阶段验收后交付，不反复增加防护工程。

## 原项目只读参考

- 原项目：`/Users/tim77/Documents/cy-automation/job-vaccum`；可参考的文件清单见 `dev-docs/README.md`。
- 只作行为参考，不修改、不导入或搬运旧 src，不作为产品运行或打包依赖；不读取 `.env`、账号、私人结果或私人配置来启动测试。
- 参考后用合成用例独立实现；新文档与旧代码冲突时以新文档为准。原项目不可访问时如实记录，不猜测未核实的旧规则。

## 前端设计 skills

开始前端实现或审阅时先读取以下 SKILL.md（路径相对仓库根目录），按需读取其引用资源；不可访问时报告具体路径，不宣称已使用：

- Apple 界面原则：`.agents/skills/apple-design/SKILL.md`
- Web 组件、动效、性能与可访问性：`.agents/skills/emil-design-eng/SKILL.md`

界面设计以 SPEC（「窗口布局与列表」、配色表等）为准，skills 只用于提升实现质量；两者冲突时以 SPEC 为准。不增加手势或动画系统；高频操作不加拖慢浏览的动效，其他动效简短、可中断，尊重 reduced-motion。

## 环境与仓库操作

- 环境已配置，不重复初始化或无理由升级。Python/Node 版本以 `.python-version`、`.node-version` 和项目声明为准，依赖以声明和 lockfile 为准；JobSpy 必须保留 ARCHITECTURE 指定的完整提交 SHA，不用浮动 main 或包版本号替代。
- Python 使用 .python-version 指定版本及 uv 管理的独立虚拟环境，由 uv 解析/准备解释器，不要求 pyenv、不限制 uv 下载；不向全局环境安装依赖；执行后端命令使用 `uv run --locked`。前端使用 npm，不混用包管理器；依赖变更同步声明与 lockfile。
- 换机器按声明准备解释器，不复制 `.venv` 或 `node_modules`。本机绝对路径不得写入产品运行或打包代码；开发/正式运行数据目录遵循 ARCHITECTURE，不入版本控制。
- `AGENTS.md` 和 `dev-docs/` 纳入 Git，与应用代码、依赖、测试和打包配置一起维护；`.agents/` 仍由 Git 忽略，换机器或新建 worktree 时手动复制。

## 多 Agent 协作

- 每个写代码的 Agent 使用独立 worktree 和分支，不直接修改 main。
- 开工前明确分工和接口，避免重复修改同一部分。
- 从最新 origin/main 开始；开发中用 merge 同步主线，不默认 rebase 或强制推送。
- 默认只完成本地验证和提交；用户授权推送后执行下述流程。仅要求本地提交时不启动远端流程，不自动发布。
- 推送前 `git fetch origin`，在自己的开发分支用 `git merge origin/main` 同步主线，完成相关本地验证后 `git push origin <开发分支>`。Codex 使用 `codex/dev`，Claude 使用 `claude/dev-env`。
- Agent 自行判断改动是否集中、验证完成且适合审阅，合适时提指向 main 的 PR；已有对应 PR 则更新，不按每次 commit 或 push 拆 PR。PR 说明变更、验证及限制；交接时告知本轮是否提了或更新了 PR，并提供链接。
- 默认不合并 PR、不开启自动合并；用户明确要求合并后才执行，且须通过 Backend、Frontend、Desktop E2E 必需检查。不使用 `--admin` 绕过检查，不关闭主线保护，不删除长期开发分支。CI 失败或冲突时修复、验证、再推送；不能修复则报告原因。
- 合并后确认 PR 状态与 main CI 结果，在两个工作区 fetch、merge origin/main，并正常 push 回各自开发分支；纯同步不提 PR。有未提交改动或其他 Agent 正在工作时保留现场并报告暂缓同步。无需 checkout main，整体联调按变更范围执行。
- CI 与交付命令详见 `.github/CI.md`。
- 各 worktree 通过 Git 同步 AGENTS.md 和 dev-docs/，不要用整目录复制覆盖未提交的文档改动；.agents/ 单独复制，依赖分别安装。修改开发约定后随提交同步到其他活动 worktree，保留各目录独有的有效内容。

## 验证与交接

- 默认使用合成岗位及各阶段要求的 fake scraper/fake LLM。真实网站、付费模型和代理测试只使用用户明确提供的测试条件，不取用私人凭据。
- 完成 IMPLEMENTATION-PLAN 与 ACCEPTANCE 的阶段验证；开发模式启动不能代替安装包验证，未实际检查的项目不得写成通过。
- UI 实现后实际运行，检查窗口、溢出、空/加载/错误状态、键盘焦点和 reduced-motion。
- 更新 DEVELOPMENT-STATUS，记录实际交付、执行过的命令、验证环境、结果和未完成项；按阶段 commit，不自动推送或发布。未经用户确认，不改写已推送的历史，不强制推送。
