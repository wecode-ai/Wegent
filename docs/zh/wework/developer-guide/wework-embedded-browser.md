---
sidebar_position: 38
---

# 内置浏览器

Wework 的内置浏览器用于在桌面工作台右侧面板中展示可交互网页，并让本地运行时通过 CDP-backed Browser Session 控制同一个页面。它不是截图预览，也不会新开外部 Chrome 窗口。

## 架构

内置浏览器由三层组成：

- Wework Tauri 原生层创建嵌入式 WebView，并通过命令更新位置、导航地址和显示状态。
- Wework React 工作台负责把浏览器面板挂载到右侧 workspace pane，并维护面板、任务和批注状态。
- `deps/browser/relay-server` 暴露给 Codex 的浏览器 MCP 工具，工具名称面向模型描述为 Wework 内置浏览器，避免暴露 Playwright 等实现细节。

Executor 启动 Codex 时会注入 relay server 配置。模型调用浏览器工具时，relay server 通过 Wework 的本地 IPC 操作当前任务绑定的嵌入式浏览器。

每个 Wework 进程启动时都会绑定独立的随机本地桥接端口，并把实际地址传给它启动的 Executor。不得复用父进程环境中的桥接地址，否则同时运行的多个 Wework 实例可能把浏览器请求发送到错误的窗口。

## 任务绑定

浏览器实例以 pane/task label 绑定：

- 未创建运行任务的新对话使用当前 pane key 生成临时浏览器 label。
- 新对话发送后如果创建了 runtime task，Wework 会把临时浏览器 relabel 到新 task label。
- 切换任务时，只显示当前 pane/task 绑定的浏览器；其它任务的页面不会跨 pane 泄漏。
- MCP 打开请求先使用默认 label；当前 pane 失活时，Wework 会把 WebView 迁移到任务专属 label，并且只有活跃任务可以接管默认 label。
- 浏览器右侧面板关闭时，原生 WebView 会被隐藏到不可见区域，不应覆盖聊天区、debug panel 或分割线。

这种绑定保证“用户看到的浏览器”和“agent 控制的浏览器”是同一个对象。

## WebView 兼容性

- 浏览器 WebView 使用固定的独立数据存储标识和应用数据目录，不能与 Wework 主界面的登录存储混用。浏览器设置中的清理操作只作用于这个数据存储。
- 下载处理器从应用偏好读取下载目录和“下载前询问”开关；取消系统保存对话框必须取消本次下载。
- 页面加载事件负责把当前 URL 写入应用状态。不要在 IPC 或自定义协议处理期间同步读取原生 WebView URL；macOS WebKit 在 WebView 创建或销毁期间可能暂时没有 URL。
- 嵌入式浏览器使用标准 Safari 兼容 User-Agent，避免网站把缺少浏览器产品标识的 WebKit User-Agent 识别为不受支持的客户端。

## 可选云桌面扩展

公开版 Wework 只定义云桌面的 UI 插槽、内部页面识别契约和不可用时的默认实现，不包含连接凭据、打开目标、打开流程、具体远程桌面协议、鉴权接口、代理、页面或第三方客户端资源。工作台和设备设置页只能通过 `src/extensions/cloud-desktop-contract.ts` 使用该能力；默认实现的 `available` 为 `false`，因此不会展示桌面入口。

产品发行版可以在构建时为 `@extensions/cloud-desktop` 提供实现。通用契约分别通过 `DeviceAction` 和 `WorkspaceAction` 向设置页及项目工作区提供入口；具体实现自行持有连接类型、打开目标、异步状态和打开流程，并通过 `isCurrent` 忽略项目、设备或连接上下文已经变化的异步请求。公共 Wework 只提供不可用的空实现，不应包含具体远程桌面协议、页面、资源或专用文案。

### Wecode VNC 实现

Wecode 发行版在“设置 → 连接”和项目工作区中提供云设备桌面入口。设置页入口通过仅监听 `127.0.0.1` 随机端口的 Wecode viewer bridge 在系统默认浏览器中打开；项目工作区入口继续复用 Wework 内置浏览器。两个入口都先读取 `GET /api/cloud-devices/{device_id}/vnc-config`，再通过 `/vnc-proxy/{device_id}` 建立 noVNC WebSocket 连接，不依赖可选的 `/status.vnc_url`。

