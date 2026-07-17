---
sidebar_position: 6
---

# Wework 云设备 VNC 内置浏览器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让在线云设备的“桌面”操作使用当前云连接的 VNC 代理地址，在退出设置页后于工作台右侧内置浏览器展示 VNC 页面。

**Architecture:** 保留现有 VNC 配置接口、本地 `vnc.html` 和 `DesktopWorkbenchMain` 浏览器监听器。前端把云端 `/vnc-proxy/{deviceId}` WebSocket URL 与 token 注册到具有两分钟 IPC 交接 TTL 的 Tauri 内存会话，本地页面 URL 只携带随机 `sessionId`；VNC 子页取回配置后，在自身生命周期内缓存认证 WebSocket URL 以便断线重连。设置页只有在 `requestEmbeddedBrowserOpen` 接受请求后才返回工作台。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、Tauri WebView、noVNC、Wework Desktop E2E controller

---

## 文件职责

- `wework/src/lib/vnc.ts`：准备短期 VNC 会话并构建不含凭证的本地页面 URL。
- `wework/src/lib/vnc.test.ts`：锁定协议映射、会话 IPC、base path 和无凭证 URL。
- `wework/src/lib/browser-url.ts` 与 `browser-url.test.ts`：允许 HTTP(S) 和当前
  Tauri 应用同源页面，拒绝其他协议与不同源内部 URL。
- `wework/src/lib/embedded-browser.ts` 与 `embedded-browser.test.ts`：在分发内置浏览器
  打开请求前使用当前应用 origin 规范化和校验 URL。
- `wework/src-tauri/src/vnc_session.rs`：校验并保存短期 WebSocket URL 与 token。
- `wework/src-tauri/src/embedded_browser.rs`：为本地 Tauri URL 选择自定义协议 WebView。
- `wework/src/components/settings/ConnectionsSettingsPage.tsx`：加载 VNC 配置、请求内置浏览器、处理状态并在成功后退出设置。
- `wework/src/components/settings/ConnectionsSettingsPage.test.tsx`：覆盖按钮级成功、失败、加载、离线和重试行为。
- `wework/src/components/layout/workspace-panels/WorkspacePanelCards.tsx` 与其测试：为
  项目工作台的“桌面”工具接入同一 VNC 会话，区分云桌面 API 与运行时终端
  API，并丢弃设备或连接变化后的旧异步响应。
- `wework/src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx`：识别内部 VNC
  页面，禁用注释和系统外部打开操作。
- `wework/src/components/layout/DesktopWorkbenchLayout.test.tsx`：覆盖设置页到工作台右侧浏览器的组合流程。
- `wework/src/i18n/locales/{zh-CN,en}/common.json`：提供桌面操作和失败提示文案。
- `wework/public/vnc.html`：从相对 base path 加载 noVNC，通过 IPC 交接会话、
  在子 WebView 内存中缓存认证 WebSocket URL，并处理连接、断线重连和过期提示。
- `wework/e2e/desktop/task-flow.e2e.mjs`：通过真实 Tauri 应用和测试后端覆盖云设备入口、
  Bearer 配置请求、带 token 的 WebSocket upgrade、RFB 3.8 交换、noVNC `connect`
  事件对应的子页连接标题和右侧浏览器展示。
- `wework/wecode/components/VncDesktopButton.tsx`：删除未被引用且仍走外部浏览器的旧实现，避免保留冲突路径。

### Task 1: 建立安全的 VNC 会话主链路

**Files:**

- Modify: `wework/src/lib/vnc.test.ts`
- Modify: `wework/src/lib/vnc.ts`
- Modify: `wework/src/lib/browser-url.test.ts`
- Modify: `wework/src/lib/browser-url.ts`
- Modify: `wework/src/lib/embedded-browser.test.ts`
- Modify: `wework/src/lib/embedded-browser.ts`
- Modify: `wework/public/vnc.html`
- Create: `wework/src-tauri/src/vnc_session.rs`
- Modify: `wework/src-tauri/src/lib.rs`
- Modify: `wework/src-tauri/src/embedded_browser.rs`
- Delete: `wework/wecode/components/VncDesktopButton.tsx`

