---
sidebar_position: 6
---

# Wework 云设备 VNC 内置浏览器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让在线云设备的“桌面”操作使用当前云连接的 VNC 代理地址，在退出设置页后于工作台右侧内置浏览器展示 VNC 页面。

**Architecture:** 保留现有 VNC 配置接口、本地 `vnc.html` 和 `DesktopWorkbenchMain` 浏览器监听器。URL 构建器把本地页面 URL 与云端 `/vnc-proxy/{deviceId}` WebSocket URL 分离；设置页只有在 `requestEmbeddedBrowserOpen` 接受请求后才返回工作台。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、Tauri WebView、noVNC、Wework Desktop E2E controller

---

## 文件职责

- `wework/src/lib/vnc.ts`：构建本地 VNC 页面 URL 和云端 WebSocket 代理 URL。
- `wework/src/lib/vnc.test.ts`：锁定云地址、token、base path 和编码行为。
- `wework/src/components/settings/ConnectionsSettingsPage.tsx`：加载 VNC 配置、请求内置浏览器、处理状态并在成功后退出设置。
- `wework/src/components/settings/ConnectionsSettingsPage.test.tsx`：覆盖按钮级成功、失败、加载、离线和重试行为。
- `wework/src/components/layout/DesktopWorkbenchLayout.test.tsx`：覆盖设置页到工作台右侧浏览器的组合流程。
- `wework/src/i18n/locales/{zh-CN,en}/common.json`：提供桌面操作和失败提示文案。
- `wework/public/vnc.html`：从相对 base path 加载 noVNC 静态资源。
- `wework/e2e/desktop/task-flow.e2e.mjs`：通过真实 Tauri 应用和测试后端覆盖云设备入口、配置请求和右侧浏览器展示。
- `wework/wecode/components/VncDesktopButton.tsx`：删除未被引用且仍走外部浏览器的旧实现，避免保留冲突路径。

### Task 1: 修正 VNC URL 主链路

**Files:**
- Modify: `wework/src/lib/vnc.test.ts`
- Modify: `wework/src/lib/vnc.ts`
- Modify: `wework/public/vnc.html`
- Delete: `wework/wecode/components/VncDesktopButton.tsx`

- [ ] **Step 1: 先写云端代理 URL 的失败测试**

把 `buildVncPageUrl` 测试改为显式传入当前云连接信息：

```ts
test('keeps the VNC page local and uses the cloud WebSocket proxy', () => {
  window.__WEWORK_RUNTIME_CONFIG__ = {
    ...window.__WEWORK_RUNTIME_CONFIG__,
    appBasePath: '/wework',
  }

  const url = buildVncPageUrl({
    deviceId: 'device/1',
    sandboxId: 'sandbox-1',
    socketBaseUrl: 'https://cloud.example.com/wework/',
    token: 'cloud token',
  })
  const parsedUrl = new URL(url)

  expect(parsedUrl.origin).toBe(window.location.origin)
  expect(parsedUrl.pathname).toBe('/wework/vnc.html')
  expect(parsedUrl.searchParams.get('sandboxId')).toBe('sandbox-1')
  expect(parsedUrl.searchParams.get('wsUrl')).toBe(
    'wss://cloud.example.com/wework/vnc-proxy/device%2F1?token=cloud%20token'
  )
})

test('uses ws for an http cloud connection', () => {
  const url = buildVncPageUrl({
    deviceId: 'device-1',
    sandboxId: 'sandbox-1',
    socketBaseUrl: 'http://127.0.0.1:8000',
    token: 'token',
  })

  expect(new URL(url).searchParams.get('wsUrl')).toBe(
    'ws://127.0.0.1:8000/vnc-proxy/device-1?token=token'
  )
})
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `pnpm --filter wework test -- src/lib/vnc.test.ts`

Expected: FAIL，因为现有函数仍接收两个字符串并生成不存在的 `/api/.../vnc-ws` 地址。

- [ ] **Step 3: 实现最小 URL 构建器**

```ts
interface BuildVncPageUrlOptions {
  deviceId: string
  sandboxId: string
  socketBaseUrl: string
  token: string
}

function buildVncWebSocketBaseUrl(socketBaseUrl: string): string {
  const url = new URL(socketBaseUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/+$/, '')
}