WebSocket 地址和 Bearer token 不得放入浏览器地址、历史记录或 React 可见路由。扩展调用 `prepare_vnc_session`，把连接信息写入 Tauri Rust 进程中的两分钟内存交接会话。项目工作区的内置浏览器和设置页的系统浏览器都打开 `http://127.0.0.1:<随机端口>/vnc.html?sessionId=...&sandboxId=...`；区别只在页面由 Wework 还是系统浏览器承载。页面必须始终通过同源 `/session/{sessionId}` 读取内存配置，不能根据 `window.__TAURI_INTERNALS__` 改走 IPC，因为 Tauri 创建的远程子 WebView 也可能暴露该对象但不具备远程 IPC 权限。Loopback bridge 校验 Host、禁用 CORS 与缓存，并设置 `no-referrer`，不会把 token 写入页面 URL 或磁盘。两分钟只限制主 WebView 向 VNC 页交接凭据；首次读取后，VNC 页会在自身生命周期内缓存认证 WebSocket 地址，断线重试不受该交接期限限制。完整刷新页面后，如果交接会话已经过期，则必须从云设备入口重新打开桌面。

VNC 页面只在 noVNC 真实连接成功后设置连接标记。断开或连接失败时必须清除该标记，并提供重试状态。云桌面页面不提供网页批注模式；设置页把受限 loopback viewer 交给系统浏览器，项目工作区则把同一 viewer 交给 Wework 内置浏览器。viewer URL 不得作为通用网页链接导出。

#### 代码归属与宿主边界

VNC 是 Wecode 发行版能力，不是公共 Wework 内置浏览器的默认能力。代码按以下边界组织：

- `wework/wecode/features/vnc/` 持有 VNC API、会话编排、设置页按钮、工作区桌面入口、打开流程、页面、noVNC 资源和对应单元测试。
- `wework/wecode/extensions/cloud-desktop.tsx` 把 VNC feature 的设置页 `DeviceAction` 和工作区 `WorkspaceAction` 绑定到通用 `cloudDesktopExtension` 契约。
- `wework/wecode/extensions/desktop-control.ts` 持有关闭、求值和重命名内置浏览器等 Wecode 桌面自动化动作；公共自动化层只通过 `wework/src/extensions/desktop-control-contract.ts` 委派未处理的命令。
- `wework/wecode/vitePlugins.mjs` 持有 Wecode 构建插件集合，并在内部加载 VNC 资源插件；公共 `vite.config.ts` 只负责可选加载 Wecode 插件集合，不识别 VNC 文件或资源名称。
- `wework/wecode/e2e/desktop/` 持有 RFB 模拟服务、VNC HTTP/WebSocket fixture、专用状态和云桌面验证流程。Wecode 包装入口通过 `WEWORK_E2E_DESKTOP_SCENARIO_MODULE` 向公共 Desktop E2E 注入可选场景，公共 runner 不直接导入 Wecode。
- `wework/wecode/i18n/` 持有 VNC 专用中英文文案，并通过通用 i18n extension resource 契约在内部构建时注册。
- `wework/src-tauri/src/wecode/vnc_session.rs` 持有 VNC 凭据交接、TTL、安全校验、loopback viewer bridge 和原生单元测试。

公共 `wework/src/` 只保留与协议无关的云桌面 UI 插槽和页面识别契约、空实现、宿主调用，以及桌面控制和 i18n 扩展契约与委派入口，不持有云桌面连接类型、打开流程、专用文案或具体的内置浏览器求值动作。公共组件测试只验证扩展契约接线；实际 VNC 集成断言放在 Wecode feature 测试或 Desktop E2E 中。

`wework/src-tauri/src/wecode/` 持有 `VncSessionState` 初始化、loopback bridge 启动和专用 command 注册清单；公共 `lib.rs` 只通过通用 Wecode setup 与 invoke-handler 组合入口完成原生构建接线，不识别具体 VNC command。Backend 的 VNC 配置接口、WebSocket 代理和本文档不迁入 Wework 的 Wecode 目录。除这些必要组合入口外，公共 Vite 配置、React 组件、E2E 控制层和测试不得新增 VNC/noVNC/专用 IPC 实现。

修改这些流程时必须保持 IPC command 名、两分钟交接期限、认证方式、RFB 握手、现有 `data-testid`、错误恢复及项目工作区内置浏览器行为。验证必须覆盖归属边界测试、VNC feature 单测、公共宿主单测、TypeScript、ESLint、Vite build、Rust 测试和真实 Desktop E2E；设置页 E2E 还必须确认系统浏览器完成 RFB 握手且 Wework 内没有新建浏览器标签页。

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
cd wework && pnpm vitest run src/lib/embedded-browser.test.ts src/components/layout/workspace-panels/WorkspaceBrowserPanel.test.tsx
cd wework/src-tauri && cargo check
cd deps/browser/relay-server && npm run test:mcp
```

涉及 Executor Codex 启动配置时，还应运行：

```bash
cd executor && cargo test codex_launch_config_includes_cdp_browser_mcp_server
```