- [ ] **Step 1: 先写安全会话和协议映射的失败测试**

页面 URL 只能包含随机会话 ID 和 sandbox ID。云连接协议必须按
`http -> ws`、`https -> wss` 映射，并原样保留 `ws` / `wss`：

```ts
test("keeps credentials out of the VNC page URL", async () => {
  const sessionId = await prepareVncSession({
    deviceId: "device/1",
    socketBaseUrl: "https://cloud.example.com/wework/",
    token: "cloud-token",
  });
  const url = buildVncPageUrl({
    sandboxId: "sandbox-1",
    sessionId,
  });
  const parsedUrl = new URL(url);

  expect(invoke).toHaveBeenCalledWith("prepare_vnc_session", {
    sessionId,
    wsUrl: "wss://cloud.example.com/wework/vnc-proxy/device%2F1",
    token: "cloud-token",
  });
  expect(parsedUrl.searchParams.get("sessionId")).toBe(sessionId);
  expect(parsedUrl.searchParams.has("wsUrl")).toBe(false);
  expect(parsedUrl.toString()).not.toContain("cloud-token");
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm --filter wework test -- src/lib/vnc.test.ts`

Expected: FAIL，因为尚无 Tauri 安全会话，页面 URL 仍可能直接携带连接信息。

- [ ] **Step 3: 实现安全会话、页面和自定义协议 WebView**

```ts
export async function prepareVncSession({
  deviceId,
  socketBaseUrl,
  token,
}: PrepareVncSessionOptions): Promise<string> {
  const sessionId = crypto.randomUUID();
  const wsUrl = `${buildVncWebSocketBaseUrl(socketBaseUrl)}/vnc-proxy/${encodeURIComponent(deviceId)}`;
  await invoke("prepare_vnc_session", { sessionId, wsUrl, token });
  return sessionId;
}

export function buildVncPageUrl({
  sandboxId,
  sessionId,
}: BuildVncPageUrlOptions): string {
  const pageUrl = new URL(
    joinAppPath(getRuntimeConfig().appBasePath, "/vnc.html"),
    window.location.href,
  );
  pageUrl.searchParams.set("sessionId", sessionId);
  pageUrl.searchParams.set("sandboxId", sandboxId);
  return pageUrl.toString();
}
```

Rust 注册表使用两分钟 IPC 交接 TTL，校验 UUID v4、`ws` / `wss` 地址和 token，
并拒绝 URL 中已有 token、Authorization、userinfo 或 fragment 的输入。读取不延长 TTL。
`public/vnc.html` 通过 `get_vnc_session_config` IPC 取回配置，之后才在 VNC 子 WebView
内存中为 WebSocket URL 添加 token 查询参数，并在子页生命周期内缓存认证 URL
用于断线重连。完整 reload 会清除该缓存；若 IPC 会话已过期，页面必须提示关闭并
重新打开桌面，不再引导用户继续刷新。页面使用相对路径 `./novnc/rfb.min.js`。

`browser-url` 只允许 HTTP(S) 或与 `window.location.href` 同 origin 的 Tauri 应用 URL；
`requestEmbeddedBrowserOpen` 在交给工作台监听器前必须先通过该校验。

`embedded_browser_open` 对 `tauri://` 应用页面使用 `WebviewUrl::CustomProtocol`，普通
HTTP(S) 继续使用 `WebviewUrl::External`。同时删除没有调用方、仍使用 `window.open` 的
旧 `wecode/components/VncDesktopButton.tsx`。

- [ ] **Step 4: 运行测试并确认 GREEN**

