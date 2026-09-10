# 智能工作台首版统计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为智能工作台建立可验证、保护隐私的“浏览 → 安装/更新 → 打开”首版 telemetry 漏斗。

**Architecture:** 入口打开继续由应用根部的路由 telemetry 统一产生，路由映射改为同时读取 pathname 与 query string。市场与 ZIP 安装在 `SmartAppsMarketplacePage` 内，以本地安装 API 返回的 `HarnessAppInstallation` 为成功事实点；市场待安装状态保存显式安装意图，从而让更新与首次安装使用不同事件。所有事件仍经 `events.ts` 的类型、属性白名单和值约束和现有 `track()` 脱敏路径发送。

**Tech Stack:** React、TypeScript、Vitest、Testing Library、Electron desktop E2E、PostHog telemetry client。

---

## 文件结构

| 文件 | 责任 |
| --- | --- |
| `wework/src/telemetry/events.ts` | 声明智能工作台事件类型、允许属性和受限枚举值。 |
| `wework/src/telemetry/client.test.ts` | 验证新增事件只发送允许的粗粒度属性，并丢弃资源标识符。 |
| `wework/src/App.tsx` | 根据完整路由位置识别智能工作台市场、我的工作台和具体工作台入口。 |
| `wework/src/App.plugins.test.tsx` | 验证路由映射和同一路径查询参数变化的 `feature_opened` 上报。 |
| `wework/dsh/ui-applications/src/SmartAppsMarketplacePage.tsx` | 在市场下载/安装/更新和 ZIP 导入真实成功或失败的事实点调用 `track()`。 |
| `wework/dsh/ui-applications/src/SmartAppsMarketplacePage.test.tsx` | 覆盖首次安装、市场更新、ZIP 导入和四类失败事件，且不泄露资源信息。 |

不新增 UI 文案、网络 API、存储字段或 telemetry 关联 ID。现有 `harness-apps` desktop
checkpoint 已覆盖市场安装、我的工作台和运行工作台的真实用户路径；本变更不增加与
产品行为无关的独立 E2E 入口。

### Task 1: 定义事件契约并验证客户端脱敏

**Files:**
- Modify: `wework/src/telemetry/events.ts:85-205,305-320,400-505`
- Modify: `wework/src/telemetry/client.test.ts:1-35,590-645`

- [ ] **Step 1: 写出失败的智能工作台事件脱敏测试。**

在 `client.test.ts` 的通用 feature action 脱敏测试后添加以下测试。它故意通过
类型断言传入禁止字段，确认运行时白名单而非 TypeScript 类型本身承担最后一道
隐私防线。

```ts
test('captures smart app events with coarse properties only', async () => {
  const { installTelemetry, track } = await import('./client')
  await installTelemetry(true)

  track('smart_app_installed', {
    install_source: 'marketplace',
    smart_app_id: 'private-smart-app',
    file_path: '/Users/private/Downloads/workbench.zip',
  } as {
    install_source: 'marketplace'
    smart_app_id: string
    file_path: string
  })
  track('feature_action_completed', {
    domain: 'smart_app',
    action: 'update',
    app_name: 'private workbench',
  } as { domain: 'smart_app'; action: 'update'; app_name: string })
  track('operation_failed', {
    operation: 'smart_app_zip_import',
    error_message: 'private archive validation detail',
  } as { operation: 'smart_app_zip_import'; error_message: string })

  await flushPostHogCaptures()

  expect(posthogMocks.capture).toHaveBeenNthCalledWith(
    1,
    'smart_app_installed',
    expect.objectContaining({ install_source: 'marketplace' })
  )
  expect(posthogMocks.capture.mock.calls[0]?.[1]).not.toHaveProperty('smart_app_id')
  expect(posthogMocks.capture.mock.calls[0]?.[1]).not.toHaveProperty('file_path')
  expect(posthogMocks.capture).toHaveBeenNthCalledWith(
    2,
    'feature_action_completed',
    expect.objectContaining({ domain: 'smart_app', action: 'update' })
  )
  expect(posthogMocks.capture.mock.calls[1]?.[1]).not.toHaveProperty('app_name')
  expect(posthogMocks.capture).toHaveBeenNthCalledWith(
    3,
    'operation_failed',
    expect.objectContaining({ operation: 'smart_app_zip_import' })
  )
  expect(posthogMocks.capture.mock.calls[2]?.[1]).not.toHaveProperty('error_message')
})
```

