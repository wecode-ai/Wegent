import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { HarnessAppAutoLauncher } from './HarnessAppAutoLauncher'
import { captureHarnessAppLaunchDiagnostics } from '@/e2e/harness-app-launch-diagnostics'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  resolveLaunch: vi.fn(),
  listModelOptions: vi.fn(),
  storeAdditionalProxies: vi.fn(),
  takeAdditionalProxies: vi.fn(),
  resolveDecisionLaunch: vi.fn(),
  unregisterDecision: vi.fn(),
  decisionScope: vi.fn((installationId: string) => `smart-app:${installationId}:uuid`),
  register: vi.fn(),
  storeProxy: vi.fn(),
  storeContext: vi.fn(),
  storeDecision: vi.fn(),
  unregisterProxy: vi.fn(),
  unregisterContext: vi.fn(),
  takeProxy: vi.fn(),
  takeContext: vi.fn(),
  takeDecision: vi.fn(),
  clearLaunch: vi.fn(),
  failLaunch: vi.fn(),
  notifyInstallationsChanged: vi.fn(),
}))

const workbenchState = vi.hoisted(() => ({ models: [] as unknown[] }))

vi.mock('@/api/local/harnessApps', () => ({
  harnessAppsApi: {
    list: mocks.list,
    start: mocks.start,
    stop: mocks.stop,
  },
}))

vi.mock('@/features/harness-apps/harnessAppTabs', () => ({
  harnessAppDecisionScope: mocks.decisionScope,
  registerHarnessAppTab: mocks.register,
  unregisterHarnessAppTab: vi.fn(),
  storeHarnessAppProxyToken: mocks.storeProxy,
  storeHarnessAppAdditionalProxyTokens: mocks.storeAdditionalProxies,
  storeHarnessAppContextToken: mocks.storeContext,
  storeHarnessAppDecisionToken: mocks.storeDecision,
  takeHarnessAppProxyToken: mocks.takeProxy,
  takeHarnessAppAdditionalProxyTokens: mocks.takeAdditionalProxies,
  takeHarnessAppContextToken: mocks.takeContext,
  takeHarnessAppDecisionToken: mocks.takeDecision,
}))

vi.mock('@/features/harness-apps/harnessAppLaunchState', () => ({
  beginHarnessAppLaunch: vi.fn(),
  clearHarnessAppLaunch: mocks.clearLaunch,
  failHarnessAppLaunch: mocks.failLaunch,
}))

vi.mock('@/features/harness-apps/harnessAppInstallationsChanged', () => ({
  notifyHarnessAppInstallationsChanged: mocks.notifyInstallationsChanged,
}))

vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: () => true,
}))

vi.mock('@/features/local-harness/localHarnessModels', () => ({
  listLocalHarnessModelOptions: mocks.listModelOptions,
}))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    projectChat: { models: workbenchState.models },
    services: {
      localDecisionRouterApi: {
        resolveLaunch: mocks.resolveDecisionLaunch,
        unregister: mocks.unregisterDecision,
      },
      localHarnessModelApi: {
        resolveLaunch: mocks.resolveLaunch,
        unregisterProxy: mocks.unregisterProxy,
        unregisterContext: mocks.unregisterContext,
      },
    },
  }),
}))

const installation = {
  id: 'app-1',
  manifest: {
    displayName: '研究工作台',
  },
  modelKey: 'model-1',
  state: 'installed',
  webUrl: null,
  grantedCapabilities: { decisionModel: false },
}

const grantedInstallation = {
  ...installation,
  grantedCapabilities: { decisionModel: true },
}

const running = {
  ...installation,
  state: 'running',
  webUrl: 'http://127.0.0.1:4173',
}