Run: `pnpm --filter wework test -- src/lib/vnc.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交安全会话主链路**

```bash
git add wework/src/lib/vnc.ts wework/src/lib/vnc.test.ts wework/src/lib/browser-url.ts wework/src/lib/browser-url.test.ts wework/src/lib/embedded-browser.ts wework/src/lib/embedded-browser.test.ts wework/public/vnc.html wework/src-tauri/src/vnc_session.rs wework/src-tauri/src/lib.rs wework/src-tauri/src/embedded_browser.rs wework/wecode/components/VncDesktopButton.tsx
git commit -m "feat(wework): secure cloud VNC browser sessions"
```

### Task 2: 用内置浏览器打开并处理交互状态

**Files:**

- Modify: `wework/src/components/settings/ConnectionsSettingsPage.test.tsx`
- Modify: `wework/src/components/settings/ConnectionsSettingsPage.tsx`
- Modify: `wework/src/components/layout/workspace-panels/WorkspacePanelCards.test.tsx`
- Modify: `wework/src/components/layout/workspace-panels/WorkspacePanelCards.tsx`
- Modify: `wework/src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx`
- Modify: `wework/src/i18n/locales/zh-CN/common.json`
- Modify: `wework/src/i18n/locales/en/common.json`

- [ ] **Step 1: 写成功、失败、加载、离线和重试测试**

在测试中 mock `requestEmbeddedBrowserOpen`，默认返回 `true`。新增以下行为测试：

```ts
function createDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

test('opens cloud desktop in the built-in browser before leaving settings', async () => {
  const onBack = vi.fn()
  api.getAllDevices.mockResolvedValue([cloudDevice()])
  requestEmbeddedBrowserOpenMock.mockReturnValue(true)

  render(<ConnectionsSettingsPage onBack={onBack} />)
  await userEvent.click(await screen.findByTestId('connection-vnc-button-device-1'))

  await waitFor(() => expect(api.getVncConfig).toHaveBeenCalledWith('device-1'))
  const openedUrl = new URL(requestEmbeddedBrowserOpenMock.mock.calls[0][0])
  expect(openedUrl.pathname).toBe('/vnc.html')
  expect(openedUrl.searchParams.get('sessionId')).toBe('vnc-session-id')
  expect(openedUrl.searchParams.has('wsUrl')).toBe(false)
  expect(openedUrl.toString()).not.toContain('fallback-token')
  expect(prepareVncSessionMock).toHaveBeenCalledWith({
    deviceId: 'device-1',
    socketBaseUrl: 'http://localhost:3000',
    token: 'fallback-token',
  })
  expect(onBack).toHaveBeenCalledTimes(1)
  expect(openExternalUrlMock).not.toHaveBeenCalled()
})

test('stays in settings when the built-in browser cannot accept the VNC page', async () => {
  const onBack = vi.fn()
  api.getAllDevices.mockResolvedValue([cloudDevice()])
  requestEmbeddedBrowserOpenMock.mockReturnValue(false)

  render(<ConnectionsSettingsPage onBack={onBack} />)
  await userEvent.click(await screen.findByTestId('connection-vnc-button-device-1'))

  expect(await screen.findByRole('alert')).toHaveTextContent('无法在 Wework 中打开云桌面，请重试')
  expect(onBack).not.toHaveBeenCalled()
  expect(openExternalUrlMock).not.toHaveBeenCalled()
})

test('disables the VNC action while loading and prevents duplicate requests', async () => {
  const deferred = createDeferred<{
    wss_url: string
    signature: string
    sandbox_id: string
  }>()
  api.getAllDevices.mockResolvedValue([cloudDevice()])
  api.getVncConfig.mockReturnValueOnce(deferred.promise)

  render(<ConnectionsSettingsPage onBack={vi.fn()} />)
  const button = await screen.findByTestId('connection-vnc-button-device-1')
  await userEvent.click(button)
  expect(button).toBeDisabled()
  await userEvent.click(button)
  expect(api.getVncConfig).toHaveBeenCalledTimes(1)

  deferred.resolve({ wss_url: '', signature: '', sandbox_id: 'sandbox-1' })
})