- [ ] **Step 2: 运行测试，确认契约尚未定义时失败。**

Run:

```bash
pnpm --filter wework test src/telemetry/client.test.ts
```

Expected: `smart_app_installed` 不被 `AnalyticsEventMap` 接受，或新增测试的
capture 断言失败。

- [ ] **Step 3: 在三处事件契约同步加入受限值。**

在 `AnalyticsEventMap` 添加 `smart_app_installed`；在现有 union 的末尾插入以下
精确行：

```ts
      | 'smart_apps_marketplace'
      | 'smart_apps_owned'
      | 'smart_app'

smart_app_installed: {
  install_source: 'marketplace' | 'zip_import'
}

      | 'smart_app_marketplace_download'
      | 'smart_app_marketplace_install'
      | 'smart_app_marketplace_update'
      | 'smart_app_zip_import'

      | 'smart_app'
```

在 `ANALYTICS_EVENT_PROPERTY_KEYS` 添加：

```ts
smart_app_installed: ['install_source'],
```

在 `ANALYTICS_EVENT_VALUE_CONSTRAINTS` 添加或扩展：

```ts
// Append these three values to feature_opened.feature.
'smart_apps_marketplace',
'smart_apps_owned',
'smart_app',

smart_app_installed: { install_source: ['marketplace', 'zip_import'] },

// Append these four values to operation_failed.operation.
'smart_app_marketplace_download',
'smart_app_marketplace_install',
'smart_app_marketplace_update',
'smart_app_zip_import',

// Append this value to feature_action_completed.domain.
'smart_app',
```

不要把应用 ID、名称、市场 ID、文件名、路径、模型名、原始错误或用户内容加入
任一事件属性、属性白名单或值约束。

- [ ] **Step 4: 运行 telemetry 测试，确认契约和白名单同时生效。**

Run:

```bash
pnpm --filter wework test src/telemetry/client.test.ts
```

Expected: 所有 telemetry client 测试通过，且新增测试只看到
`install_source`、`domain`、`action`、`operation` 及通用安全属性。

- [ ] **Step 5: 提交事件契约和客户端测试。**

```bash
git add wework/src/telemetry/events.ts wework/src/telemetry/client.test.ts
git commit -m "feat(wework): define smart app telemetry events"
```

### Task 2: 由完整路由位置统一统计智能工作台入口

**Files:**
- Modify: `wework/src/App.tsx:162-193,503-585`
- Modify: `wework/src/App.plugins.test.tsx:1-25,1019-1080,2200-2300`

- [ ] **Step 1: 写出路由映射和 query string 变化的失败测试。**

在 `App.plugins.test.tsx` 将默认导入改为命名导入：

```ts
import App, { telemetryFeatureForLocation } from './App'
```

添加纯映射断言，覆盖三种智能工作台入口和两种既有通用入口：

```ts
test('maps smart app locations to distinct telemetry features', () => {
  expect(telemetryFeatureForLocation('/sites', '?app_type=smart_app')).toBe(
    'smart_apps_marketplace'
  )
  expect(telemetryFeatureForLocation('/sites', '?app_type=smart_app&view=owned')).toBe(
    'smart_apps_owned'
  )
  expect(telemetryFeatureForLocation('/app/harness-research-desk', '')).toBe('smart_app')
  expect(telemetryFeatureForLocation('/sites', '?app_type=web')).toBe('sites')
  expect(telemetryFeatureForLocation('/app/native-task', '')).toBe('apps')
})
```

为验证 React effect 的依赖，新增一个 hoisted `track` mock，并部分 mock telemetry
模块以保留 `TelemetryBridge` 需要的其余导出：

