---
sidebar_position: 26
---

# Wework macOS 发布

Wework 桌面应用使用 Electron。正式构建和发布由
`.github/workflows/wework-app.yml` 负责；该工作流同时生成 macOS、Windows 和
Linux 的 Electron 应用归档。

## 版本与产物

发布版本同时写入 `wework/package.json` 和 `wework/electron/package.json`。正式
发布时，工作流会提交这两个版本文件，再从该提交构建所有平台，确保关于页、
Electron 应用包和发布标签使用同一版本。

应用构建命令：

```bash
pnpm --filter wework ai:verify:electron:build
```

macOS 产物位于：

```text
wework/electron/release/WeWork-darwin-<arch>/WeWork.app
```

工作流将平台目录打包成 `WeWork_<version>_macos.tar.gz`，并在正式发布时上传到
GitHub Release。

## Bundled sidecars 与资源

构建前必须准备 Codex 和 DWS：

```bash
cd wework
pnpm run prepare:codex --materialize
pnpm run prepare:dws
```

Codex 下载包按 `wework/codex-binaries.lock.json` 固定并校验 SHA-512。准备后的桌面
资源统一位于 `wework/resources/`，Electron 打包脚本
`wework/electron/scripts/prepare-package-assets.mjs` 会把 sidecar、插件、图标和运行时
描述复制到应用资源目录。不要重新建立第二份桌面资源目录或资源清单。

## 本地验证

发布相关改动至少运行：

```bash
pnpm --filter wework typecheck
pnpm --dir wework/electron typecheck
pnpm --dir wework/electron test
pnpm --filter wework ai:verify:electron:build
```

涉及窗口、托盘、IPC、内置浏览器、sidecar 或打包资源时，还必须使用隔离的真实
Electron 会话验证：

```bash
pnpm --filter wework ai:verify start
```

多个 worktree 并行验证时，为每个实例使用独立 `WEWORK_PORT`。隔离会话会使用独立
的 Executor Home、应用数据目录和单实例锁。

## GitHub Actions

`.github/workflows/wework-app.yml` 支持稳定版与测试版渠道、可选版本覆盖、三平台并行
构建、Actions artifact，以及正式 GitHub Release。工作流安装
`wework/electron` 自己的依赖，准备 bundled sidecars，再调用统一的 Electron 构建
命令。桌面资源变化应修改 `wework/resources/` 或 Electron 打包脚本，不要在
workflow 中复制另一份资源列表。
