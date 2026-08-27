---
sidebar_position: 26
---

# Wework 桌面版发布

Wework 桌面应用使用 Electron。正式构建和发布由
`.github/workflows/wework-app.yml` 负责；该工作流同时生成 macOS、Windows 和
Linux 的 Electron 安装包。

## 版本与产物

发布版本同时写入 `wework/package.json` 和 `wework/electron/package.json`。正式
发布时，工作流会提交这两个版本文件，再从该提交构建所有平台，确保关于页、
Electron 应用包和发布标签使用同一版本。

Electron 发版构建命令：

```bash
pnpm --dir wework/electron build:release
```

产物位于 `wework/electron/release-installer/`，主要包括：

```text
WeWork_<version>_macos_<arch>.dmg
WeWork_<version>_macos_<arch>.zip
WeWork_<version>_windows_x64-setup.exe
WeWork_<version>_linux_x64.AppImage
```

## 自动升级与 Tauri 迁移

Electron 版本通过 `electron-updater` 检查 `wework-updater` Release 中的
`latest*.yml` 或 `beta*.yml`，下载完成后先关闭本地运行时，再安装并重启。
如果所选通道尚未发布 Electron 版本，对应 YAML 清单可以不存在；客户端将其视为
“暂无可用更新”，而不是网络错误。其他检查失败仍需原样报告。

为让已安装的 Tauri 版本直接使用设置页的“升级”迁移到 Electron，同一次发布还会
生成旧 updater 协议的 JSON 和签名产物：

- macOS：将签名后的 Electron `WeWork.app` 额外打成 `.app.tar.gz`，Tauri updater
  原位替换应用包，应用标识和可执行文件名保持不变。
- Windows：Tauri updater 下载 Electron NSIS 安装器。安装器兼容 Tauri 的 `/P`
  被动安装参数，并继承旧版 `Software\you\WeWork` 注册表项及
  `%LOCALAPPDATA%\WeWork` 安装目录；旧安装被卸载后，Electron 写回同一路径，旧版
  的 relaunch 因此直接启动 Electron。
- Electron 直接使用旧版的 Executor Home `~/.wework`，不会复制或迁移执行器
  数据；本地项目、任务、会话和 Wework Codex Home 继续从原目录读取。应用标识
  `io.wecode.wework` 和产品名 `WeWork` 保持不变。
- Linux 暂不提供应用内自动升级，继续使用 AppImage 手工替换。

正式发布必须同时配置现有平台签名凭据和
`TAURI_SIGNING_PRIVATE_KEY`/`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。后者只用于给
兼容旧 Tauri updater 的桥接产物签名；Electron 后续升级使用 YAML 清单中的
SHA-512 校验。

## 初始包与组件更新

初始 Electron 安装包必须包含一套可离线启动的完整运行环境：

- Electron；其内置 Node 同时供 Electron 主进程、Core DSH、插件子进程和
  Codex skill 脚本使用；
- Core DSH；
- Wework 核心 DSH 插件；
- Executor；
- Codex。

`components.json` 记录应用版本、发布通道、每个组件的版本、资源路径和内容
SHA-256。Electron 应用本身仍通过 `electron-updater` 升级；其余四个组件使用
`components-<channel>-<platform>-<arch>.json` 独立升级。

组件压缩包以压缩包 SHA-256 命名，并作为不可变资产存放在
`wework-updater` Release。发布新版本时只上传远端尚不存在的哈希资产；未变化的
Core DSH、核心插件、Executor 或 Codex 直接复用，正式版本 Release 不再重复
携带这些组件包。每次发布只覆盖很小的滚动组件清单。

客户端只接受与当前 Electron 应用版本、通道、平台和架构完全匹配的组件清单。
下载后先校验压缩包大小与 SHA-256，再解压并校验组件内容 SHA-256。组件先写入
用户数据目录的内容寻址存储并标记为 `pending`，下次启动时通过一个原子状态文件
整体切换。工作台和 Core DSH 完成启动后才确认新组件；如果启动失败或进程在确认前
退出，下次启动自动回滚到上一组组件。打包内资源始终保留为最终兜底。

Wework 不再打包或下载第二份 Node。启动时会在用户数据目录生成轻量 `node`
入口，将 `PATH`、`WEWORK_NODE_PATH`、`NODE` 和 `npm_node_execpath` 统一指向
Electron，并设置 `ELECTRON_RUN_AS_NODE=1`。因此 Core DSH 以及 Codex skill 中
显式执行的 `node script.ts` 或 `#!/usr/bin/env node` 都使用与当前 Electron
版本绑定的 Node。

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
pnpm --dir wework/electron build:release
```

涉及窗口、托盘、IPC、内置浏览器、sidecar 或打包资源时，还必须使用隔离的真实
Electron 会话验证：

```bash
pnpm --filter wework ai:verify start
```

多个 worktree 并行验证时，为每个实例使用独立 `WEWORK_PORT`。隔离会话会使用独立
的 Executor Home、应用数据目录和单实例锁。

## GitHub Actions

`.github/workflows/wework-app.yml` 支持稳定版与测试版渠道、可选版本覆盖、三平台
并行构建、Actions artifact、正式 GitHub Release，以及 Electron/Tauri 两套滚动
升级清单。稳定版同时推进 stable 和 beta 渠道，测试版只推进 beta 渠道。工作流
安装 `wework/electron` 自己的依赖，准备 bundled sidecars，再调用统一的 Electron
构建命令。桌面资源变化应修改 `wework/resources/` 或 Electron 打包脚本，不要在
workflow 中复制另一份资源列表。

滚动通道只有在 Electron YAML、三平台旧 Tauri JSON 和四个构建目标的组件清单全部
存在时，才可因版本未变而跳过上传。相同版本但资产不完整时必须补齐；如果远端是
不完整的更高版本，工作流必须失败，避免用旧版本覆盖。组件压缩包不可覆盖，只能在
对应内容哈希尚不存在时上传。