```ts
const telemetryMocks = vi.hoisted(() => ({ track: vi.fn() }))

vi.mock('@/telemetry/client', async importOriginal => ({
  ...(await importOriginal<typeof import('@/telemetry/client')>()),
  track: telemetryMocks.track,
}))
```

在 `beforeEach` 重置 `telemetryMocks.track`，再添加以下集成断言：

```ts
test('tracks a Smart apps view change when only search changes', async () => {
  window.history.pushState({}, '', '/sites?app_type=smart_app')
  renderApp()

  await waitFor(() =>
    expect(telemetryMocks.track).toHaveBeenCalledWith('feature_opened', {
      feature: 'smart_apps_marketplace',
    })
  )

  act(() => {
    window.history.pushState({}, '', '/sites?app_type=smart_app&view=owned')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })

  await waitFor(() =>
    expect(telemetryMocks.track).toHaveBeenLastCalledWith('feature_opened', {
      feature: 'smart_apps_owned',
    })
  )
})
```

- [ ] **Step 2: 运行路由测试，确认新 helper 尚不存在且上报错误。**

Run:

```bash
pnpm --filter wework test src/App.plugins.test.tsx
```

Expected: 编译错误显示 `telemetryFeatureForLocation` 尚未导出，或 telemetry
assertion 仍得到通用 `sites` feature。

- [ ] **Step 3: 实现基于 pathname 和 search 的路由映射。**

保留 `useCurrentPath()` 供不需要 search 的 `App` 根组件使用。在 `AppRoutes`
改用 `useCurrentLocation()`，并将旧 helper 替换为可测试的命名导出：

```ts
export function telemetryFeatureForLocation(pathname: string, search: string) {
  const searchParams = new URLSearchParams(search)
  if (pathname === '/sites' && searchParams.get('app_type') === 'smart_app') {
    return searchParams.get('view') === 'owned'
      ? ('smart_apps_owned' as const)
      : ('smart_apps_marketplace' as const)
  }
  if (pathname.startsWith('/app/harness-')) return 'smart_app' as const
  if (pathname === '/login' || pathname === '/login/oidc') return 'login' as const
  const pluginRoute = resolveDshRoute(pathname)
  if (pluginRoute) return pluginRoute.telemetryFeature
  if (pathname.startsWith('/app/')) return 'apps' as const
  if (pathname.startsWith('/settings')) return 'settings' as const
  if (pathname.startsWith('/project-space')) return 'project_space' as const
  if (pathname === '/') return 'workbench' as const
  return 'unknown' as const
}
```

在 `AppRoutes` 使用完整位置，并让 effect 对 search 响应：

```ts
const { pathname: path, search } = useCurrentLocation()

useEffect(() => {
  track('feature_opened', {
    feature: isPopoutWindow ? 'popout' : telemetryFeatureForLocation(path, search),
  })
}, [isPopoutWindow, path, search, telemetryEnabled])
```

特例必须在 `resolveDshRoute(pathname)` 与通用 `/app/` 判断之前，且不要在
`SmartAppsMarketplacePage`、启动逻辑或运行工作台页面再额外调用
`track('feature_opened')`。

- [ ] **Step 4: 运行路由测试，确认市场、我的工作台、具体工作台和既有路由都正确。**

Run:

```bash
pnpm --filter wework test src/App.plugins.test.tsx
```

Expected: 新增映射与 query string 更新测试通过，既有插件和应用路由测试无回归。

- [ ] **Step 5: 提交路由 telemetry 变更。**

```bash
git add wework/src/App.tsx wework/src/App.plugins.test.tsx
git commit -m "feat(wework): track smart app entry routes"
```

### Task 3: 在安装事实点记录成功与失败

**Files:**
- Modify: `wework/dsh/ui-applications/src/SmartAppsMarketplacePage.tsx:1-95,467-535,655-710`
- Modify: `wework/dsh/ui-applications/src/SmartAppsMarketplacePage.test.tsx:1-210,253-280`

