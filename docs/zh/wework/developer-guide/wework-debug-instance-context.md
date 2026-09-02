---
sidebar_position: 35
---

# 调试实例标识

Wework 支持从一个正在运行的 Wework 内置 Terminal 中启动另一个调试版 Wework。为了在多个 worktree、多个 dev app 同时打开时分清窗口来源，Wework 会把父窗口上下文传给 Terminal，再由 `wework/scripts/dev-mac-app.sh` 传给新启动的调试实例。

内置 Terminal 还可能继承正式版用于启动 Node 子进程的
`ELECTRON_RUN_AS_NODE`、`WEWORK_NODE_PATH` 和 `WEWORK_NODE_RUNTIME_KIND`。
`dev-mac-app.sh` 在启动调试版 Electron 前会清除这些变量，让源码 checkout
使用自己准备的 Node launcher，并确保 Electron 以桌面应用模式启动。脚本也会
先生成 `wework/electron/resources/components.json` 等开发组件资源，再把该
资源目录显式交给调试版 Electron。

## Terminal 环境变量

本地内置 Terminal 创建 PTY 时，会注入以下变量：

- `WEWORK_PARENT_TITLE`: 当前运行任务标题。
- `WEWORK_PARENT_PROJECT`: 当前项目名称。
- `WEWORK_PARENT_WORKSPACE`: 当前 workspace 路径。

任务标题在前端展示和写入 `WEWORK_PARENT_TITLE` 前都会限制为 60 个 Unicode 字符，超过时以省略号结尾，避免过长内容影响调试实例标识或 Terminal 启动。

这些变量只在 Terminal session 创建时写入。已经打开的 Terminal 不会在任务切换或前端热更新后自动更新；需要关闭并重新打开 Terminal 才能获得新的上下文。

## Dev 脚本变量

`wework/scripts/dev-mac-app.sh` 会读取父窗口变量，并自动生成调试实例变量：

- `WEWORK_DEV_TITLE`: 调试实例短标题。任务运行环境会自动使用截短后的任务标题；普通本地终端使用项目名和 Git branch；detached HEAD 且无任务上下文时使用 worktree 目录名。
- `WEWORK_DEV_PORT`: 当前 Vite/ Electron dev server 端口。
- `WEWORK_DEV_WORKTREE`: 当前 worktree 根路径。
- `WEWORK_DEV_BRANCH`: 当前 Git branch，detached HEAD 时为空。
- `WEWORK_DEV_INSTANCE_LABEL`: 从 `runtime-<id>` worktree 目录提取的实例编号；普通 checkout 使用稳定哈希。
- `WEWORK_DEV_DOCK_TITLE`: macOS Dock 使用的实例名称，由自动识别的短标题与实例编号前四位组成。
- `WEWORK_DEV_EXECUTABLE_NAME`: 可安全用作 macOS 可执行文件名的 Dock 标题；路径分隔符会被替换。
- `WEWORK_APP_IDENTIFIER`: 自动生成的 Electron 应用身份，根据当前 worktree 路径生成，用于隔离单实例锁、应用数据和 macOS 菜单栏图标位置。启动脚本会忽略从父 App 继承的身份；只有明确需要复用身份时才使用 `WEWORK_DEV_APP_IDENTIFIER` 覆盖。
- `WEWORK_USER_DATA_DIR`: 自动生成的 Electron 用户数据目录。启动脚本会忽略从父 App 继承的目录；需要明确覆盖时使用 `WEWORK_DEV_USER_DATA_DIR`。

macOS 开发启动脚本会为每个显示名称准备写时复制的 Electron App Bundle。任务
shell 直接使用注入的标题；从已有 runtime worktree 启动的终端也可以从本地运行时
索引恢复标题。脚本随后设置 Bundle 元数据，并将主可执行文件重命名为
`WEWORK_DEV_EXECUTABLE_NAME`，即适合文件系统使用的 Dock 标题。
因此 Dock 悬浮名称会显示类似 `修复订阅市场 · 5275`，图标角标则显示 `5275`。
重命名后的开发 Bundle 仍按源码热更新模式运行，不会切换到正式打包资源。

macOS 托盘会根据 `WEWORK_APP_IDENTIFIER` 派生稳定的 UUID v5，并作为
`Tray` GUID 传给 Electron。Electron 会把该 GUID 写入原生
`NSStatusItem.autosaveName`，使 iBar 等菜单栏管理器在应用重启后仍识别为同一
菜单栏 item。正式版 UUID 已被回归测试锁定；调试实例则通过不同的
`WEWORK_APP_IDENTIFIER` 与正式版和其他 worktree 隔离。不要修改 UUID
namespace 或改用随机 GUID，否则会再次重置用户的菜单栏显示规则。

脚本也会把这些值导出为 `VITE_WEWORK_*`，供前端在运行时显示。

## 前端显示

调试实例会在右下角显示 `Debug Wework` 浮标。浮标展示短标题；hover 或聚焦后展开完整信息面板，每一项都可以单独复制。

如果看不到新变量，优先确认：

- 使用的是新打开的内置 Terminal。
- 调试 app 是从该 Terminal 中执行 `wework/scripts/dev-mac-app.sh` 启动的。
- 当前 Terminal 里检查的是 `WEWORK_*` 变量，而不是其他前缀。
