---
sidebar_position: 35
---

# 调试实例标识

Wework 支持从一个正在运行的 Wework 内置 Terminal 中启动另一个调试版 Wework。为了在多个 worktree、多个 dev app 同时打开时分清窗口来源，Wework 会把父窗口上下文传给 Terminal，再由 `wework/scripts/dev-mac-app.sh` 传给新启动的调试实例。

## Terminal 环境变量

本地内置 Terminal 创建 PTY 时，会注入以下变量：

- `WEWORK_PARENT_TITLE`: 当前运行任务标题。
- `WEWORK_PARENT_PROJECT`: 当前项目名称。
- `WEWORK_PARENT_WORKSPACE`: 当前 workspace 路径。

这些变量只在 Terminal session 创建时写入。已经打开的 Terminal 不会在任务切换或前端热更新后自动更新；需要关闭并重新打开 Terminal 才能获得新的上下文。

## Dev 脚本变量

`wework/scripts/dev-mac-app.sh` 会读取父窗口变量，并自动生成调试实例变量：

- `WEWORK_DEV_TITLE`: 调试实例短标题，优先使用 `WEWORK_PARENT_TITLE`，否则使用 Git branch，最后使用 worktree 目录名。
- `WEWORK_DEV_PORT`: 当前 Vite/Tauri dev server 端口。
- `WEWORK_DEV_WORKTREE`: 当前 worktree 根路径。
- `WEWORK_DEV_BRANCH`: 当前 Git branch，detached HEAD 时为空。

脚本也会把这些值导出为 `VITE_WEWORK_*`，供前端在运行时显示。

## 前端显示

调试实例会在右下角显示 `Debug Wework` 浮标。浮标展示短标题；hover 或聚焦后展开完整信息面板，每一项都可以单独复制。

如果看不到新变量，优先确认：

- 使用的是新打开的内置 Terminal。
- 调试 app 是从该 Terminal 中执行 `wework/scripts/dev-mac-app.sh` 启动的。
- 当前 Terminal 里检查的是 `WEWORK_*` 变量，而不是其他前缀。
