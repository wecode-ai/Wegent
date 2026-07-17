---
sidebar_position: 7
---

# Wework VNC 内部能力迁移到 Wecode 设计

## 背景

云设备 VNC 已经能从连接设置页和项目工作台打开到 Wework 内置浏览器。当前实现把
VNC 专属的 API、类型、会话桥接、React 组件、静态页面和 Tauri 会话模块散落在
`wework/src`、`wework/public` 与 `wework/src-tauri/src` 中，而仓库已有
`wework/wecode` 和 `wework/src-tauri/src/wecode` 两个内部能力目录。

本次迁移只调整代码归属和公共接入边界，不改变用户已经手动验证通过的 VNC 行为。
现有内置浏览器原生身份修复也必须原样保留并随最终实现一起验证、提交和推送。

## 目标

- 将 VNC 自有的 TypeScript、React、HTML、noVNC bundle 和 Rust 会话代码归入
  `wecode`。
- 公共 `src` 只依赖一个通用的云桌面扩展契约，不直接导入 `@wecode/*`，延续现有
  `@extensions/*` 覆盖机制。
- 让设置页和项目工作台复用同一个安全打开流程，删除重复的 VNC API、类型和会话编排。
- 保持 `/vnc.html`、`/novnc/rfb.min.js`、Tauri IPC 命令名、两分钟会话交接和现有
  `data-testid` 不变。
- 通过单元测试、Vite 构建、Desktop E2E 和隔离真实 Tauri 会话证明迁移没有改变行为。

## 非目标

- 不引入 VNC 专用窗口、标签模型或 Tauri 自定义 URI protocol。
- 不修改后端 VNC 配置接口、WebSocket 代理、RFB 握手或认证协议。
- 不重构通用内置浏览器、设置页、项目工具卡或 Cloud Connection 架构。
- 不顺带修改 `vnc.html` 的视觉设计、文案或 noVNC 版本。
- 不要求把所有包含 `VNC` 字样的通用宿主测试和 Desktop E2E 主文件搬入 `wecode`；
  测试代码继续跟随其被测边界。

## 方案选择

采用已确认的模块化迁移方案：VNC 自有实现形成一个内聚 feature，通过通用扩展契约
接入公共宿主。没有采用公共 `src` 直接导入 `@wecode` 的简单方案，因为这会破坏已有
内部覆盖边界；也没有采用 Rust 自定义协议内嵌资源的方案，因为它会同时改变开发与生产
origin、资源加载和 WebView 安全路径。

## 目录与职责

```text
wework/
├── wecode/
│   ├── extensions/
│   │   └── cloud-desktop.tsx
│   └── features/vnc/
│       ├── api.ts
│       ├── session.ts
│       ├── openCloudDesktop.ts
│       ├── VncDesktopButton.tsx
│       ├── viteAssets.ts
│       ├── assets/
│       │   ├── vnc.html
│       │   └── novnc/rfb.min.js
│       └── *.test.ts(x)
├── src/extensions/
│   ├── cloud-desktop-contract.ts
│   └── cloud-desktop.tsx
├── src/components/settings/
│   └── DeviceActionButton.tsx
└── src-tauri/src/wecode/
    └── vnc_session.rs
```

各文件只有一个主要职责：

- `api.ts` 使用当前活动云连接的 `apiBaseUrl` 和 token 请求
  `/cloud-devices/{encodedDeviceId}/vnc-config`，并拥有唯一的 VNC 响应类型。
- `session.ts` 负责 WebSocket base URL 映射、`prepare_vnc_session` IPC、无凭证本地页面
  URL 和内部 VNC 页面识别。
- `openCloudDesktop.ts` 串联配置请求、过期请求检查、Tauri 会话准备和内置浏览器打开，
  让两个入口共享同一条安全主链路。
- `VncDesktopButton.tsx` 只负责连接设置页所需的加载、错误、禁用和重试 UI；保留已有
  `connection-vnc-button-*` 与 `connection-vnc-error-*` 测试标识。
- `viteAssets.ts` 在 Vite dev server 中提供内部静态源文件，并在 production build 中
  把它们输出到稳定路径；不复制第二份源文件到 `public`。
