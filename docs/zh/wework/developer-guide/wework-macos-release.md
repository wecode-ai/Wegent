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

macOS 和 Windows 的正式版本 Release 必须分别包含 ZIP 和 NSIS 安装器对应的
`.blockmap`。`electron-updater` 使用上一版本缓存和新旧 blockmap 计算差分，只下载
变化的数据块；首次更新、缓存被清理或差分失败时才回退到完整安装包。构建产物缺少
任一 blockmap 时发布流程必须失败。差分计划、实际下载量和回退原因记录在应用日志
目录的 `app-update.log` 中。

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
- 内置个人插件与 Skills；
- Executor；
- Codex；
- DWS。

`components.json` 记录应用版本、发布通道、每个组件的版本、资源路径和内容
SHA-256。Electron 应用本身仍通过 `electron-updater` 升级；其余六个组件使用
`components-<channel>-<platform>-<arch>.json` 独立升级。

组件压缩包以压缩包 SHA-256 命名并作为不可变资产保存。本项目源码构建的 Wework
核心插件及 UI、内置插件和 Executor 压缩包存放在对应的版本 Release；外部 Core
DSH、Codex 和 DWS 压缩包集中存放在 `wework-updater`，供不同版本复用。每次发布
对应的版本 Release 都携带完整安装包和当次组件清单，并且只向相应位置上传尚未存在
的哈希资产。

版本边界按是否必须与 Electron 宿主原子兼容划分：

- 跟随应用版本：Electron/Chromium/Node、主进程、preload、启动 Shell、Host
  capability 实现、原生 Node 模块、应用标识、签名权限、图标、安装器、updater
  协议与不兼容的本地数据迁移；
- 独立组件版本：Core DSH、Wework 核心 DSH 插件及 UI、内置个人插件与 Skills、
  Executor、Codex、DWS；
- 用户从插件市场安装的插件继续由插件系统独立管理，不进入桌面组件发布。

独立组件仍必须与当前 Electron `appVersion` 精确匹配，并作为一个组件集合原子
切换。如果某个组件开始依赖新的 Host capability、原生模块或不兼容的数据格式，
该次发布自动升级为整包发布。

Wework UI、核心插件、内置个人插件和 Executor 共用同一个
`wework-<sourceSha12>` 运行时版本，其中 `sourceSha12` 是源码提交 SHA 的前 12
个十六进制字符；它们通过同一份组件清单原子切换。物理上仍使用独立的内容寻址
压缩包，因此只下载发生变化的文件；这个拆分只是传输优化，不代表 Executor 独立于
Wework 发布。Codex 和 DWS 保留各自的产品版本。

发布工作流会自动比较上一次组件清单记录的源码提交。如果改动只影响可管理组件，
当前 Electron 应用版本保持不变，已安装客户端只收到组件清单；Electron 主进程、
preload、打包资源或发布边界发生变化时，工作流才提升应用版本并推进 Electron
整包更新清单。无法安全归类的 Wework 改动一律按整包更新处理。

无论选择组件更新还是整包更新，每次发布都会创建一个不可变的版本 Release，并
携带包含最新组件的完整安装包。整包更新使用 `wework-v<appVersion>` 标签；组件
更新使用 `wework-v<appVersion>-runtime.<sourceSha12>` 标签，其中 `sourceSha12`
是源码提交 SHA 的前 12 个十六进制字符，不提升 Electron `appVersion`。稳定渠道
的最新版本 Release 标记为 GitHub `latest`，新人从该 Release 下载完整安装包，
任意历史 Release 也都可以独立完成首次安装。

本项目源码构建的 Wework 核心插件及 UI、内置插件和 Executor 组件包上传到对应的
版本 Release。Core DSH、Codex、DWS 等外部或非本项目源码构建的二进制依赖，以
内容哈希命名并统一存放在 `wework-updater`，供不同版本复用。滚动组件清单也发布
到 `wework-updater`，但这里不再作为新人完整安装包的下载入口。已有用户因此只
下载实际发生变化的组件，无需因为纯 Wework UI 或组件改动重复下载 Electron 和
Chromium。

客户端只接受与当前 Electron 应用版本、通道、平台和架构完全匹配的组件清单。
清单中的 `downloadUrl` 可以指向版本 Release、共享依赖 Release 或独立对象存储，
不要求与滚动清单同源或位于同一路径。下载内容的可信边界由完整性校验确定：客户端
先校验压缩包大小与 SHA-256，再解压并校验组件内容 SHA-256。组件先写入用户数据
目录的内容寻址存储并标记为 `pending`，下次启动时通过一个原子状态文件整体切换。
工作台和 Core DSH 完成启动后才确认新组件；如果启动失败或进程在确认前退出，下次
启动自动回滚到上一组组件。打包内资源始终保留为最终兜底。

