# M0 完成交接 prompt

阅读根 AGENTS.md、dev-docs/README.md、最新 SPEC、IMPLEMENTATION-PLAN 与 DEVELOPMENT-STATUS；当前 M0 已完成。后端基础提交 9da24e0，桌面补齐提交见状态记录。用户授权 M1 后再推进 M1，不重做已确认的最小桌面设计或扩展产品范围。

应用在 job-vaccum-app/。先读 backend/README.md 和 desktop/README.md；npm run dev 可启动真实 App，npm test / npm run test:e2e / uv run --locked pytest -q 验证，npm run package:mac 产出 arm64 本机测试 DMG。DMG 安装副本已在隐藏源码/.venv/构建目录、受限 PATH 和含空格路径下通过窗口测试；未签名/公证，未在另一台物理 Mac 验证。

M1 按 DATA-MODEL/CONTRACTS 完成合成岗位的真实 SQLite 列表、详情、清单闭环及计划要求的清理/CSV；用迁移 002 追加，不改/重放 001。保留 Python 唯一业务存储所有者、具名 preload、现有进程锁与关窗驻留/有界退出。不要提前做抓取/LLM/计划、自动投递或自定义 hash；不要复用旧 src 或取私人数据。前端开始前读取 AGENTS 指定的 Apple/Emil skills，按需沿用当前样式变量和状态反馈。

按当前阶段做真实测试与 UI 验证，更新本地 dev-docs 状态和契约，阶段完成后本地 commit，不推送；如有未验证项目如实记录。
