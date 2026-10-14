import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { HarnessAppAutoLauncher } from './HarnessAppAutoLauncher'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  resolveLaunch: vi.fn(),
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
  notifyInstallationsChanged: vi.fn(),
}))

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
  storeHarnessAppContextToken: mocks.storeContext,
  storeHarnessAppDecisionToken: mocks.storeDecision,
  takeHarnessAppProxyToken: mocks.takeProxy,
  takeHarnessAppContextToken: mocks.takeContext,
  takeHarnessAppDecisionToken: mocks.takeDecision,
}))

vi.mock('@/features/harness-apps/harnessAppLaunchState', () => ({
  beginHarnessAppLaunch: vi.fn(),
  clearHarnessAppLaunch: mocks.clearLaunch,
  failHarnessAppLaunch: vi.fn(),
}))

vi.mock('@/features/harness-apps/harnessAppInstallationsChanged', () => ({
  notifyHarnessAppInstallationsChanged: mocks.notifyInstallationsChanged,
}))

vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: () => true,
}))

vi.mock('@/features/local-harness/localHarnessModels', () => ({
  listLocalHarnessModelOptions: () => [{ key: 'model-1' }],
}))

vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({
    projectChat: { models: [] },
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
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset())
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
    mocks.takeContext.mockResolvedValue(null)
    mocks.takeDecision.mockResolvedValue(null)
    mocks.unregisterProxy.mockResolvedValue(undefined)
    mocks.unregisterContext.mockResolvedValue(undefined)
    mocks.unregisterDecision.mockResolvedValue(undefined)
    mocks.stop.mockResolvedValue(undefined)
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

    expect(mocks.list).toHaveBeenCalledTimes(1)
    resolveInstallations?.([installation])
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