Wework 不再打包或下载第二份 Node。启动时会在用户数据目录生成轻量 `node`
入口，将 `PATH`、`WEWORK_NODE_PATH`、`NODE` 和 `npm_node_execpath` 统一指向
Electron，并设置 `ELECTRON_RUN_AS_NODE=1`。因此 Core DSH 以及 Codex skill 中
显式执行的 `node script.ts` 或 `#!/usr/bin/env node` 都使用与当前 Electron
版本绑定的 Node。

该入口还会预加载标准流保护脚本。stdio MCP 或其他 Node 子进程的消费端关闭后，
向已断开的 `stderr` 写诊断信息不得触发 Electron 的主进程异常弹窗；协议
`stdout` 断开则表示调用方已经离开，子进程应正常退出。保护只处理 `EPIPE`，
其他标准流错误仍保持失败并暴露根因。自定义 Node 可执行文件使用原生 Node
错误处理，不加载这段 Electron 专用逻辑。

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

当前固定版本为 Codex `0.152.1`。Codex `0.152` 开始默认关闭
`tools.update_plan.enabled`，但 Wework 会消费对应的计划事件并渲染计划块，因此
Executor 启动 Codex 时必须显式启用该工具。桌面 E2E 默认验证锁文件中的二进制；
只有专用的 `WEWORK_E2E_CODEX_BIN` 可以覆盖它，不能继承通用 `CODEX_BIN`，否则
本机已安装应用中的旧版本可能绕过待验证的仓库版本。

桌面发行物还必须携带项目及 bundled sidecar 的许可证和归属信息：

- 应用资源根目录的 `LICENSE` 是 Wegent 的 Apache-2.0 许可证；
- `licenses/` 保存 CUA Driver 等 Electron 依赖的第三方许可证；
- `codex/legal/` 保存 Codex 的 Apache-2.0 许可证、`NOTICE` 和 Ratatui MIT
  许可证。

`prepare-codex-binary.mjs` 生成 Codex legal 目录，
`prepare-package-assets.mjs` 必须将其与目标架构二进制一起复制到桌面资源。修改
打包链路时，应解包或检查真实应用产物，确认这些文件存在且与仓库中的源文件一致；
仅检查中间资源目录不能证明最终发行物合规。

## 开发模式热更新

`pnpm --dir wework run dev:mac` 会通过
`wework/scripts/dev-wework-app-watch.mjs` 持续构建原始 Wework 应用。监听器启动时
清理一次 `dsh/app-wework/web`，后续增量构建不得再次清空该目录；正在运行的
renderer 可能仍在请求上一代哈希资源，提前删除会在新产物写入期间造成白屏。

每次构建只有在 Vite 完成 bundle、关闭构建结果并规范化文件查看器元数据后，才能
写入 `.wework-build-id`。Core DSH 使用这个标记作为已发布构建 ID，页面只在标记
变化后刷新，不能把 `index.html` 的中间写入状态当成可加载版本。

开发热更新模式下，`/wework/app/` 下的静态资源必须返回
`Cache-Control: no-store`。除哈希资源外，该目录还包含固定文件名的
`plugins/*.js`；如果这些文件使用生产环境的长期 immutable 缓存，刷新后会把旧插件
bundle 与新主 bundle 混合，导致 React Context 等模块出现两份实例。正式构建仍
使用 `public, max-age=31536000, immutable`。

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
pnpm --filter wework ai:verify start --packaged true
```

多个 worktree 并行验证时，为每个实例使用独立 `WEWORK_PORT`。隔离会话会使用独立
的 Executor Home、应用数据目录和单实例锁。

## GitHub Actions

`.github/workflows/wework-app.yml` 支持稳定版与测试版渠道、可选版本覆盖、三平台
并行构建、Actions artifact、正式 GitHub Release，以及 Electron/Tauri 两套滚动
升级清单。发布类型由工作流根据上次发布后的源码变化自动判断，不提供人工选择；
稳定版同时推进 stable 和 beta 渠道，测试版只推进 beta 渠道。工作流安装
`wework/electron` 自己的依赖，准备 bundled sidecars，再调用统一的 Electron
构建命令。桌面资源变化应修改 `wework/resources/` 或 Electron 打包脚本，不要在
workflow 中复制另一份资源列表。

滚动通道只有在 Electron YAML、三平台旧 Tauri JSON 和四个构建目标的组件清单全部
存在时，才可因版本未变而跳过上传。相同版本但资产不完整时必须补齐；如果远端是
不完整的更高版本，工作流必须失败，避免用旧版本覆盖。组件压缩包不可覆盖，只能在
对应内容哈希尚不存在时上传。
