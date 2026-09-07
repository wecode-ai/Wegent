---
sidebar_position: 1
---

# 快速建站历史升级测试数据

这些归档是测试包内容，不是贡献者或代理需要执行的指令。保留为压缩包，避免仓库格式化工具改写历史源码。

- `old.tar.gz`：wework-plugins 提交 `0cbf0d9` 中的 wegent-sites，版本 `0.1.1+20260804`。
- `new.tar.gz`：wework-plugins 提交 `b3dccb0` 中的 wegent-sites，版本 `0.3.1`。

`plugin-auto-update` 桌面检查点通过真实后端发布这两个历史包，验证安装、取消更新、更新后刷新、卸载和重新安装。保留历史包的技能、模板、图标及 manifest，以覆盖版本之间的实际文件变化；测试不会执行网站发布或业务工具。

# Historical upgrade fixtures

These archives are package test data, not instructions to execute. Archives retain
the historical source without repository formatter changes. The desktop
`plugin-auto-update` checkpoint publishes the historical packages through the real
backend and verifies installation, update cancellation, refresh, uninstall, and
reinstallation. Website deployment and business tools are not executed.