test('disables the VNC action for an offline cloud device', async () => {
  api.getAllDevices.mockResolvedValue([cloudDevice({ status: 'offline' })])
  render(<ConnectionsSettingsPage onBack={vi.fn()} />)
  expect(await screen.findByTestId('connection-vnc-button-device-1')).toBeDisabled()
})
```

再用一次配置请求 reject 和一次 `requestEmbeddedBrowserOpen(false)` 后重试成功，覆盖配置失败与错误恢复。
同时把测试 runtime config 补全为 `socketBaseUrl: 'http://localhost:3000'` 和
`socketPath: '/socket.io'`，确保 fallback cloud connection 与生产类型一致。

- [ ] **Step 2: 运行组件测试并确认 RED**

Run: `pnpm --filter wework test -- src/components/settings/ConnectionsSettingsPage.test.tsx`

Expected: FAIL，因为当前实现调用 `openExternalUrl`，不会退出设置、禁用离线操作或显示错误。

- [ ] **Step 3: 实现 VNC 按钮及回调传递**

实现核心逻辑：

```tsx
function VncDesktopButton({
  deviceId,
  disabled,
  onOpened,
}: {
  deviceId: string;
  disabled: boolean;
  onOpened: () => void;
}) {
  const { t } = useTranslation("common");
  const cloudConnection = useOptionalCloudConnection();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = useCallback(async () => {
    if (disabled || loading) return;
    setLoading(true);
    setError(null);
    try {
      if (!cloudConnection.socketBaseUrl || !cloudConnection.token) {
        setError(t("workbench.connection_device_desktop_open_failed"));
        return;
      }
      const config =
        await createSettingsDeviceApi(cloudConnection).getVncConfig(deviceId);
      const sessionId = await prepareVncSession({
        deviceId,
        socketBaseUrl: cloudConnection.socketBaseUrl,
        token: cloudConnection.token,
      });
      const url = buildVncPageUrl({
        sandboxId: config.sandbox_id,
        sessionId,
      });
      if (!requestEmbeddedBrowserOpen(url)) {
        setError(t("workbench.connection_device_desktop_open_failed"));
        return;
      }
      onOpened();
    } catch (openError) {
      console.error("Failed to open device desktop:", openError);
      setError(t("workbench.connection_device_desktop_open_failed"));
    } finally {
      setLoading(false);
    }
  }, [cloudConnection, deviceId, disabled, loading, onOpened, t]);

  return (
    <div className="flex flex-col items-end gap-1">
      <DeviceActionButton
        testId={`connection-vnc-button-${deviceId}`}
        icon={Monitor}
        label={t("workbench.connection_device_desktop")}
        onClick={handleClick}
        disabled={disabled || loading}
      />
      {error && (
        <p
          role="alert"
          data-testid={`connection-vnc-error-${deviceId}`}
          className="max-w-48 text-right text-xs text-red-500"
        >
          {error}
        </p>
      )}
    </div>
  );
}
```

异步请求在获取配置和准备会话后都比较最新的设备与云连接上下文；若用户已断开或切换
连接，则丢弃旧响应。把 `onOpened` 从 `ConnectionsSettingsPage.onBack` 依次传入
`ConnectionsDeviceSettingsPage`、云设备 `DeviceSection` 和 `DeviceCard`，并向按钮传入
`disabled={!isOnline}`。远程设备区域不需要该回调。

`WorkspacePanelCards` 的云设备“桌面”工具复用 `prepareVncSession` 和
`requestEmbeddedBrowserOpen`，但终端 session 请求仍使用运行时 API，不得被云连接 API 取代。
`WorkspaceBrowserPanel` 通过 `isInternalVncPageUrl` 禁用 VNC 页面的注释和系统外部打开按钮。

新增双语文案：

```json
"connection_device_desktop": "桌面",
"connection_device_desktop_open_failed": "无法在 Wework 中打开云桌面，请重试"
```

```json
"connection_device_desktop": "Desktop",
"connection_device_desktop_open_failed": "Unable to open the cloud desktop in Wework. Try again."
```

- [ ] **Step 4: 运行组件测试并确认 GREEN**

Run: `pnpm --filter wework test -- src/components/settings/ConnectionsSettingsPage.test.tsx`

Expected: PASS，且测试输出没有未处理错误或 React 警告。

- [ ] **Step 5: 提交设置页行为**

```bash
git add wework/src/components/settings/ConnectionsSettingsPage.tsx wework/src/components/settings/ConnectionsSettingsPage.test.tsx wework/src/components/layout/workspace-panels/WorkspacePanelCards.tsx wework/src/components/layout/workspace-panels/WorkspacePanelCards.test.tsx wework/src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx wework/src/i18n/locales/en/common.json wework/src/i18n/locales/zh-CN/common.json
git commit -m "feat(wework): open cloud desktop in built-in browser"
```

### Task 3: 增加桌面组合与真实 Tauri 回归

**Files:**

- Modify: `wework/src/components/layout/DesktopWorkbenchLayout.test.tsx`
- Modify: `wework/e2e/desktop/task-flow.e2e.mjs`

- [ ] **Step 1: 写设置页到右侧浏览器的组合测试**

测试使用真实 `requestEmbeddedBrowserOpen` 内存监听器，预先设置 Tauri runtime 标志和
`/settings/connections` 路由。点击按钮后断言：

```ts
expect(screen.queryByTestId("wework-settings-page")).not.toBeInTheDocument();
expect(screen.getByTestId("right-workspace-browser-tab")).toHaveAttribute(
  "aria-selected",
  "true",
);
expect(screen.getByTestId("workspace-browser-url-input")).toHaveValue(
  expect.stringContaining("/vnc.html?"),
);
```

- [ ] **Step 2: 运行组合测试并确认 RED**

Run: `pnpm --filter wework test -- src/components/layout/DesktopWorkbenchLayout.test.tsx -t "opens cloud VNC from settings in the right browser panel"`

Expected: FAIL，因为旧实现不会关闭设置页或打开右侧浏览器。

- [ ] **Step 3: 运行组合测试并确认 GREEN**

Task 2 实现后重新运行同一命令。

Expected: PASS。

- [ ] **Step 4: 扩展 Desktop E2E 测试后端和主路径**

在 `DesktopE2EServer.handle` 增加真实 HTTP 测试路由，并强制校验当前云连接的
Bearer token：

```js
const CLOUD_DEVICE_ID = "wework-desktop-e2e-cloud-device";
const CLOUD_DEVICE_SANDBOX_ID = "wework-desktop-e2e-sandbox";
const CLOUD_DEVICE_TOKEN = "wework-desktop-e2e-cloud-token";

