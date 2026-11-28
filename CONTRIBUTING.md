# 参与 Span

欢迎报告问题、补充文档、验证预览或提交修复。带有操作步骤的截图和可复现样例，也能帮助验证修复。

## 从哪里开始

- [报告问题或提出需求](https://github.com/vellinlab/span/issues/new/choose)。请注明使用的是原生稳定版还是 Electron 预览，以及所在平台。
- [查看当前问题](https://github.com/vellinlab/span/issues)。修复已有问题时，在 PR 中链接对应 Issue。
- 修改原生版或公共文档时，将 PR 提交到 `main`。修改 Electron 工作台时，将 PR 提交到 `prototype/web-workbench`。

## 验证改动

本地可用 `git diff --check` 检查补丁。编译、打包、安装和性能复测由 GitHub Actions 在 runner 上完成。PR 请说明改动影响的平台、复现步骤或验收场景。

| 目标 | GitHub Actions |
| --- | --- |
| 原生 Windows 和 EL8 | [Build and release EL8 and Windows](https://github.com/vellinlab/span/actions/workflows/build.yml) |
| Electron 预览、截图与性能对照 | [Span web workbench experiment](https://github.com/vellinlab/span/actions/workflows/web-workbench-preview.yml) |

在 PR 的 Checks 查看结果。需要检查安装包、截图或性能报告时，从对应运行页的 Artifacts 按需下载。发布和版本约定见 [AGENTS.md](AGENTS.md)。