- [ ] **Step 1: 为页面测试准备 telemetry、安装 API、ZIP 预览和文件选择器 mock。**

在现有测试文件顶部添加以下 mock 函数，并使 `harnessAppsApi` mock 委托给它们：

```ts
const trackMock = vi.hoisted(() => vi.fn())
const installPackage = vi.fn()
const previewPackage = vi.fn()
const invokeDesktopHost = vi.fn()

vi.mock('@/telemetry/client', () => ({ track: trackMock }))
vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: (...args: unknown[]) => invokeDesktopHost(...args),
}))
```

将 `harnessAppsApi` mock 的安装相关成员改为：

```ts
preview: (path: string) => previewPackage(path),
install: (...args: unknown[]) => installPackage(...args),
```

在 `beforeEach` 重置 `trackMock`、`installPackage`、`previewPackage` 和
`invokeDesktopHost`。给 `useWorkbench` mock 提供一个与
`useHarnessAppManagement.test.tsx` 相同形状的本地 `UnifiedModel`：

```ts
{
  name: 'local-model:model-1',
  type: 'runtime',
  provider: 'local',
  displayName: 'Local Model',
  modelId: 'local-upstream',
  config: { weworkModelKind: 'model-interface' },
}
```

这确保市场下载后可点击现有的
`[data-testid="harness-app-install-confirm"]`，不需要为 telemetry 改动 UI 或
绕过模型选择。

- [ ] **Step 2: 写出市场首次安装、更新、ZIP 导入和失败分支的失败测试。**

新增以下八个测试，所有成功测试都要在安装 API resolve 前断言 `trackMock` 未被
调用，并在 API 返回后使用 `waitFor` 断言恰好一次对应事件：

```ts
test('tracks a marketplace installation only after the installation succeeds', async () => {
  installPackage.mockResolvedValue({ ...importedInstallation, smartAppId: 7, releaseId: 17 })
  render(<SmartAppsMarketplacePage api={api()} />)

  fireEvent.click(await screen.findByTestId('smart-app-marketplace-install-7'))
  await screen.findByTestId('harness-app-install-confirm')
  expect(trackMock).not.toHaveBeenCalled()
  fireEvent.click(screen.getByTestId('harness-app-install-confirm'))

  await waitFor(() =>
    expect(trackMock).toHaveBeenCalledWith('smart_app_installed', {
      install_source: 'marketplace',
    })
  )
  expect(trackMock).toHaveBeenCalledTimes(1)
})

test('tracks a marketplace update without counting it as an installation', async () => {
  listInstalled.mockResolvedValue([
    { ...importedInstallation, id: 'market-7', smartAppId: 7, releaseId: 16, modelKey: 'model-a' },
  ])
  installPackage.mockResolvedValue({ ...importedInstallation, id: 'market-7', smartAppId: 7, releaseId: 17 })
  render(<SmartAppsMarketplacePage api={api()} />)

  fireEvent.click(await screen.findByTestId('smart-app-marketplace-install-7'))
  fireEvent.click(await screen.findByTestId('harness-app-install-confirm'))

  await waitFor(() =>
    expect(trackMock).toHaveBeenCalledWith('feature_action_completed', {
      domain: 'smart_app',
      action: 'update',
    })
  )
  expect(trackMock).not.toHaveBeenCalledWith('smart_app_installed', expect.anything())
})
```

ZIP 成功测试使用现有导入按钮和真实的组件流程：

```ts
invokeDesktopHost.mockResolvedValue({ canceled: false, filePaths: ['/tmp/private-workbench.zip'] })
previewPackage.mockResolvedValue({
  valid: true,
  archivePath: '/tmp/private-workbench.zip',
  sha256: 'a'.repeat(64),
  manifest: importedInstallation.manifest,
  issues: [],
})
installPackage.mockResolvedValue(importedInstallation)

render(<SmartAppsMarketplacePage api={api([])} mode="owned" />)
fireEvent.click(await screen.findByTestId('smart-apps-import-button'))

await waitFor(() =>
  expect(trackMock).toHaveBeenCalledWith('smart_app_installed', {
    install_source: 'zip_import',
  })
)
expect(trackMock.mock.calls.flat()).not.toContain('/tmp/private-workbench.zip')
```

