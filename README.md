# Job Vaccum

面向 macOS Apple Silicon 的本地岗位管理桌面应用，用于浏览、筛选岗位，整理投递清单并导出 CSV。实际投递由用户在外部完成。

项目正在开发中：已有岗位列表、详情、筛选排序、投递状态与备注，以及 JobSpy 检索后端；检索界面、AI 评分和定时运行仍在后续开发范围内。当前不是正式签名发布版本。

## 技术与目录

- [桌面端](job-vaccum-app/desktop/README.md)：Electron、React、TypeScript。
- [后端](job-vaccum-app/backend/README.md)：Python、JobSpy、SQLite，数据保存在本机。
- [CI 与协作流程](.github/README.md)：后端测试、前端类型检查与构建、Electron E2E 冒烟测试，以及 PR 自动合并。

## 本地开发

准备 macOS Apple Silicon、uv 和 Node.js；Python 与 Node 版本分别以 `job-vaccum-app/.python-version`、`job-vaccum-app/.node-version` 为准。在仓库根目录执行：

```sh
cd job-vaccum-app/backend
uv sync --locked --python "$(cat ../.python-version)"
cd ../desktop
npm ci
npm run dev
```

测试与打包命令见各模块 README。默认自动化测试使用合成数据，不需要真实网站账号或付费模型服务。依赖使用已提交的 lockfile；本地开发约定和设计文档不随仓库分发。