describe('HarnessAppAutoLauncher', () => {
  afterEach(() => vi.unstubAllEnvs())

  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
    workbenchState.models = []
    mocks.resolveLaunch.mockResolvedValue({
      baseUrl: 'http://127.0.0.1:9000',
      proxyToken: 'proxy-token',
      context: {
        baseUrl: 'http://127.0.0.1:9001',
        token: 'context-token',
      },
    })
    mocks.resolveDecisionLaunch.mockResolvedValue({
      token: 'decision-token',
      baseUrl: 'http://127.0.0.1:9500/v1/decision-router/decision-token',
      protocolVersion: 1,
    })
    mocks.takeProxy.mockResolvedValue(null)
    mocks.takeAdditionalProxies.mockResolvedValue([])
    mocks.listModelOptions.mockReturnValue([{ key: 'model-1', label: 'Default model' }])
    mocks.takeContext.mockResolvedValue(null)
    mocks.takeDecision.mockResolvedValue(null)
    mocks.unregisterProxy.mockResolvedValue(undefined)
    mocks.unregisterContext.mockResolvedValue(undefined)
    mocks.unregisterDecision.mockResolvedValue(undefined)
    mocks.stop.mockResolvedValue(undefined)
  })

  test('registers each available Wework model on its own route', async () => {
    mocks.listModelOptions.mockReturnValue([
      { key: 'model-1', label: 'Default model' },
      { key: 'model-2', label: 'Second model' },
    ])
    mocks.resolveLaunch
      .mockResolvedValueOnce({
        baseUrl: 'http://127.0.0.1:9000/v1/harness-router/default-token',
        proxyToken: 'default-token',
        context: { baseUrl: 'http://127.0.0.1:9001', token: 'context-token' },
      })
      .mockResolvedValueOnce({
        baseUrl: 'http://127.0.0.1:9000/v1/harness-router/second-token',
        proxyToken: 'second-token',
      })
    mocks.list.mockResolvedValue([installation])
    mocks.start.mockResolvedValue(running)

    render(<HarnessAppAutoLauncher installationId="app-1" />)

    await waitFor(() => expect(mocks.storeAdditionalProxies).toHaveBeenCalled())
    expect(mocks.resolveLaunch).toHaveBeenCalledTimes(2)
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        modelBaseUrl: 'http://127.0.0.1:9000/v1/harness-router/default-token',
        additionalModels: [
          {
            modelKey: 'model-2',
            displayName: 'Second model',
            baseUrl: 'http://127.0.0.1:9000/v1/harness-router/second-token',
          },
        ],
      })
    )
    expect(mocks.storeAdditionalProxies).toHaveBeenCalledWith('app-1', ['second-token'])
  })

  test('keeps an in-flight launch when the model catalog refreshes', async () => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    let resolveStart: (value: typeof running) => void = () => {}
    mocks.list.mockResolvedValue([installation])
    mocks.start.mockReturnValue(
      new Promise(resolve => {
        resolveStart = resolve
      })
    )

    const view = render(<HarnessAppAutoLauncher installationId="app-1" />)
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1))

    workbenchState.models = [{ name: 'model-1' }, { name: 'model-2' }]
    mocks.listModelOptions.mockReturnValue([
      { key: 'model-1', label: 'Refreshed default model' },
      { key: 'model-2', label: 'New model' },
    ])
    view.rerender(<HarnessAppAutoLauncher installationId="app-1" />)
    await Promise.resolve()
    expect(captureHarnessAppLaunchDiagnostics('app-1')?.modelLabels).toEqual([
      'Refreshed default model',
      'New model',
    ])

    resolveStart(running)
    await waitFor(() => expect(mocks.register).toHaveBeenCalledWith(running))
    expect(mocks.stop).not.toHaveBeenCalled()
    expect(mocks.notifyInstallationsChanged).toHaveBeenCalledWith({
      type: 'updated',
      installationId: 'app-1',
      installation: running,
    })
  })

  test.each(['default', 'additional', 'context', 'decision'] as const)(
    'releases every route when the tab closes during %s token storage',
    async stage => {
      mocks.listModelOptions.mockReturnValue([
        { key: 'model-1', label: 'Default model' },
        { key: 'model-2', label: 'Second model' },
      ])
      mocks.resolveLaunch
        .mockResolvedValueOnce({
          baseUrl: 'http://127.0.0.1:9000/v1/harness-router/default-token',
          proxyToken: 'default-token',
          context: { baseUrl: 'http://127.0.0.1:9001', token: 'context-token' },
        })
        .mockResolvedValueOnce({
          baseUrl: 'http://127.0.0.1:9000/v1/harness-router/second-token',
          proxyToken: 'second-token',
        })
      mocks.list.mockResolvedValue([grantedInstallation])
      mocks.start.mockResolvedValue(running)
      const stores = {
        default: mocks.storeProxy,
        additional: mocks.storeAdditionalProxies,
        context: mocks.storeContext,
        decision: mocks.storeDecision,
      }
      let releaseStore: () => void = () => {}
      stores[stage].mockReturnValue(
        new Promise<void>(resolve => {
          releaseStore = resolve
        })
      )
      const view = render(<HarnessAppAutoLauncher installationId="app-1" />)
      await waitFor(() => expect(stores[stage]).toHaveBeenCalled())

      view.unmount()
      releaseStore()
      await waitFor(() =>
        expect(
          mocks.register.mock.calls.length + mocks.unregisterProxy.mock.calls.length
        ).toBeGreaterThan(0)
      )

      expect(mocks.register).not.toHaveBeenCalled()
      expect(mocks.stop).toHaveBeenCalledWith('app-1')
      expect(mocks.unregisterProxy).toHaveBeenCalledWith('default-token')
      expect(mocks.unregisterProxy).toHaveBeenCalledWith('second-token')
      expect(mocks.unregisterContext).toHaveBeenCalledWith('context-token')
      expect(mocks.unregisterDecision).toHaveBeenCalledWith('decision-token')
    }
  )

  test('starts the reopened tab after a closed in-flight launch releases its routes', async () => {
    let releaseStart: (value: typeof running) => void = () => {}
    mocks.list.mockResolvedValue([installation])
    mocks.start
      .mockReturnValueOnce(
        new Promise(resolve => {
          releaseStart = resolve
        })
      )
      .mockResolvedValue(running)
    mocks.resolveLaunch
      .mockResolvedValueOnce({
        baseUrl: 'http://127.0.0.1:9000/v1/harness-router/old-token',
        proxyToken: 'old-token',
      })
      .mockResolvedValueOnce({
        baseUrl: 'http://127.0.0.1:9000/v1/harness-router/new-token',
        proxyToken: 'new-token',
      })
    const original = render(<HarnessAppAutoLauncher installationId="app-1" />)
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1))
    original.unmount()
    const settled = vi.fn()
    render(<HarnessAppAutoLauncher installationId="app-1" onStartupSettled={settled} />)

    releaseStart(running)
    await waitFor(() => expect(settled).toHaveBeenCalledWith('app-1'))

    expect(mocks.start).toHaveBeenCalledTimes(2)
    expect(mocks.register).toHaveBeenCalledTimes(1)
    expect(mocks.register).toHaveBeenCalledWith(running)
    expect(mocks.unregisterProxy).toHaveBeenCalledWith('old-token')
    expect(mocks.unregisterProxy).not.toHaveBeenCalledWith('new-token')
    expect(mocks.unregisterProxy.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.start.mock.invocationCallOrder[1]!
    )
  })

  test('uses the committed catalog when a reopened launch waits for old route cleanup', async () => {
    let releaseHandoff: () => void = () => {}
    let releaseCleanup: (token: null) => void = () => {}
    mocks.list.mockResolvedValue([installation])
    mocks.start.mockResolvedValue(running)
    mocks.storeProxy.mockReturnValueOnce(
      new Promise<void>(resolve => {
        releaseHandoff = resolve
      })
    )
    mocks.takeProxy.mockReturnValueOnce(
      new Promise<null>(resolve => {
        releaseCleanup = resolve
      })
    )
    mocks.resolveLaunch
      .mockResolvedValueOnce({
        baseUrl: 'http://127.0.0.1:9000/v1/harness-router/old-token',
        proxyToken: 'old-token',
      })
      .mockImplementation(async (_shell, model) => ({
        baseUrl: `http://127.0.0.1:9000/v1/harness-router/new-${model.key}`,
        proxyToken: `new-${model.key}`,
      }))
    const original = render(<HarnessAppAutoLauncher installationId="app-1" />)
    await waitFor(() => expect(mocks.storeProxy).toHaveBeenCalledTimes(1))
    original.unmount()
    releaseHandoff()
    await waitFor(() => expect(mocks.takeProxy).toHaveBeenCalledTimes(1))

    workbenchState.models = []
    mocks.listModelOptions.mockReturnValue([])
    const settled = vi.fn()
    const replacement = render(
      <HarnessAppAutoLauncher installationId="app-1" onStartupSettled={settled} />
    )
    workbenchState.models = [{ name: 'model-1' }, { name: 'model-2' }]
    mocks.listModelOptions.mockReturnValue([
      { key: 'model-1', label: 'Refreshed default' },
      { key: 'model-2', label: 'Refreshed second' },
    ])
    replacement.rerender(
      <HarnessAppAutoLauncher installationId="app-1" onStartupSettled={settled} />
    )
    expect(mocks.start).toHaveBeenCalledTimes(1)

    await act(async () => releaseCleanup(null))
    await waitFor(() => expect(settled).toHaveBeenCalledWith('app-1'))

    expect(mocks.start).toHaveBeenCalledTimes(2)
    expect(mocks.start).toHaveBeenLastCalledWith(
      expect.objectContaining({
        modelBaseUrl: 'http://127.0.0.1:9000/v1/harness-router/new-model-1',
        additionalModels: [
          {
            modelKey: 'model-2',
            displayName: 'Refreshed second',
            baseUrl: 'http://127.0.0.1:9000/v1/harness-router/new-model-2',
          },
        ],
      })
    )
    expect(mocks.register).toHaveBeenCalledTimes(1)
    expect(mocks.unregisterProxy).toHaveBeenCalledWith('old-token')
    expect(mocks.unregisterProxy).not.toHaveBeenCalledWith('new-model-1')
    expect(mocks.unregisterProxy.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.start.mock.invocationCallOrder[1]!
    )
  })

  test('rejects a configured model removed while installation lookup is pending', async () => {
    let resolveInstallations: (value: (typeof installation)[]) => void = () => {}
    mocks.list.mockReturnValue(
      new Promise(resolve => {
        resolveInstallations = resolve
      })
    )
    const settled = vi.fn()
    const view = render(
      <HarnessAppAutoLauncher installationId="app-1" onStartupSettled={settled} />
    )
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1))

    workbenchState.models = [{ name: 'model-2' }]
    mocks.listModelOptions.mockReturnValue([{ key: 'model-2', label: 'Other model' }])
    view.rerender(<HarnessAppAutoLauncher installationId="app-1" onStartupSettled={settled} />)
    await act(async () => resolveInstallations([installation]))
    await waitFor(() => expect(settled).toHaveBeenCalledWith('app-1'))

    expect(mocks.failLaunch).toHaveBeenCalledWith('app-1', expect.any(String))
    expect(mocks.resolveLaunch).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
  })

  test('keeps one catalog snapshot for default and additional registration', async () => {
    let resolveDefault: (value: { baseUrl: string; proxyToken: string }) => void = () => {}
    mocks.list.mockResolvedValue([installation])
    mocks.start.mockResolvedValue(running)
    mocks.listModelOptions.mockReturnValue([
      { key: 'model-1', label: 'Default model' },
      { key: 'model-2', label: 'Second model' },
    ])
    mocks.resolveLaunch.mockReturnValueOnce(
      new Promise(resolve => {
        resolveDefault = resolve
      })
    )
    const view = render(<HarnessAppAutoLauncher installationId="app-1" />)
    await waitFor(() => expect(mocks.resolveLaunch).toHaveBeenCalledTimes(1))

    workbenchState.models = [{ name: 'model-1' }, { name: 'model-3' }]
    mocks.listModelOptions.mockReturnValue([
      { key: 'model-1', label: 'Refreshed default' },
      { key: 'model-3', label: 'Third model' },
    ])
    view.rerender(<HarnessAppAutoLauncher installationId="app-1" />)
    await act(async () =>
      resolveDefault({ baseUrl: 'http://127.0.0.1:9000', proxyToken: 'default-token' })
    )
    await waitFor(() => expect(mocks.register).toHaveBeenCalledWith(running))

    expect(mocks.resolveLaunch).toHaveBeenCalledTimes(2)
    expect(mocks.resolveLaunch).toHaveBeenLastCalledWith(
      'opencode',
      { key: 'model-2', label: 'Second model' },
      undefined,
      false
    )
    expect(mocks.start).toHaveBeenCalledTimes(1)
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalModels: [
          { modelKey: 'model-2', displayName: 'Second model', baseUrl: 'http://127.0.0.1:9000' },
        ],
      })
    )
  })

  test.each(['takeProxy', 'takeAdditionalProxies', 'takeContext', 'takeDecision'] as const)(
    'releases locally owned routes even when %s rejects during rollback',
    async take => {
      mocks.listModelOptions.mockReturnValue([
        { key: 'model-1', label: 'Default model' },
        { key: 'model-2', label: 'Second model' },
      ])
      mocks.resolveLaunch
        .mockResolvedValueOnce({
          baseUrl: 'http://127.0.0.1:9000/v1/harness-router/default-token',
          proxyToken: 'default-token',
          context: { baseUrl: 'http://127.0.0.1:9001', token: 'context-token' },
        })
        .mockResolvedValueOnce({
          baseUrl: 'http://127.0.0.1:9000/v1/harness-router/second-token',
          proxyToken: 'second-token',
        })
      mocks.list.mockResolvedValue([grantedInstallation])
      mocks.start.mockResolvedValue({ ...running, webUrl: null })
      mocks[take].mockRejectedValueOnce(new Error('Host token read failed'))
      const settled = vi.fn()
      render(<HarnessAppAutoLauncher installationId="app-1" onStartupSettled={settled} />)
      await waitFor(() => expect(settled).toHaveBeenCalledWith('app-1'))

      expect(mocks.unregisterProxy).toHaveBeenCalledWith('default-token')
      expect(mocks.unregisterProxy).toHaveBeenCalledWith('second-token')
      expect(mocks.unregisterContext).toHaveBeenCalledWith('context-token')
      expect(mocks.unregisterDecision).toHaveBeenCalledWith('decision-token')
    }
  )

  test('keeps the default and registered models when another model is unavailable', async () => {
    mocks.listModelOptions.mockReturnValue([
      { key: 'model-1', label: 'Default model' },
      { key: 'model-2', label: 'Second model' },
      { key: 'model-3', label: 'Third model' },
    ])
    mocks.resolveLaunch
      .mockResolvedValueOnce({ baseUrl: 'http://127.0.0.1:9000', proxyToken: 'default-token' })
      .mockResolvedValueOnce({ baseUrl: 'http://127.0.0.1:9001', proxyToken: 'second-token' })
      .mockRejectedValueOnce(new Error('third model unavailable'))
    mocks.list.mockResolvedValue([installation])
    mocks.start.mockResolvedValue(running)

    render(<HarnessAppAutoLauncher installationId="app-1" />)

    await waitFor(() => expect(mocks.storeAdditionalProxies).toHaveBeenCalled())
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({
        additionalModels: [
          { modelKey: 'model-2', displayName: 'Second model', baseUrl: 'http://127.0.0.1:9001' },
        ],
      })
    )
    expect(mocks.unregisterProxy).not.toHaveBeenCalled()
  })

  test('releases all model routes when the app fails after startup', async () => {
    mocks.listModelOptions.mockReturnValue([
      { key: 'model-1', label: 'Default model' },
      { key: 'model-2', label: 'Second model' },
    ])
    mocks.resolveLaunch
      .mockResolvedValueOnce({ baseUrl: 'http://127.0.0.1:9000', proxyToken: 'default-token' })
      .mockResolvedValueOnce({ baseUrl: 'http://127.0.0.1:9001', proxyToken: 'second-token' })
    mocks.list.mockResolvedValue([installation])
    mocks.start.mockResolvedValue({ ...running, webUrl: null })

    render(<HarnessAppAutoLauncher installationId="app-1" />)

    await waitFor(() => expect(mocks.unregisterProxy).toHaveBeenCalledWith('second-token'))
    expect(mocks.stop).toHaveBeenCalledWith('app-1')
    expect(mocks.takeAdditionalProxies).toHaveBeenCalledWith('app-1')
    expect(mocks.unregisterProxy).toHaveBeenCalledWith('default-token')
  })

  test('records the failed startup stage without logging route tokens', async () => {
    mocks.listModelOptions.mockReturnValue([
      { key: 'model-1', label: 'Default model' },
      { key: 'model-2', label: 'Second model' },
    ])
    mocks.resolveLaunch
      .mockResolvedValueOnce({ baseUrl: 'http://127.0.0.1:9000', proxyToken: 'default-token' })
      .mockResolvedValueOnce({ baseUrl: 'http://127.0.0.1:9001', proxyToken: 'second-token' })
    mocks.list.mockResolvedValue([grantedInstallation])
    mocks.start.mockResolvedValue(running)
    mocks.storeAdditionalProxies.mockRejectedValue(new Error('sensitive-second-token'))
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      render(<HarnessAppAutoLauncher installationId="app-1" />)

      await waitFor(() =>
        expect(warning).toHaveBeenCalledWith(
          expect.stringMatching(/^\[Wework\] Smart app launch diagnostic /)
        )
      )
      const record = String(
        warning.mock.calls.find(([message]) =>
          String(message).startsWith('[Wework] Smart app launch diagnostic ')
        )?.[0]
      )
      expect(record).toContain('"stage":"store-additional-proxy-tokens"')
      expect(record).not.toContain('second-token')
    } finally {
      warning.mockRestore()
    }
  })

  test('starts and registers an installed Smart app when its tab opens', async () => {
    mocks.list.mockResolvedValue([installation])
    mocks.start.mockResolvedValue(running)

    render(<HarnessAppAutoLauncher installationId="app-1" />)

    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith({
        installationId: 'app-1',
        modelBaseUrl: 'http://127.0.0.1:9000',
        contextBaseUrl: 'http://127.0.0.1:9001',
        contextToken: 'context-token',
        decisionBaseUrl: null,
        decisionProtocolVersion: null,
      })
    )
    expect(mocks.resolveDecisionLaunch).not.toHaveBeenCalled()
    expect(mocks.storeDecision).not.toHaveBeenCalled()
    expect(mocks.storeProxy).toHaveBeenCalledWith('app-1', 'proxy-token')
    expect(mocks.storeContext).toHaveBeenCalledWith('app-1', 'context-token')
    expect(mocks.register).toHaveBeenCalledWith(running)
    expect(mocks.notifyInstallationsChanged).toHaveBeenCalledWith({
      type: 'updated',
      installationId: 'app-1',
      installation: running,
    })
    expect(mocks.clearLaunch).toHaveBeenCalledWith('app-1')
  })

  test('registers an already running Smart app without starting it again', async () => {
    mocks.list.mockResolvedValue([running])

    render(<HarnessAppAutoLauncher installationId="app-1" />)

    await waitFor(() => expect(mocks.register).toHaveBeenCalledWith(running))
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.resolveDecisionLaunch).not.toHaveBeenCalled()
    expect(mocks.notifyInstallationsChanged).toHaveBeenCalledWith({
      type: 'updated',
      installationId: 'app-1',
      installation: running,
    })
    expect(mocks.clearLaunch).toHaveBeenCalledWith('app-1')
  })

  test('starts an installation only once across concurrent mounts', async () => {
    let resolveInstallations: ((value: (typeof installation)[]) => void) | undefined
    const firstSettled = vi.fn()
    const secondSettled = vi.fn()
    mocks.list.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveInstallations = resolve
        })
    )
    mocks.start.mockResolvedValue(running)

    render(
      <>
        <HarnessAppAutoLauncher installationId="app-1" onStartupSettled={firstSettled} />
        <HarnessAppAutoLauncher installationId="app-1" onStartupSettled={secondSettled} />
      </>
    )

    try {
      await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(1))
    } finally {
      resolveInstallations?.([installation])
    }
    await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(firstSettled).toHaveBeenCalledWith('app-1')
      expect(secondSettled).toHaveBeenCalledWith('app-1')
    })
  })

  test('registers a decision route before starting a granted Smart app', async () => {
    mocks.list.mockResolvedValue([grantedInstallation])
    mocks.start.mockResolvedValue(running)

    render(<HarnessAppAutoLauncher installationId="app-1" />)

    await waitFor(() => expect(mocks.storeDecision).toHaveBeenCalledWith('app-1', 'decision-token'))
    expect(mocks.decisionScope).toHaveBeenCalledWith('app-1')
    expect(mocks.resolveDecisionLaunch).toHaveBeenCalledWith('smart-app:app-1:uuid')
    expect(mocks.start).toHaveBeenCalledWith({
      installationId: 'app-1',
      modelBaseUrl: 'http://127.0.0.1:9000',
      contextBaseUrl: 'http://127.0.0.1:9001',
      contextToken: 'context-token',
      decisionBaseUrl: 'http://127.0.0.1:9500/v1/decision-router/decision-token',
      decisionProtocolVersion: 1,
    })
    expect(mocks.resolveDecisionLaunch.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.start.mock.invocationCallOrder[0]!
    )
  })

  test('starts an ungranted Smart app without a decision route', async () => {
    mocks.list.mockResolvedValue([installation])
    mocks.start.mockResolvedValue(running)

    render(<HarnessAppAutoLauncher installationId="app-1" />)

    await waitFor(() => expect(mocks.start).toHaveBeenCalled())
    expect(mocks.resolveDecisionLaunch).not.toHaveBeenCalled()
    expect(mocks.storeDecision).not.toHaveBeenCalled()
  })

  test('unregisters the decision route when the app never starts', async () => {
    mocks.list.mockResolvedValue([grantedInstallation])
    mocks.start.mockRejectedValue(new Error('start failed'))

    render(<HarnessAppAutoLauncher installationId="app-1" />)

    await waitFor(() => expect(mocks.unregisterDecision).toHaveBeenCalledWith('decision-token'))
    expect(mocks.stop).not.toHaveBeenCalled()
    expect(mocks.storeDecision).not.toHaveBeenCalled()
  })

  test('stops, drops stored tokens and unregisters the route when a granted app fails after start', async () => {
    mocks.list.mockResolvedValue([grantedInstallation])
    mocks.start.mockResolvedValue({ ...running, webUrl: null })

    render(<HarnessAppAutoLauncher installationId="app-1" />)

    await waitFor(() => expect(mocks.unregisterDecision).toHaveBeenCalledWith('decision-token'))
    expect(mocks.stop).toHaveBeenCalledWith('app-1')
    expect(mocks.takeProxy).toHaveBeenCalledWith('app-1')
    expect(mocks.takeContext).toHaveBeenCalledWith('app-1')
    expect(mocks.takeDecision).toHaveBeenCalledWith('app-1')
    expect(mocks.storeDecision).not.toHaveBeenCalled()
    expect(mocks.stop.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.takeDecision.mock.invocationCallOrder[0]!
    )
    expect(mocks.takeDecision.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.unregisterDecision.mock.invocationCallOrder[0]!
    )
  })

  test('never registers a decision route when the model proxy registration fails', async () => {
    mocks.list.mockResolvedValue([grantedInstallation])
    mocks.resolveLaunch.mockRejectedValue(new Error('proxy unavailable'))

    render(<HarnessAppAutoLauncher installationId="app-1" />)

    await waitFor(() => expect(mocks.resolveLaunch).toHaveBeenCalled())
    expect(mocks.resolveDecisionLaunch).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.unregisterDecision).not.toHaveBeenCalled()
  })

  test('never starts the Smart app when the decision route registration fails', async () => {
    mocks.list.mockResolvedValue([grantedInstallation])
    mocks.resolveDecisionLaunch.mockRejectedValue(new Error('router unavailable'))

    render(<HarnessAppAutoLauncher installationId="app-1" />)

    await waitFor(() => expect(mocks.resolveDecisionLaunch).toHaveBeenCalled())
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.unregisterDecision).not.toHaveBeenCalled()
    expect(mocks.storeDecision).not.toHaveBeenCalled()
  })
})
