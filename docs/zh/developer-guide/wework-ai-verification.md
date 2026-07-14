---
sidebar_position: 39
---

# AI 自验证会话

Wework 支持启动隔离的开发验证会话，让 AI 在真实 Tauri 应用中完成 UI 操作和断言。该机制复用桌面端 E2E 的 WebView 控制通道，不会操作外部 Chrome，也不会连接开发者日常使用的 Wework 窗口。

## 启动会话

```bash
pnpm --filter wework ai:verify start
```

命令会输出 session 文件路径和本地控制地址。它会创建独立的 Executor 目录和诊断目录，并启动真实的 `dev-mac-app.sh`。所有日志位于 `wework/test-results/ai-verify/<run-id>/`。

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

## AI 验证流程

AI 应先执行 `snapshot` 确认路由和可用的 `data-testid`，再进行最小必要操作，并以 `wait-for` 加 `snapshot` 或 `text` 验证结果。结束时必须执行 `stop`；若失败，保留该会话目录中的 `app.log` 以便诊断。