export function buildVncPageUrl({
  deviceId,
  sandboxId,
  socketBaseUrl,
  token,
}: BuildVncPageUrlOptions): string {
  const { appBasePath } = getRuntimeConfig()
  const vncWsUrl = `${buildVncWebSocketBaseUrl(socketBaseUrl)}/vnc-proxy/${encodeURIComponent(deviceId)}?token=${encodeURIComponent(token)}`
  const pageUrl = new URL(joinAppPath(appBasePath, '/vnc.html'), window.location.origin)
  pageUrl.searchParams.set('wsUrl', vncWsUrl)
  pageUrl.searchParams.set('sandboxId', sandboxId)
  return pageUrl.toString()
}
```

把 `public/vnc.html` 的脚本地址改为 `./novnc/rfb.min.js`，并删除没有调用方、仍使用 `window.open` 的旧 `wecode/components/VncDesktopButton.tsx`。

- [ ] **Step 4: 运行测试并确认 GREEN**

Run: `pnpm --filter wework test -- src/lib/vnc.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交 URL 主链路**

```bash
git add wework/src/lib/vnc.ts wework/src/lib/vnc.test.ts wework/public/vnc.html wework/wecode/components/VncDesktopButton.tsx
git commit -m "fix(wework): build cloud VNC proxy URL"
```

### Task 2: 用内置浏览器打开并处理交互状态

**Files:**
- Modify: `wework/src/components/settings/ConnectionsSettingsPage.test.tsx`
- Modify: `wework/src/components/settings/ConnectionsSettingsPage.tsx`
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
  expect(openedUrl.searchParams.get('wsUrl')).toBe(
    'ws://localhost:3000/vnc-proxy/device-1?token=fallback-token'
  )
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
  deviceId: string
  disabled: boolean
  onOpened: () => void
}) {
  const { t } = useTranslation('common')
  const cloudConnection = useOptionalCloudConnection()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleClick = useCallback(async () => {
    if (disabled || loading) return
    setLoading(true)
    setError(null)
    try {
      if (!cloudConnection.socketBaseUrl || !cloudConnection.token) {
        setError(t('workbench.connection_device_desktop_open_failed'))
        return
      }
      const config = await createSettingsDeviceApi(cloudConnection).getVncConfig(deviceId)
      const url = buildVncPageUrl({
        deviceId,
        sandboxId: config.sandbox_id,
        socketBaseUrl: cloudConnection.socketBaseUrl,
        token: cloudConnection.token ?? '',
      })
      if (!requestEmbeddedBrowserOpen(url)) {
        setError(t('workbench.connection_device_desktop_open_failed'))
        return
      }
      onOpened()
    } catch (openError) {
      console.error('Failed to open device desktop:', openError)
      setError(t('workbench.connection_device_desktop_open_failed'))
    } finally {
      setLoading(false)
    }
  }, [cloudConnection, deviceId, disabled, loading, onOpened, t])

  return (
    <div className="flex flex-col items-end gap-1">
      <DeviceActionButton
        testId={`connection-vnc-button-${deviceId}`}
        icon={Monitor}
        label={t('workbench.connection_device_desktop')}
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
  )
}
```

把 `onOpened` 从 `ConnectionsSettingsPage.onBack` 依次传入
`ConnectionsDeviceSettingsPage`、云设备 `DeviceSection` 和 `DeviceCard`，并向按钮传入
`disabled={!isOnline}`。远程设备区域不需要该回调。

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
git add wework/src/components/settings/ConnectionsSettingsPage.tsx wework/src/components/settings/ConnectionsSettingsPage.test.tsx wework/src/i18n/locales/en/common.json wework/src/i18n/locales/zh-CN/common.json
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
expect(screen.queryByTestId('wework-settings-page')).not.toBeInTheDocument()
expect(screen.getByTestId('right-workspace-browser-tab')).toHaveAttribute(
  'aria-selected',
  'true'
)
expect(screen.getByTestId('workspace-browser-url-input')).toHaveValue(
  expect.stringContaining('/vnc.html?')
)
```

- [ ] **Step 2: 运行组合测试并确认 RED**

Run: `pnpm --filter wework test -- src/components/layout/DesktopWorkbenchLayout.test.tsx -t "opens cloud VNC from settings in the right browser panel"`

Expected: FAIL，因为旧实现不会关闭设置页或打开右侧浏览器。

- [ ] **Step 3: 运行组合测试并确认 GREEN**

Task 2 实现后重新运行同一命令。

Expected: PASS。

- [ ] **Step 4: 扩展 Desktop E2E 测试后端和主路径**

在 `DesktopE2EServer.handle` 增加真实 HTTP 测试路由：

