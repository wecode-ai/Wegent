---
sidebar_position: 38
---

# 内置浏览器

Wework 的内置浏览器用于在桌面工作台右侧面板中展示可交互网页，并让本地运行时通过 WKWebView bridge 控制同一个页面。它不是截图预览，也不会新开外部 Chrome 窗口。

## 架构

内置浏览器由三层组成：

- Wework Tauri 原生层创建嵌入式 WebView，并通过命令更新位置、导航地址和显示状态。
- Wework React 工作台负责把浏览器面板挂载到右侧 workspace pane，并维护面板、任务和批注状态。
- `executor/src/browser_mcp` 暴露给 Codex 的浏览器 MCP 工具，并通过 Wework bridge 操作当前任务绑定的 WKWebView。

Executor 启动 Codex 时会注入 browser MCP server 配置。模型调用浏览器工具时，MCP server 读取当前 bridge identity，向 Wework 进程内的 loopback bridge 发送受控请求。bridge 再在主线程调度 WKWebView 的导航、页面检查、DOM 动作、等待和截图。

每个 Wework 进程启动时都会绑定独立的随机本地桥接端口，并把 bridge identity 原子写入当前 Executor home 的 `runtime/embedded-browser-bridge.json`。identity 包含 schema 版本、进程 PID、loopback 地址、认证 token 和启动时间。文件目录权限应限制为当前用户可读写，token 不得写入日志。MCP server 每次请求前读取最新 identity，并只接受 loopback 地址，避免同时运行的多个 Wework 实例把浏览器请求发送到错误窗口。

bridge 请求必须携带认证 token。`open` 和 `navigate` 只允许安全的网页 scheme；不要允许 `file:`、`javascript:` 或其它可以读取本机文件或执行任意脚本的地址进入 Agent 导航路径。

bridge 支持有限并发。长时间 `waitFor` 不应阻塞独立的 `click`、`fill` 或 `inspect` 请求；超出并发上限时返回明确的忙碌错误，而不是让调用无限等待。

## Agent 浏览器能力

Agent 面向模型暴露的是浏览器动作工具，而不是底层 WebKit API。常用能力包括：

- `browser_open` / `browser_navigate`：打开或跳转页面。
- `browser_inspect`：返回结构化页面检查结果。
- `browser_click`、`browser_type`、`browser_fill`、`browser_press_key`、`browser_hover`、`browser_focus`：操作页面元素。
- `browser_scroll`、`browser_scroll_into_view`、`browser_select_option`、`browser_set_checked`：补齐常见表单和滚动动作。
- `browser_wait`：等待页面稳定、URL 条件、文本或元素状态。
- `browser_take_screenshot`：获取真实浏览器截图。
- `browser_capabilities`、`browser_native_input_probe`、`browser_ax_probe`、`browser_present_probe`：报告当前 WKWebView 能力边界和诊断信息。

组合工具可以把高频链路合并为一次模型调用，例如 `browser_open_and_inspect`、`browser_click_and_inspect` 和 `browser_wait_and_inspect`。组合工具必须在 MCP `tools/list` 中暴露，保持协议自描述。

`inspect` 表示结构化页面检查，`screenshot` 表示真实截图。不要复用 `snapshot` 来表示 DOM 结构化结果，避免和真实截图语义混淆。

结构化 inspect 结果至少应包含页面 URL、标题、viewport、节点列表和纯文本摘要。节点应稳定包含：

- `ref` 和 `index`：供后续动作定位。
- `role`、`name`、`text`、`value`：供模型理解元素语义。
- `rect`、`visible`、`disabled`、`actionable`：供模型判断是否能操作。
- `frameId`、`selector` 或其它调试定位信息：仅用于诊断，不应要求模型依赖脆弱 selector。
- `warnings`：说明遮挡、不可见、敏感输入、跨 frame 限制等风险。

动作工具优先使用 `inspect` 产生的 `ref`。当页面重排导致 `ref` 失效时，应返回可恢复错误，引导模型重新 `inspect`，不要静默猜测 selector。动作结果应描述观测到的效果，例如值变化、DOM 变化、URL 变化或只派发了事件但未观察到效果。

## 任务绑定

浏览器实例以 pane/task label 绑定：

- 未创建运行任务的新对话使用当前 pane key 生成临时浏览器 label。
- 新对话发送后如果创建了 runtime task，Wework 会把临时浏览器 relabel 到新 task label。
- 切换任务时，只显示当前 pane/task 绑定的浏览器；其它任务的页面不会跨 pane 泄漏。
- MCP 打开请求先使用默认 label；当前 pane 失活时，Wework 会把 WebView 迁移到任务专属 label，并且只有活跃任务可以接管默认 label。
- 浏览器右侧面板关闭时，原生 WebView 会被隐藏到不可见区域，不应覆盖聊天区、debug panel 或分割线。

这种绑定保证“用户看到的浏览器”和“agent 控制的浏览器”是同一个对象。

## 主界面浮层与地址栏同步

嵌入式浏览器是独立的原生 WebView，不能通过主 React WebView 的 `z-index` 覆盖。当主界面的 dialog、menu、listbox 或系统级浮层与浏览器区域相交时，浏览器面板必须把原生 WebView 设为不可见；浮层移除或不再相交后再恢复显示。自定义浮层无法通过语义 role 或共享层级类识别时，应添加 `data-embedded-browser-occlusion`，不要在各业务组件中重复调用原生显示命令。

