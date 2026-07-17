---
sidebar_position: 6
---

# Wework 云设备 VNC 内置浏览器打开设计

## 背景

Wework 的云设备列表已经提供“桌面”按钮、VNC 配置接口、VNC 页面和内置浏览器。
当前按钮通过通用外链逻辑打开 VNC URL，结果会受浏览器偏好影响；同时，设置页会
遮住工作台，即使内置浏览器接收了打开请求，用户也看不到 VNC 桌面。

## 目标

- 在线云设备的“桌面”按钮始终使用 Wework 内置浏览器打开 VNC 页面。
- 内置浏览器接受请求后，自动退出设置页并回到当前工作台。
- 展开当前工作台右侧浏览器面板，并在现有浏览器标签中展示 VNC 桌面。
- 对加载、离线、失败和重试状态提供明确且可访问的反馈。
- 保持现有 VNC 配置接口、后端 `/vnc-proxy/{deviceId}` WebSocket 代理、
  `vnc.html` 和浏览器 WebView 生命周期。

## 非目标

- 不新增专用 VNC 面板、窗口或浏览器标签模型。
- 不修改后端 VNC 配置或 WebSocket 协议。
- 不在内置浏览器不可用时回退到系统浏览器。
- 不改变普通外链的浏览器偏好行为。
- 不在本次改动中重设计云设备列表。

## 选定方案

复用现有 `requestEmbeddedBrowserOpen` 请求通道。云设备操作在取得 VNC 配置并构建
页面 URL 后，明确向当前工作台的内置浏览器发送打开请求，而不是调用通用外链入口。
只有请求被接受后才退出设置页。

该方案复用 `DesktopWorkbenchMain` 已有的浏览器监听器、右侧面板状态和原生 WebView，
不会复制浏览器尺寸同步、导航或生命周期逻辑。VNC 页面会替换当前工作台现有浏览器
标签中的页面；本次不引入多标签行为。

## 组件与职责

- `VncDesktopButton`：管理配置请求、加载状态、内置浏览器请求和错误反馈。
- `buildVncPageUrl`：根据设备 ID、sandbox ID、当前云连接的 `socketBaseUrl`、云端
  token 和应用 base path 构建 VNC 页面 URL。页面仍来自 Wework 本地资源，WebSocket
  则连接云端 `/vnc-proxy/{deviceId}`。
- `requestEmbeddedBrowserOpen`：向已挂载的当前工作台浏览器监听器发送明确的打开请求，
  并返回请求是否被接受。
- `ConnectionsSettingsPage`：向云设备区域传递“成功打开后离开设置页”的回调；该回调
  沿用现有返回工作台逻辑。
- `DesktopWorkbenchMain`：继续接收打开请求、展开右侧浏览器面板并导航原生 WebView。

## 交互与数据流

1. 在线云设备显示可用的“桌面”按钮；离线设备按钮禁用。
2. 用户点击后，按钮进入加载和禁用状态，防止重复请求。
3. Wework 请求该设备的 VNC 配置，并使用返回的 sandbox ID、当前云连接地址和 token
   构建 VNC 页面 URL。
4. Wework 调用 `requestEmbeddedBrowserOpen`，目标为当前工作台默认浏览器标签。
5. 当前工作台监听器接收 URL，选择浏览器标签并展开右侧面板。
6. 请求被接受后，设置页执行现有返回操作，路由回工作台；用户看到右侧 VNC 桌面。
7. 按钮结束加载状态。再次从设置页触发时，仍复用当前工作台浏览器标签。

## 状态与错误处理

- 加载期间忽略重复点击，并保持按钮宽度和操作语义稳定。
- VNC 配置获取失败时，留在设置页、恢复按钮并在对应设备附近显示本地化错误。
- 内置浏览器没有可用监听器时，留在设置页、恢复按钮并显示本地化错误。
- 失败提示使用可访问的警告语义，重试开始时清除，成功后保持清除。
- 失败路径不调用系统浏览器，也不把失败显示成成功跳转。
- 日志不得包含带认证令牌的完整 VNC URL。
- 不再使用不存在的 `/api/cloud-devices/{deviceId}/vnc-ws` 路径，也不使用可能属于
  本地运行时的 `auth_token` 代替当前云连接 token。

