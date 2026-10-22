---
sidebar_position: 39
---

# AI 自验证会话

Wework 支持启动隔离的开发验证会话，让 AI 在真实 Electron 应用中完成 UI 操作和断言。该机制复用桌面端 E2E 的 WebView 控制通道，不会操作外部 Chrome，也不会连接开发者日常使用的 Wework 窗口。

## 启动会话

构建时的 `prepare-codex-binary.mjs` 使用 Node 原生 HTTP/HTTPS 流下载锁定版本，处理重定向并删除失败的临时文件；归档通过完整性校验后才解包使用。下载流不依赖 Node 内置 Fetch 的 Undici 解析器，避免其异常终止构建进程。

```bash
pnpm --filter wework ai:verify start
```

命令会输出 session 文件路径和本地控制地址。它会创建独立的 Executor Home、项目目录、设备 ID、IPC socket、Electron app-data namespace 和诊断目录，并启动真实的 `dev-mac-app.sh`。任务、项目、应用数据和单实例锁不会与正式版或其他验证会话共享。所有日志位于 `wework/test-results/ai-verify/<run-id>/`。

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

## 原生应用菜单刷新

“查看 → 刷新”重新加载当前 Wework 窗口，快捷键为 macOS 的 `⌘R` 或 Windows/Linux 的 `Ctrl+R`。该菜单项在任务和设置页面均可用，直接调用当前窗口的 `webContents.reload()`。

`application-menu` 桌面 CI 检查点覆盖菜单项存在、设置页可见，以及刷新后控制通道重新连接、页面恢复和工作区导航可用。定向单测覆盖三种平台的快捷键、窗口重载及中英文标签。

测试控制命令 `refreshFromApplicationMenu` 先等待 `/results` 确认，再激活真实的原生菜单项，避免 renderer 卸载时丢失命令回执。控制协议单测通过延迟回执验证该顺序。

设置页保留后台的当前工作区标签。“工作 → 任务 / 项目空间”在设置页应重新选择目标标签并恢复其内容路由，即使该标签已经是当前标签；在正常工作区中则继续避免重复选择。

## 原生右键菜单

Electron 不会为 WebContents 自动创建网页右键菜单。Wework 由 Electron 主进程统一监听 `context-menu`，并为主窗口、工作区窗口和辅助窗口构建原生菜单。

- 图片菜单保留复制图片、打开图片和本机文件操作。
- 可编辑区域必须读取 `params.isEditable` 和 `params.editFlags`，使用 Electron 的 `undo`、`redo`、`cut`、`copy`、`paste`、`delete`、`selectAll` 原生 role，并把 `params.frame` 传给 `menu.popup`。
- 非编辑区域的选中文本使用原生 `copy` role；没有可执行操作时不弹出空菜单，以免干扰 React 组件自己的业务右键菜单。

修改该链路时，先运行 `wework/electron/src/host/image-context-menu.test.ts`，再在隔离 Electron 会话的真实输入框中验证菜单弹出、菜单项可用状态和粘贴行为。WebView 的 DOM 快照不会包含 macOS 原生 `NSMenu`，不能用合成的 `contextmenu` 事件或仅浏览器截图代替真实桌面验证。

## 固定标签窗口恢复

固定标签分配到独立窗口后，Electron 会从本机偏好设置恢复其窗口标识和内容路由。恢复地址必须通过共享的 `resolveDshAppRoute` 添加 `/wework/app/` 前缀，并保留任务或项目查询参数、`workspaceTab`、`workspaceTabTitle` 和片段。直接加载未加前缀的内容路由会绕过 Wework 应用的深链接入口，导致恢复窗口无法正常显示。

桌面 CI 的 `workspace-tabs` 检查点覆盖固定标签拆出及应用重启，断言恢复窗口的路由、标签身份、固定状态，以及编辑区可见且能继续输入。针对性验证使用 `pnpm --filter wework e2e:desktop --segment workspace-tabs`。

## AI 验证流程

AI 应先执行 `snapshot` 确认路由和可用的 `data-testid`，再进行最小必要操作，并以 `wait-for` 加 `snapshot` 或 `text` 验证结果。结束时必须执行 `stop`；若失败，保留该会话目录中的 `app.log` 以便诊断。
