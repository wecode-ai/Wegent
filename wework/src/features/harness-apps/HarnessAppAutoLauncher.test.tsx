import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { HarnessAppAutoLauncher } from './HarnessAppAutoLauncher'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  resolveLaunch: vi.fn(),
  register: vi.fn(),
  storeProxy: vi.fn(),
  storeContext: vi.fn(),
  unregisterProxy: vi.fn(),
  unregisterContext: vi.fn(),
  clearLaunch: vi.fn(),
}))

vi.mock('@/api/local/harnessApps', () => ({
  harnessAppsApi: {
    list: mocks.list,
    start: mocks.start,
    stop: mocks.stop,
  },
}))

vi.mock('@/features/harness-apps/harnessAppTabs', () => ({
  registerHarnessAppTab: mocks.register,
  unregisterHarnessAppTab: vi.fn(),
  storeHarnessAppProxyToken: mocks.storeProxy,
  storeHarnessAppContextToken: mocks.storeContext,
  takeHarnessAppProxyToken: vi.fn(),
  takeHarnessAppContextToken: vi.fn(),
}))

vi.mock('@/features/harness-apps/harnessAppLaunchState', () => ({
  beginHarnessAppLaunch: vi.fn(),
  clearHarnessAppLaunch: mocks.clearLaunch,
  failHarnessAppLaunch: vi.fn(),
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
  })

  test('starts and registers an installed Smart app when its tab opens', async () => {
    mocks.list.mockResolvedValue([installation])
    const running = {
      ...installation,
      state: 'running',
      webUrl: 'http://127.0.0.1:4173',
    }
    mocks.start.mockResolvedValue(running)

    render(<HarnessAppAutoLauncher installationId="app-1" />)

    await waitFor(() =>
      expect(mocks.start).toHaveBeenCalledWith(
        'app-1',
        'http://127.0.0.1:9000',
        'http://127.0.0.1:9001',
        'context-token'
      )
    )
    expect(mocks.storeProxy).toHaveBeenCalledWith('app-1', 'proxy-token')
    expect(mocks.storeContext).toHaveBeenCalledWith('app-1', 'context-token')
    expect(mocks.register).toHaveBeenCalledWith(running)
    expect(mocks.clearLaunch).toHaveBeenCalledWith('app-1')
  })

  test('registers an already running Smart app without starting it again', async () => {
    const running = {
      ...installation,
      state: 'running',
      webUrl: 'http://127.0.0.1:4173',
    }
    mocks.list.mockResolvedValue([running])

    render(<HarnessAppAutoLauncher installationId="app-1" />)

    await waitFor(() => expect(mocks.register).toHaveBeenCalledWith(running))
    expect(mocks.start).not.toHaveBeenCalled()
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
    const running = {
      ...installation,
      state: 'running',
      webUrl: 'http://127.0.0.1:4173',
    }
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
})