function desktopE2ECloudDevice() {
  return {
    id: 9100,
    device_id: CLOUD_DEVICE_ID,
    name: "Desktop E2E Cloud Device",
    status: "online",
    is_default: false,
    device_type: "cloud",
    bind_shell: "claudecode",
    executor_version: "1.8.5",
    cloud_config: {
      sandboxId: CLOUD_DEVICE_SANDBOX_ID,
      deviceId: CLOUD_DEVICE_ID,
      deviceName: "Desktop E2E Cloud Device",
    },
  };
}

if (request.method === "GET" && url.pathname === "/api/devices") {
  json(response, 200, { items: [desktopE2ECloudDevice()], total: 1 });
  return;
}

if (
  request.method === "GET" &&
  url.pathname === `/api/cloud-devices/${CLOUD_DEVICE_ID}/vnc-config`
) {
  if (request.headers.authorization !== `Bearer ${CLOUD_DEVICE_TOKEN}`) {
    json(response, 401, { error: "Desktop E2E VNC authorization is missing" });
    return;
  }
  this.vncConfigRequests += 1;
  json(response, 200, {
    wss_url: "wss://unused.example.test/vnc",
    signature: "desktop-e2e-signature",
    sandbox_id: CLOUD_DEVICE_SANDBOX_ID,
  });
  return;
}
```

测试服务器同时处理 `/vnc-proxy/{deviceId}` 的真实 WebSocket upgrade：路径或
`token` 查询参数不正确时返回 401；通过后以 `RFB 003.008` 开始 RFB 3.8 交换，
确认 noVNC 的客户版本、None security 选择和 `ClientInit`，然后发送 `ServerInit`。
子页只在 noVNC `connect` 事件中设置 `data-vnc-connected="true"`，并把标题更新为
`云桌面 - ${sandboxId}`；E2E 读取原生子 WebView 页面状态，同时等待连接标志和该标题，
从而确认 `ServerInit` 后 noVNC 已触发 `connect`。

在 `DesktopE2EServer` 构造函数中初始化 `this.vncConfigRequests = 0`。主流程使用以下
动作和断言：

```js
phase = "cloud-vnc-browser";
await control.command("click", '[data-testid="settings-button"]');
await control.command("click", '[data-testid="settings-menu-button"]');
await control.command("click", '[data-testid="settings-nav-connections"]');
await control.command(
  "waitFor",
  `[data-testid="connection-vnc-button-${CLOUD_DEVICE_ID}"]`,
  {
    enabled: true,
    timeoutMs: UI_TIMEOUT_MS,
  },
);
await control.command(
  "click",
  `[data-testid="connection-vnc-button-${CLOUD_DEVICE_ID}"]`,
);
await control.command(
  "waitFor",
  '[data-testid="right-workspace-browser-tab"][aria-selected="true"]',
  { timeoutMs: UI_TIMEOUT_MS },
);
await control.command(
  "waitFor",
  '[data-testid="workspace-browser-panel"]:not(.hidden)',
  {
    timeoutMs: UI_TIMEOUT_MS,
  },
);
await control.command(
  "waitFor",
  '[data-testid="workspace-browser-url-input"][value*="/vnc.html?"][value*="sessionId="]:not([value*="token"]):not([value*="wsUrl"])',
  { timeoutMs: UI_TIMEOUT_MS },
);
const vncState = await waitForVncConnection(control, CLOUD_DEVICE_SANDBOX_ID);
await control.command(
  "waitFor",
  '[data-testid="right-workspace-browser-tab"]',
  {
    text: CLOUD_DEVICE_SANDBOX_ID,
  },
);
const vncSnapshot = JSON.parse(await control.command("snapshot", "body"));
assert.equal(vncSnapshot.testIds.includes("wework-settings-page"), false);
assert.equal(control.vncConfigRequests, 1);
assert.equal(control.vncProtocolError, null);
assert.equal(control.vncRfbConnections, 1);
assert.equal(vncState.connected, "true");
assert.match(vncState.title, new RegExp(CLOUD_DEVICE_SANDBOX_ID));
```

在主流程的工作台就绪阶段点击设置、云端连接和桌面按钮，然后断言设置页消失、
`right-workspace-browser-tab` 与安全的 `workspace-browser-url-input` 出现，
`control.vncConfigRequests === 1`，WebSocket token 校验通过、RFB 3.8 握手无协议错误，
且子 WebView 连接标题已更新。测试不伪造前端 API；配置请求和协议连接都经过
测试后端。

- [ ] **Step 5: 提交桌面回归**

```bash
git add wework/src/components/layout/DesktopWorkbenchLayout.test.tsx wework/e2e/desktop/task-flow.e2e.mjs
git commit -m "test(wework): cover cloud VNC browser flow"
```

### Task 4: 验证、真实桌面检查与收尾

**Files:**

- Verify all modified files

- [ ] **Step 1: 执行聚焦与相关回归测试**

```bash
pnpm --filter wework test -- src/lib/vnc.test.ts src/lib/browser-url.test.ts src/lib/embedded-browser.test.ts src/components/settings/ConnectionsSettingsPage.test.tsx src/components/layout/workspace-panels/WorkspacePanelCards.test.tsx src/components/layout/workspace-panels/WorkspaceBrowserPanel.test.tsx src/components/layout/DesktopWorkbenchLayout.test.tsx
```

Expected: 全部 PASS。

- [ ] **Step 2: 执行格式、lint 和类型检查**

```bash
pnpm --filter wework exec prettier --check src/lib/vnc.ts src/lib/vnc.test.ts src/lib/browser-url.ts src/lib/browser-url.test.ts src/lib/embedded-browser.ts src/lib/embedded-browser.test.ts src/components/settings/ConnectionsSettingsPage.tsx src/components/settings/ConnectionsSettingsPage.test.tsx src/components/layout/workspace-panels/WorkspacePanelCards.tsx src/components/layout/workspace-panels/WorkspacePanelCards.test.tsx src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx src/components/layout/workspace-panels/WorkspaceBrowserPanel.test.tsx src/components/layout/DesktopWorkbenchLayout.test.tsx src/e2e/automation.ts e2e/desktop/task-flow.e2e.mjs public/vnc.html
pnpm --filter wework exec eslint src/lib/vnc.ts src/lib/vnc.test.ts src/lib/browser-url.ts src/lib/browser-url.test.ts src/lib/embedded-browser.ts src/lib/embedded-browser.test.ts src/components/settings/ConnectionsSettingsPage.tsx src/components/settings/ConnectionsSettingsPage.test.tsx src/components/layout/workspace-panels/WorkspacePanelCards.tsx src/components/layout/workspace-panels/WorkspacePanelCards.test.tsx src/components/layout/workspace-panels/WorkspaceBrowserPanel.tsx src/components/layout/workspace-panels/WorkspaceBrowserPanel.test.tsx src/components/layout/DesktopWorkbenchLayout.test.tsx src/e2e/automation.ts
pnpm --filter wework typecheck
cargo fmt --manifest-path wework/src-tauri/Cargo.toml -- --check
cargo test --manifest-path wework/src-tauri/Cargo.toml --locked --lib
```

Expected: 全部退出码为 0。

- [ ] **Step 3: 执行 Desktop E2E**

Run: `pnpm --filter wework e2e:desktop`

Expected: 真实 Tauri 应用完成云设备设置到右侧浏览器的回归，以及原有 task-flow 场景。

- [ ] **Step 4: 执行隔离 Tauri QA 计划**

主路径：在线云设备 → 桌面 → 设置关闭 → 右侧浏览器选中 → VNC 页面加载。

负向路径：内置浏览器不可用时保留设置页并显示错误；离线设备按钮禁用。

恢复路径：失败后恢复浏览器监听器，再次点击可成功进入右侧浏览器。

使用 `pnpm --filter wework ai:verify start` 创建隔离会话，以 `snapshot`、`click`、
`wait-for` 和 `capture` 留存结果，结束时始终运行 `ai:verify stop`。记录实际结果、日志
目录和截图路径；不得打印会话文件或 token。

- [ ] **Step 5: 完成需求审计并提交剩余格式化改动**

逐项核对：内部浏览器、退出设置、无凭证页面 URL、短期会话、VNC 代理地址、云 token、
离线禁用、失败可见、无系统浏览器回退、单元/组合/E2E/真实 Tauri 证据。确认
`git status --short` 只包含预期内容，
必要时提交：

```bash
git add wework
git commit -m "chore(wework): finish cloud VNC verification"
```

---

## English Summary

The implementation keeps the VNC page inside Wework and stores the active cloud
backend's `/vnc-proxy/{deviceId}` URL and token in a short-lived in-memory Tauri
session. Its two-minute TTL is only the IPC handoff window. The browser page URL
contains only a random session ID; after the handoff, the VNC child WebView
caches the authenticated WebSocket URL in memory for reconnects during its
lifetime. An expired full reload instructs the user to close and reopen Desktop.
Settings closes only after the existing embedded-browser request channel accepts
the request. Tests cover same-origin URL validation, settings and workspace-card
entries, component states, disabled annotation/external-open controls, the
settings-to-workbench transition, real HTTP Bearer and WebSocket token checks,
RFB 3.8 negotiation, the noVNC connected child-page title, and isolated Tauri
behavior.
