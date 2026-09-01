import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ElectronWorkbenchTabBridge } from './ElectronWorkbenchTabBridge'

const mocks = vi.hoisted(() => ({
  notifyInstallationsChanged: vi.fn(),
  stop: vi.fn(),
  unregister: vi.fn(),
}))

const workspaceTabs = {
  activeTabId: 'app-tab',
  tabs: [{ id: 'app-tab', contentRoute: '/app/harness-smart-app-1' }],
}

vi.mock('@/api/local/harnessApps', () => ({
  harnessAppsApi: {
    stop: mocks.stop,
  },
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

describe('ElectronWorkbenchTabBridge', () => {
  beforeEach(() => {
    mocks.notifyInstallationsChanged.mockReset()
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
    expect(mocks.notifyInstallationsChanged).toHaveBeenCalledWith({
      type: 'stopped',
      installationId: 'smart-app-1',
    })
  })
})