```js
const E2E_CLOUD_DEVICE_ID = 'desktop-e2e-cloud-device'

function desktopE2ECloudDevice() {
  return {
    id: 9100,
    device_id: E2E_CLOUD_DEVICE_ID,
    name: 'Desktop E2E Cloud Device',
    status: 'online',
    is_default: false,
    device_type: 'cloud',
    bind_shell: 'claudecode',
    executor_version: '1.8.5',
    cloud_config: {
      sandboxId: 'desktop-e2e-sandbox',
      deviceId: E2E_CLOUD_DEVICE_ID,
      deviceName: 'Desktop E2E Cloud Device',
    },
  }
}

if (request.method === 'GET' && url.pathname === '/api/devices') {
  json(response, 200, { items: [desktopE2ECloudDevice()], total: 1 })
  return
}

if (
  request.method === 'GET' &&
  url.pathname === `/api/cloud-devices/${E2E_CLOUD_DEVICE_ID}/vnc-config`
) {
  this.vncConfigRequests += 1
  json(response, 200, {
    wss_url: 'wss://unused.example.test/vnc',
    signature: 'desktop-e2e-signature',
    sandbox_id: 'desktop-e2e-sandbox',
  })
  return
}
```

在 `DesktopE2EServer` 构造函数中初始化 `this.vncConfigRequests = 0`。主流程使用以下
动作和断言：

```js
phase = 'cloud-vnc-browser'
await control.command('click', '[data-testid="settings-button"]')
await control.command('click', '[data-testid="settings-menu-button"]')
await control.command('click', '[data-testid="settings-nav-connections"]')
await control.command(
  'clickWhenEnabled',
  `[data-testid="connection-vnc-button-${E2E_CLOUD_DEVICE_ID}"]`,
  { stableMs: COMPOSER_READY_STABILITY_MS, timeoutMs: UI_TIMEOUT_MS }
)
await control.command('waitFor', '[data-testid="right-workspace-browser-tab"]', {
  timeoutMs: UI_TIMEOUT_MS,
})
await control.command('waitFor', '[data-testid="workspace-browser-url-input"]', {
  timeoutMs: UI_TIMEOUT_MS,
})
const vncSnapshot = JSON.parse(await control.command('snapshot', 'body'))
assert.equal(vncSnapshot.testIds.includes('wework-settings-page'), false)
assert.equal(control.vncConfigRequests, 1)
```

在主流程的工作台就绪阶段点击设置、云端连接和桌面按钮，然后断言设置页消失、
`right-workspace-browser-tab` 与 `workspace-browser-url-input` 出现，并且
`control.vncConfigRequests === 1`。测试不伪造前端 API；所有配置请求都经过测试 HTTP
后端。

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
pnpm --filter wework test -- src/lib/vnc.test.ts src/components/settings/ConnectionsSettingsPage.test.tsx src/components/layout/DesktopWorkbenchLayout.test.tsx
```

Expected: 全部 PASS。

- [ ] **Step 2: 执行格式、lint 和类型检查**

```bash
pnpm --filter wework exec prettier --check src/lib/vnc.ts src/lib/vnc.test.ts src/components/settings/ConnectionsSettingsPage.tsx src/components/settings/ConnectionsSettingsPage.test.tsx src/components/layout/DesktopWorkbenchLayout.test.tsx e2e/desktop/task-flow.e2e.mjs src/i18n/locales/en/common.json src/i18n/locales/zh-CN/common.json public/vnc.html
pnpm --filter wework exec eslint src/lib/vnc.ts src/lib/vnc.test.ts src/components/settings/ConnectionsSettingsPage.tsx src/components/settings/ConnectionsSettingsPage.test.tsx src/components/layout/DesktopWorkbenchLayout.test.tsx
pnpm --filter wework typecheck
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

逐项核对：内部浏览器、退出设置、VNC 代理地址、云 token、离线禁用、失败可见、无系统
浏览器回退、单元/组合/E2E/真实 Tauri 证据。确认 `git status --short` 只包含预期内容，
必要时提交：

```bash
git add wework
git commit -m "chore(wework): finish cloud VNC verification"
```

---

## English Summary

The implementation keeps the VNC page inside Wework, connects it to the active
cloud backend's `/vnc-proxy/{deviceId}` endpoint with the cloud token, and uses
the existing embedded-browser request channel. Settings closes only after the
request is accepted. Tests cover URL construction, component states, the
settings-to-workbench transition, the real HTTP boundary, and isolated Tauri
behavior.