页面状态轮询维护的是浏览器真实 URL，地址栏维护的是用户输入草稿。地址栏聚焦期间，轮询可以更新页面 URL、标题和图标，但不得覆盖输入草稿；失焦时再恢复真实 URL。新增导航或页面状态同步路径时必须保留这条边界。

## WebView 兼容性

- 浏览器 WebView 使用固定的独立数据存储标识和应用数据目录，不能与 Wework 主界面的登录存储混用。浏览器设置中的清理操作只作用于这个数据存储。
- Tauri 中的 Wegent 智能体应用标签页也使用原生子 WebView，而不是跨源 iframe。所有应用标签共享同一个固定数据存储标识，因此同一来源的完整网站存储（包括全部 `localStorage` key、Cookie 和 IndexedDB）会在标签关闭、重新打开和应用重启后继续可用；标签 label 只标识 WebView 生命周期，不划分存储。macOS 14 及以上由 `data_store_identifier` 选择持久化 `WKWebsiteDataStore`，`data_directory` 主要服务其它平台。不要在 Wework 主界面逐 key 镜像或恢复页面存储。
- 浏览器 WebView 使用 Safari 兼容 User-Agent，避免网站把缺少浏览器产品标识的 WebKit User-Agent 识别为不受支持的客户端。
- 弹窗、OAuth、SSO 和支付流程可能通过 `window.open` 或新窗口导航触发。实现应把它们路由到受控浏览器窗口或明确交给外部系统处理，不能让 Agent 不可见地操作隐藏页面。
- 下载处理器从应用偏好读取下载目录和“下载前询问”开关；取消系统保存对话框必须取消本次下载。
- 页面加载事件负责把当前 URL 写入应用状态。不要在 IPC 或自定义协议处理期间同步读取原生 WebView URL；macOS WebKit 在 WebView 创建或销毁期间可能暂时没有 URL。
- 页面动作脚本只能执行与当前工具语义一致的操作。禁止把任意 DOM 修改包装成内部 evaluate 来绕过安全检查。
- macOS App Transport Security 只为嵌入式网页内容允许 HTTP。无效服务器证书必须先经过系统信任校验；仅在校验失败后使用该次 server-trust challenge 继续加载，并向前端发送包含原生 WebView 标识和来源的风险状态。TLS handler 必须在首次导航前完成注册，避免初始页面与异步 `with_webview` 配置竞争。证书提示在同源页面间保留，导航到其他来源或关闭 WebView 时必须清除。

## 可选云桌面扩展

公开版 Wework 只定义云桌面的 UI 插槽、内部页面识别契约和不可用时的默认实现，不包含连接凭据、打开目标、打开流程、具体远程桌面协议、鉴权接口、代理、页面或第三方客户端资源。工作台和设备设置页只能通过 `src/extensions/cloud-desktop-contract.ts` 使用该能力；默认实现的 `available` 为 `false`，因此不会展示桌面入口。

产品发行版可以在构建时为 `@extensions/cloud-desktop` 提供实现。通用契约分别通过 `DeviceAction` 和 `WorkspaceAction` 向设置页及项目工作区提供入口；具体实现自行持有连接类型、打开目标、异步状态和打开流程，并通过 `isCurrent` 忽略项目、设备或连接上下文已经变化的异步请求。公共 Wework 只提供不可用的空实现，不应包含具体远程桌面协议、页面、资源或专用文案。

## 批注流程

右侧浏览器地址栏旁提供批注图标。进入批注模式后：

- 鼠标移动到页面元素上时，只高亮当前 DOM 元素。
- 点击元素弹出评论输入框。
- 在评论输入框按 Enter 会发布批注并回到 Wework 主输入框附件区。
- 发送后，会话区显示评论附件样式，主输入框附件会被清理。
- 发送给模型的内容包含隐藏的 `<workspace_comment_context>`，用于说明批注对应的可视网页区域；UI 不展示原始隐藏上下文。

批注用于网页可视区域评论，不等同于代码选择评论。`browser_annotation` 项应被模型理解为对当前可见网页元素的评论。

## 开发检查

修改内置浏览器相关代码后，至少运行：

```bash
pnpm --filter wework typecheck
pnpm --filter wework lint
cargo check --manifest-path executor/Cargo.toml
cargo check --manifest-path wework/src-tauri/Cargo.toml
cargo test --manifest-path executor/Cargo.toml browser_mcp
cargo test --manifest-path wework/src-tauri/Cargo.toml embedded_browser
pnpm --filter wework e2e:desktop:embedded-browser
```

浏览器涉及 Tauri 命令、原生 WebView、IPC 或 Agent 操作链路时，还应使用 `pnpm --filter wework ai:verify start` 启动隔离真实 Tauri 会话，并记录打开页面、inspect、动作和截图的验证证据。完整 E2E 太慢时，合并前至少要说明未运行的原因，并确保 CI 中的 `e2e:desktop:embedded-browser` 会覆盖该场景。

涉及 Executor Codex 启动配置时，还应运行对应的 Codex launch config 单元测试，确认 browser MCP server 会被正确注入。