- `cloud-desktop-contract.ts` 定义与 VNC 无关的公共宿主接口，例如能力是否可用、打开云
  桌面、渲染设备桌面操作和判断内部桌面页面。
- `DeviceActionButton.tsx` 从设置页现有局部函数提取通用按钮外观，供终端、IDE 和内部
  云桌面操作共同复用；它不包含 VNC 判断或网络逻辑。
- `src/extensions/cloud-desktop.tsx` 是内部覆盖不存在时的安全空实现；
  `wecode/extensions/cloud-desktop.tsx` 把该契约绑定到 VNC feature。
- Rust `vnc_session.rs` 保持现有校验、TTL、状态和测试，只改变模块位置及注册路径。

## 公共扩展边界

公共设置页、项目工作台和浏览器面板统一从 `@extensions/cloud-desktop` 读取一个
`cloudDesktopExtension`。该对象提供四项窄能力：

1. `available`：宿主是否应展示或启用云桌面入口。
2. `DeviceAction`：设置页中的桌面按钮组件。
3. `open(options)`：项目工具卡调用的命令式打开流程。
4. `isInternalPageUrl(url)`：浏览器面板用于禁用注释与系统外部打开的页面策略。

公共契约使用 `CloudConnectionContextValue`、设备 ID、`isCurrent()` 和 `onOpened` 等通用
输入，不暴露 `VncConfigResponse`、session ID、WebSocket URL 或 noVNC 类型。内部覆盖
不存在时，fallback 返回 `available: false`、不渲染操作，并把所有 URL 判定为普通页面。
共享的中英文文案继续留在公共 i18n locale 中；它们是宿主展示数据，不包含 VNC 执行
逻辑，也不为本次迁移新增一套内部 i18n 注册机制。

公共 `src` 不直接导入 `@wecode/*`。现有 Vite alias 仍以
`wecode/extensions` 覆盖 `src/extensions`，因此内部能力可以独立替换，宿主无需知道 VNC
实现细节。

## 数据流

```text
设置页 DeviceAction / 项目工作台 open()
  -> 校验活动 Cloud Connection 与当前请求 generation
  -> api.ts 请求当前连接的 vnc-config
  -> 再次校验请求仍属于当前设备、项目和连接
  -> session.ts 调用 prepare_vnc_session
  -> 再次校验请求仍有效
  -> 构建仅含 sessionId、sandboxId 的 /vnc.html URL
  -> requestEmbeddedBrowserOpen
  -> vnc.html 调用 get_vnc_session_config
  -> noVNC 使用仅存在于子 WebView 内存中的认证 WebSocket URL
```

`open()` 必须允许调用方提供 `isCurrent()`，并在每个异步副作用之间检查它。设置页按钮和
项目工具卡继续拥有各自的请求 generation 与 UI 状态；共享函数不持有 React 状态。这样
连接、设备或项目切换后的旧响应不会准备新会话，也不会打开错误桌面。

页面 URL 继续只携带 `sessionId` 与 `sandboxId`，不得包含 token、signature、WebSocket
URL 或 Authorization 信息。Tauri 进程内会话仍是唯一的凭证交接通道。

## 静态资源交付

源文件移动到 `wecode/features/vnc/assets` 后必须删除 `public/vnc.html` 和
`public/novnc/rfb.min.js`，避免双份源文件漂移。

`viteAssets.ts` 提供一个内部 Vite plugin：

- 开发模式根据配置的 app base path 响应 `vnc.html` 与 `novnc/rfb.min.js`，设置正确的
  `text/html` 和 JavaScript MIME type。
- 构建模式使用固定 `fileName` 输出 `vnc.html` 与 `novnc/rfb.min.js` 到 `dist`。
- Vite 配置仅在内部 plugin 文件存在时动态加载它，使没有 `wecode` 覆盖的构建仍能使用
  公共 fallback，而不需要保留公开 VNC 资源。
- 页面继续以 `./novnc/rfb.min.js` 相对路径加载 bundle，兼容 app base path 和
  `tauri://localhost` production origin。

构建不得修改 bundle 内容或升级版本。Rust 页面安全测试通过
`CARGO_MANIFEST_DIR` 拼接新的源码位置，避免模块下移后依赖脆弱的相对层级。

## Rust 模块迁移

