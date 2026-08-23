---
sidebar_position: 39
---

# AI 自验证会话

Wework 支持启动隔离的开发验证会话，让 AI 在真实 Tauri 应用中完成 UI 操作和断言。该机制复用桌面端 E2E 的 WebView 控制通道，不会操作外部 Chrome，也不会连接开发者日常使用的 Wework 窗口。

## 启动会话

```bash
pnpm --filter wework ai:verify start
```

命令会输出 session 文件路径和本地控制地址。它会创建独立的 Executor Home、项目目录、设备 ID、IPC socket、Tauri identifier 和诊断目录，并启动真实的 `dev-mac-app.sh`。任务、项目、应用数据和单实例锁不会与正式版或其他验证会话共享。所有日志位于 `wework/test-results/ai-verify/<run-id>/`。

### 启动完成条件

`start` 只有在主窗口中的真实工作台已经可见后才返回。控制客户端要求 `app-shell` 和 `desktop-workbench-content` 可见，同时本地运行时初始化页、工作台 loading 和启动错误页都不可见。仅创建 Tauri 进程、打开窗口或完成 HTML 加载不算启动完成。

本地 Executor 与工作台 React 树会并行启动；工作台可以在初始化页背后完成数据准备，但只有本地 Executor ready 后才会展示。验证会话继承启动脚本已经解析的环境，因此跳过重复执行用户 login shell，避免 shell 插件或配置把验证启动额外阻塞数秒。

### 跨 worktree 构建缓存

macOS `ai:verify` 会在用户缓存目录中复用依赖和构建产物，缓存不属于任一 worktree，因此删除完成编译的 worktree 不会使后续 worktree 丢失缓存：

- pnpm 虚拟仓库：`$XDG_CACHE_HOME/wegent/wework-node-modules/v2`，默认是 `~/.cache/wegent/wework-node-modules/v2`。每个 worktree 只创建很小的本地链接视图。
- 前端生产构建：`$XDG_CACHE_HOME/wegent/dev-frontends`。
- Wework App 和 Executor 开发二进制：`$XDG_CACHE_HOME/wegent/dev-binaries`。
- Codex、DWS、Harness 和 Node 运行时：`$XDG_CACHE_HOME/wegent/wework-runtime`。

前端和原生二进制指纹只读取 Git 已跟踪或未被 ignore 的源码内容，不包含 worktree 绝对路径、端口、分支名或生成文件。运行时的 worktree 信息和控制地址由本地静态服务器注入，因此完全相同的提交可以跨 worktree 命中同一构建；修改前端源码但不修改依赖时只重建前端。前端、App 和 Executor 缓存分别按最近使用时间最多保留 6 个版本，防止并行 worktree 持续增加磁盘占用。

验证会话自身仍会创建隔离的 `executor-home` 和日志。必须执行 `stop` 并按需删除旧的 `wework/test-results/ai-verify/` 会话目录。Executor 不会把全量 `app/list/updated` 通知写入运行时任务路由日志，其他未路由通知的 raw preview 也限制为 4 KiB，避免短时会话生成超大轮转日志。

## 操作与断言

后续命令都传入启动命令返回的 session 路径。优先使用稳定的 `data-testid` 选择器。

```bash
pnpm --filter wework ai:verify snapshot --session /path/to/session.json
pnpm --filter wework ai:verify fill --session /path/to/session.json \
  --selector '[data-testid="chat-message-input"]' --value '验证内容'
pnpm --filter wework ai:verify click --session /path/to/session.json \
  --selector '[data-testid="send-message-button"]'
pnpm --filter wework ai:verify wait-for --session /path/to/session.json \
  --selector '[data-testid="message-assistant"]' --text '完成'
pnpm --filter wework ai:verify stop --session /path/to/session.json
```

可用操作包括 `snapshot`、`text`、`click`、`fill`、`press`、`wait-for`、`status` 和 `stop`。命令返回结构化 JSON；WebView 不可用、元素不存在或断言超时时，命令以非零状态退出。

## 安全边界

控制器只监听 `127.0.0.1`，并为每个会话生成一次性 Bearer token。该通道只有在 `ai:verify start` 启动的开发实例中通过 Vite 环境变量启用；普通开发与生产构建不会暴露控制接口。session 文件包含 token，应视为短期本地凭据，不应提交或共享。

## 控制协议

WebView 启动后先调用 `/ready`，随后用短轮询请求 `/commands`。控制器在队列为空时立即返回 `204`；WebView 通过 `/control-tick` 做短暂节流，再发起下一次轮询。收到命令后，WebView 依次调用 `/started` 和 `/results`，分别确认命令已开始执行并提交最终结果。

`ai:verify` 和桌面端 E2E 共用这套协议，修改任一端时必须保持端点和轮询语义一致。不要把 `/commands` 改成长轮询：这会与 WebView 的控制循环冲突，使后续命令留在队列中并表现为连续超时。控制器还必须在命令超时后将其从队列移除，避免过期命令在下一次轮询中被执行。

## AI 验证流程

AI 应先执行 `snapshot` 确认路由和可用的 `data-testid`，再进行最小必要操作，并以 `wait-for` 加 `snapshot` 或 `text` 验证结果。结束时必须执行 `stop`；若失败，保留该会话目录中的 `app.log` 以便诊断。
