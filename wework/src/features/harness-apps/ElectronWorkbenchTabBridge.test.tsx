import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ElectronWorkbenchTabBridge } from './ElectronWorkbenchTabBridge'

const mocks = vi.hoisted(() => ({
  createLocalAppServices: vi.fn(),
  notifyInstallationsChanged: vi.fn(),
  releaseRoutes: vi.fn(),
  stop: vi.fn(),
  unregister: vi.fn(),
}))

const modelApi = { unregisterProxy: vi.fn(), unregisterContext: vi.fn() }
const decisionApi = { unregister: vi.fn() }

const workspaceTabs = {
  activeTabId: 'app-tab',
  tabs: [{ id: 'app-tab', contentRoute: '/app/harness-smart-app-1' }],
}

vi.mock('@/api/local/harnessApps', () => ({
  harnessAppsApi: {
    stop: mocks.stop,
  },
}))

vi.mock('@/api/local/localServices', () => ({
  createLocalAppServices: mocks.createLocalAppServices,
}))

vi.mock('@/lib/runtime-environment', () => ({
  isElectronRuntime: () => true,
}))

vi.mock('@/features/workspace-tabs/workspaceTabsContextValue', () => ({
  useWorkspaceTabs: () => workspaceTabs,
}))

vi.mock('./harnessAppInstallationsChanged', () => ({
  notifyHarnessAppInstallationsChanged: mocks.notifyInstallationsChanged,
}))

vi.mock('./harnessAppTabs', () => ({
  unregisterHarnessAppTab: mocks.unregister,
}))

vi.mock('./harnessAppRoutes', () => ({
  releaseHarnessAppRoutes: mocks.releaseRoutes,
}))

describe('ElectronWorkbenchTabBridge', () => {
  beforeEach(() => {
    mocks.createLocalAppServices
      .mockReset()
      .mockReturnValue({ localHarnessModelApi: modelApi, localDecisionRouterApi: decisionApi })
    mocks.notifyInstallationsChanged.mockReset()
    mocks.releaseRoutes.mockReset().mockResolvedValue(undefined)
    mocks.stop.mockReset().mockResolvedValue(undefined)
    mocks.unregister.mockReset()
    workspaceTabs.activeTabId = 'app-tab'
    workspaceTabs.tabs = [{ id: 'app-tab', contentRoute: '/app/harness-smart-app-1' }]
  })

  test('publishes the stopped state after a Smart app tab closes', async () => {
    const view = render(<ElectronWorkbenchTabBridge />)

    workspaceTabs.activeTabId = 'task-tab'
    workspaceTabs.tabs = [{ id: 'task-tab', contentRoute: '/' }]
    view.rerender(<ElectronWorkbenchTabBridge />)

    await waitFor(() => expect(mocks.stop).toHaveBeenCalledWith('smart-app-1'))
    expect(mocks.unregister).toHaveBeenCalledWith('smart-app-1')
    expect(mocks.releaseRoutes).toHaveBeenCalledWith('smart-app-1', modelApi, decisionApi)
    expect(mocks.notifyInstallationsChanged).toHaveBeenCalledWith({
      type: 'stopped',
      installationId: 'smart-app-1',
    })
  })

  test('releases every route when stopping the runtime fails', async () => {
    mocks.stop.mockRejectedValueOnce(new Error('stop failed'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const view = render(<ElectronWorkbenchTabBridge />)

    workspaceTabs.activeTabId = 'task-tab'
    workspaceTabs.tabs = [{ id: 'task-tab', contentRoute: '/' }]
    view.rerender(<ElectronWorkbenchTabBridge />)

    try {
      await waitFor(() =>
        expect(mocks.releaseRoutes).toHaveBeenCalledWith('smart-app-1', modelApi, decisionApi)
      )
      expect(mocks.notifyInstallationsChanged).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