`src-tauri/src/vnc_session.rs` 移到 `src-tauri/src/wecode/vnc_session.rs`，
`wecode/mod.rs` 增加 `pub mod vnc_session`。`lib.rs` 只更新三类 Rust 路径：状态
`.manage(...)`、`prepare_vnc_session` handler 和 `get_vnc_session_config` handler。

以下外部契约保持完全不变：

- IPC 命令仍叫 `prepare_vnc_session` 与 `get_vnc_session_config`。
- `VncSessionState` 仍只注册一次。
- UUID、token、WebSocket URL、query、userinfo、fragment 与重复 session ID 校验不变。
- 会话 TTL 仍为两分钟，读取不消费也不续期。

## 错误处理

- 云连接缺少 API URL、socket URL 或 token：入口保持当前失败提示，不创建 IPC 会话。
- 配置接口失败或缺少 sandbox ID：当前入口显示可重试错误，项目工具不永久标记不可用。
- 连接、设备或项目在请求中变化：结果按 stale request 静默丢弃，不显示旧错误。
- Tauri 会话准备失败或内置浏览器拒绝 URL：显示现有打开失败文案，不回退到系统浏览器。
- VNC IPC 会话过期：页面继续显示现有“关闭后重新打开桌面”恢复指引。
- 静态资源缺失：构建和真实桌面验证必须失败，不添加 CDN 或 `public` fallback。

## 测试设计

### Feature 单元测试

- `api.test.ts`：当前连接 URL、Bearer token、encoded device ID、断开连接拒绝。
- `session.test.ts`：协议映射、无凭证页面 URL、app base path、IPC 参数、内部页面判定，
  并从新 asset 路径检查 noVNC 相对加载、内存重连和过期恢复。
- `openCloudDesktop.test.ts`：成功链路；配置、sandbox、IPC、浏览器拒绝失败；每个异步阶段
  的 stale request 丢弃。
- `VncDesktopButton.test.tsx`：加载去重、离线禁用、错误重试、连接切换和成功回调。
- `viteAssets.test.ts`：dev 路由、base path、MIME type、build 输出文件名和缺失资源失败。

### 宿主与原生回归

- 设置页、项目工具卡和浏览器面板测试保留在公共组件旁，改为断言扩展契约接线以及原有
  用户行为，不重复测试 feature 内部实现。
- Rust 全量 lib tests 必须覆盖移动后的会话模块和现有唯一原生 WebView 身份修复。
- Vite production build 必须实际生成 `dist/vnc.html` 与
  `dist/novnc/rfb.min.js`，且 HTML 继续引用相对 bundle。
- Desktop E2E 继续使用真实 HTTP Bearer 请求、WebSocket token、RFB 3.8/noVNC 握手，
  同时覆盖逻辑浏览器标签迁移后重新打开默认浏览器的回归路径。
- 隔离 `ai:verify` 会话复验真实 Tauri 页面可加载、URL 无凭证、旧逻辑标签不会触发
  `already exists`，并在结束时停止和清理会话。

## 验收标准

- 除通用契约、宿主接线和集成测试外，VNC 自有源代码与资源全部位于两个 `wecode`
  目录。
- `rg` 不再发现 `src/lib/vnc.ts`、公开 `getVncConfig` 或公开
  `VncConfigResponse` 定义。
- `public/vnc.html` 与 `public/novnc/rfb.min.js` 已删除，Vite dev/build 仍能通过原 URL
  提供字节等价资源。
- 设置页和项目工作台的桌面入口行为、错误恢复、竞态保护和测试标识不变。
- URL、IPC、安全校验、TTL、WebSocket 认证和 noVNC 生命周期不变。
- focused tests、Rust tests、格式化、ESLint、TypeScript、Vite build、Desktop E2E 与隔离
  Tauri 验证全部通过。
- 最终提交使用 Conventional Commit，并推送到
  `feature/wework-cloud-device-vnc-browser`。

---

## English Summary

Move all VNC-owned frontend logic, static assets, and the native session registry into Wecode.
Public Wework code consumes a generic cloud-desktop extension contract, while the internal overlay
binds that contract to the VNC feature. Vite continues to publish `/vnc.html` and
`/novnc/rfb.min.js`, and all IPC names, credential handoff rules, browser behavior, tests, and
security guarantees remain unchanged.