## 文案与可访问性

“桌面”、打开失败提示和必要的辅助标签使用 Wework `common` 命名空间，并同时提供
中文和英文翻译。按钮保留描述性的 `data-testid`；禁用和加载状态通过原生按钮语义
暴露。错误提示应能被辅助技术识别，但不重复打断用户。

## 测试与验证

单元和组件测试覆盖：

- 在线设备点击后只请求一次 VNC 配置。
- 构建后的 VNC URL 被发送给内置浏览器请求通道。
- 只有内置浏览器接受请求后才执行退出设置页回调。
- 请求期间按钮禁用，重复点击不会产生第二次配置请求。
- 离线云设备的桌面按钮禁用。
- 配置请求失败或内置浏览器不可用时保留设置页、显示错误且不打开系统浏览器。
- 错误后再次点击可以重试，并在成功时清除错误。

桌面集成回归覆盖从连接设置点击“桌面”，确认设置页关闭、工作台恢复、右侧浏览器
标签被选中并接收 VNC URL。按照 `wework/AGENTS.md`，最终还需在隔离的真实 Tauri
会话中验证主路径、失败恢复路径和可见结果，并保留可复现的验证记录。

---

# Wework Cloud Device VNC in the Built-in Browser

## Background

The cloud-device list already has a Desktop action, a VNC configuration API,
a VNC page, and a built-in browser. The action currently uses the generic link
opener, so browser preferences can redirect it away from Wework. The settings
surface also hides the workbench, which leaves an accepted browser request
invisible to the user.

## Goals

- Always open an online cloud device's VNC page in the Wework built-in browser.
- Leave settings only after the built-in browser accepts the request.
- Return to the current workbench, expand its right browser panel, and show VNC
  in the existing browser tab.
- Provide explicit, accessible loading, offline, failure, and retry states.
- Reuse the existing VNC API, WebSocket proxy, `vnc.html`, and native WebView.

## Non-goals

- No dedicated VNC panel, window, or new browser-tab model.
- No backend VNC protocol changes.
- No system-browser fallback when the built-in browser is unavailable.
- No change to ordinary external-link preferences.
- No redesign of the cloud-device list.

## Chosen Design

After loading the VNC configuration and building the page URL from the active
cloud connection's `socketBaseUrl` and token,
`VncDesktopButton` sends an explicit `requestEmbeddedBrowserOpen` request to the
current workbench. It invokes the existing leave-settings callback only when
that request is accepted.

`DesktopWorkbenchMain` remains responsible for selecting the browser tab,
opening the right panel, and navigating the native WebView. The VNC page
replaces the existing page in that single browser tab.

## Flow and Failure Semantics

1. Only an online cloud device has an enabled Desktop action.
2. A click disables the action while Wework loads the VNC configuration.
3. Wework keeps the page on the local app origin, points its WebSocket URL at
   the cloud backend's `/vnc-proxy/{deviceId}` endpoint, and sends the page URL
   to the embedded browser request channel.
4. Once accepted, Wework closes settings and reveals the current workbench and
   its right browser panel.
5. If configuration loading fails or no listener accepts the request, Wework
   stays in settings, restores the action, and shows a localized accessible
   error. It never opens the system browser on this failure path.

The implementation must not log a complete VNC URL because it contains the
encoded cloud authentication token. It must not use the obsolete
`/api/cloud-devices/{deviceId}/vnc-ws` path or substitute the local runtime's
`auth_token` for the active cloud-connection token.

## Verification

Focused tests cover successful routing, success-only settings exit, loading
deduplication, offline disabling, visible failure, retry, and the absence of a
system-browser fallback. A desktop integration regression covers the complete
settings-to-workbench transition. Isolated real-Tauri verification follows the
QA and evidence requirements in `wework/AGENTS.md`.