添加四个对应失败测试并使用下列精确断言：

```ts
expect(trackMock).toHaveBeenCalledWith('operation_failed', {
  operation: 'smart_app_marketplace_download',
})
expect(trackMock).toHaveBeenCalledWith('operation_failed', {
  operation: 'smart_app_marketplace_install',
})
expect(trackMock).toHaveBeenCalledWith('operation_failed', {
  operation: 'smart_app_marketplace_update',
})
expect(trackMock).toHaveBeenCalledWith('operation_failed', {
  operation: 'smart_app_zip_import',
})
expect(trackMock).not.toHaveBeenCalledWith('smart_app_installed', expect.anything())
```

分别令 `api().getDownload` reject、市场首次安装 `installPackage` reject、旧
release 的市场更新 `installPackage` reject、以及 `previewPackage` 返回
`{ valid: false, manifest: null, issues: ['private validation detail'] }`。最后为
文件选择器 `{ canceled: true, filePaths: [] }` 添加一个断言，确认不发送任何
成功或失败 telemetry。

- [ ] **Step 3: 运行组件测试，确认所有新增行为尚未上报。**

Run:

```bash
pnpm --filter wework test dsh/ui-applications/src/SmartAppsMarketplacePage.test.tsx
```

Expected: 新增测试失败，因为页面尚未导入或调用 telemetry `track()`。

- [ ] **Step 4: 在真实业务成功和失败边界调用 `track()`。**

在 `SmartAppsMarketplacePage.tsx` 导入：

```ts
import { track } from '@/telemetry/client'
```

扩展 `PendingInstall`，使市场下载时固定当前意图，而不是以后依赖卡片文案或
刷新后的版本数据推断：

```ts
interface PendingInstall {
  item: SmartAppMarketplaceItem
  preview: HarnessAppPreview
  intent: 'install' | 'update'
}
```

在 `download(item)` 的下载开始前读取 `localState(item)?.update`，并保存：

```ts
const intent = localState(item)?.update ? 'update' : 'install'
// 成功下载后：
setPendingInstall({ item, preview, intent })
```

在下载 catch 的开头记录公共下载失败，再保留既有错误展示：

```ts
track('operation_failed', { operation: 'smart_app_marketplace_download' })
```

在市场 `install()` 中，`harnessAppsApi.install(...)` 成功返回并已经调用
`notifyHarnessAppInstallationsChanged(...)` 后、清理 dialog 与 `await refresh()`
前，按已保存的 `pendingInstall.intent` 记录一次成功：

```ts
if (pendingInstall.intent === 'update') {
  track('feature_action_completed', { domain: 'smart_app', action: 'update' })
} else {
  track('smart_app_installed', { install_source: 'marketplace' })
}
```

在同一 `install()` catch 的开头按该意图记录一次失败：

```ts
track('operation_failed', {
  operation:
    pendingInstall.intent === 'update'
      ? 'smart_app_marketplace_update'
      : 'smart_app_marketplace_install',
})
```

在 `importCreatedPackage(path)` 中，`preview` 校验和 `harnessAppsApi.install`
都成功且已发出安装变化通知后，记录：

```ts
track('smart_app_installed', { install_source: 'zip_import' })
```

该函数的 catch 开头记录：

```ts
track('operation_failed', { operation: 'smart_app_zip_import' })
```

不要在点击下载/导入按钮、打开文件选择器、`download()` 成功、停止运行中工作台
被用户取消、ZIP 对话框取消、`refresh()` 或 UI 提示逻辑中补发成功事件。拖放
ZIP 复用 `importCreatedPackage()`，因此自动复用同一事件与失败边界。

- [ ] **Step 5: 运行组件测试，确认每条路径只发送正确事件。**

Run:

