# Job Vaccum 桌面产品开发入口

状态：工程设计基线；M0 已完成（最小桌面窗口、真实通信及 arm64 测试安装包），业务功能从 M1 起实现。实现进展见 dev-docs/DEVELOPMENT-STATUS.md。

产品基线：面向批量岗位发现、筛选与投递准备；自动评分可关闭；浏览支持批量加入清单、连续审阅和扩展筛选排序。实际投递由用户外部工作流完成。细则见 SPEC 与 CONTRACTS。关闭前端窗口后后台仍按计划运行，显式 Quit 后不调度。

## 执行原则

整个产品从零开发。现有私人 pipeline 只作为行为参考和验收对照，不导入、搬运或原地改造旧代码。使用第三方 JobSpy 库不属于复用私人 pipeline。

产品需求以 [SPEC.md](SPEC.md) 为准；其后的用户明确修订优先。本文档集中的工程初值是为了让开发可以开始，不是已验证的性能或兼容承诺。不要自行增加费用预算、模型适配、评分版本、文件简历解析、历史数据迁移或其他系统客户端。

## 阅读顺序

| 文档 | 用途 |
| --- | --- |
| [SPEC.md](SPEC.md) | 用户功能、范围和验收场景 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 新工程边界、进程职责、初始参数和发行路线 |
| [DATA-MODEL.md](DATA-MODEL.md) | 一岗位一行、关系、去重落库和清理约束 |
| [CONTRACTS.md](CONTRACTS.md) | Electron/Python 消息协议、命令和模型调用 |
| [PIPELINE.md](PIPELINE.md) | 抓取、筛选、评分、停止恢复、代理和调度 |
| [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) | 有依赖顺序的开发阶段与交付要求 |
| [ACCEPTANCE.md](ACCEPTANCE.md) | 自动化测试与手工发行验收清单 |

先读 SPEC 和工程架构，再按阶段读取相关文档；不要只读任务列表就猜数据模型。

## 给开发 Agent 的启动指令

> 阅读 dev-docs/README.md、SPEC.md 和 IMPLEMENTATION-PLAN.md，遵守所在仓库的 AGENTS.md。按 M0 起顺序开发全新的 Job Vaccum 桌面项目，现有私人 pipeline 仅作为行为参考，不改造、不导入旧 src，不读取 .env 或私人结果。先完成当前阶段的可运行交付和验收，再进入下一阶段。默认使用合成岗位、模拟抓取和模拟 LLM；真实网站和付费接口测试单独记录。每阶段报告修改、实际执行的测试、已知限制及下一阶段。不要仅搭页面或留下空实现就宣称完成。遇到工程细节按文档初值推进，只有产品范围冲突才提出问题。

本指令用于用户后续授权的开发，不表示本轮文档编写已经开始运行这些任务。

## 交接记录要求

开发开始后，在 `dev-docs/DEVELOPMENT-STATUS.md` 维护开发状态，记录阶段状态、实际启动与测试命令、验证环境、未完成项和重要决定。当前文档不虚构尚未建立的可运行命令。

不把所有任务标成完成再统一测试。阶段中发现契约必须变更时，同步修改契约、调用方和验收项；不能只改一层。

## 私人代码参考材料

本机原项目路径为 `/Users/tim77/Documents/cy-automation/job-vaccum`，以下旧相对链接表示原项目内文件，并非当前仓库文件。访问方式、只读边界及用户指定的两个设计 skills 见仓库根目录 [AGENTS.md](../AGENTS.md)。

- [pipeline 说明](../README.md)
- [筛选和去重行为](../FILTERING-AND-DEDUP.md)
- [抓取封装参考](../src/job-retrieve.py)
- [筛选行为参考](../src/job_filters.py)
- [身份和内容归一化参考](../src/job_records.py)
- [代理行为参考](../src/proxy_pool.py)
- [执行与退避行为参考](../src/run-pipeline.py)

公开新项目不依赖这些相对路径存在。行为定义和合成验收用例应随新工程保存；不打包私人配置、rubric、账号或结果。