```bash
pnpm --filter wework test dsh/ui-applications/src/SmartAppsMarketplacePage.test.tsx
```

Expected: 市场首次安装、市场更新、ZIP 导入各只发送一次指定成功事件；每个失败
分支只发送自己的 `operation_failed`；取消不发送事件。

- [ ] **Step 6: 提交市场安装 telemetry 变更。**

```bash
git add wework/dsh/ui-applications/src/SmartAppsMarketplacePage.tsx \
  wework/dsh/ui-applications/src/SmartAppsMarketplacePage.test.tsx
git commit -m "feat(wework): track smart app installation outcomes"
```

### Task 4: 运行完整验证并记录真实桌面证据

**Files:**
- Modify: none

- [ ] **Step 1: 运行所有受影响的单元与组件测试。**

Run:

```bash
pnpm --filter wework test \
  src/telemetry/client.test.ts \
  src/App.plugins.test.tsx \
  dsh/ui-applications/src/SmartAppsMarketplacePage.test.tsx
```

Expected: 这三个文件的所有测试通过，且 Vitest collection 只包含所列文件。

- [ ] **Step 2: 运行类型、格式与 lint 验证。**

Run:

```bash
pnpm --filter wework typecheck
pnpm --filter wework exec prettier --check \
  src/telemetry/events.ts \
  src/telemetry/client.test.ts \
  src/App.tsx \
  src/App.plugins.test.tsx \
  dsh/ui-applications/src/SmartAppsMarketplacePage.tsx \
  dsh/ui-applications/src/SmartAppsMarketplacePage.test.tsx
pnpm --filter wework exec eslint \
  src/telemetry/events.ts \
  src/telemetry/client.test.ts \
  src/App.tsx \
  src/App.plugins.test.tsx \
  dsh/ui-applications/src/SmartAppsMarketplacePage.tsx \
  dsh/ui-applications/src/SmartAppsMarketplacePage.test.tsx
git diff --check
```

Expected: 每条命令退出码为 0；没有格式、类型、lint 或空白错误。

- [ ] **Step 3: 运行 CI 已覆盖的真实市场安装回归。**

Run:

```bash
pnpm --filter wework e2e:desktop --segment harness-apps
```

Expected: 现有 `harness-apps` checkpoint 使用真实后端、市场包和本地 Harness 完成
市场安装、我的工作台、启动和 `/app/harness-*` 打开流程；不改变 10 秒普通 UI
步骤超时，也不加入重试或跳过。

- [ ] **Step 4: 在隔离 Electron 中做启动和入口回归验证。**

Run:

```bash
pnpm --filter wework ai:verify start
```

从命令输出保存 session 路径为 `SESSION_PATH`，然后运行：

```bash
pnpm --filter wework ai:verify snapshot --session "$SESSION_PATH"
pnpm --filter wework ai:verify stop --session "$SESSION_PATH"
```

Expected: 隔离 Electron 能启动并返回可读取的 WebView snapshot；无崩溃、未处理
异常或本地 runtime 启动失败。无论验证成功或失败都必须执行 `stop`，且不得打印
session 内的凭据内容。

- [ ] **Step 5: 审核最终 diff 和事件隐私边界，再提交验证结果。**

Run:

```bash
git diff origin/main...HEAD -- \
  wework/src/telemetry/events.ts \
  wework/src/telemetry/client.test.ts \
  wework/src/App.tsx \
  wework/src/App.plugins.test.tsx \
  wework/dsh/ui-applications/src/SmartAppsMarketplacePage.tsx \
  wework/dsh/ui-applications/src/SmartAppsMarketplacePage.test.tsx
git status --short
```

Expected: diff 仅包含本计划列出的 telemetry、路由和测试改动；事件属性没有 ID、
名称、路径、文件名、模型名、错误正文、用户输入或工作台内容。若验证步骤发现
问题，先新增聚焦失败测试并在同一分支修复，然后重新执行本任务的全部验证命令。
前三个任务的提交已完整覆盖所有代码与测试文件；不要使用 `--no-verify`。
