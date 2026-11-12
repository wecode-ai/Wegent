import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ElectronWorkbenchTabBridge } from './ElectronWorkbenchTabBridge'
import type { DesktopHostEvent } from '@/api/dsh/desktopHost'
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  closeView: vi.fn(),
  unregister: vi.fn(),
  register: vi.fn(),
  openTab: vi.fn(),
  closeTab: vi.fn(),
  updateTab: vi.fn(),
  notify: vi.fn(),
  subscribe: vi.fn(),
}))
const workspaceTabs = {
  tabs: [{ id: 'app', contentRoute: '/app/harness-app-1' }],
  closeTab: mocks.closeTab,
  updateTab: mocks.updateTab,
}
vi.mock('@/api/dsh/desktopHost', () => ({ subscribeDesktopHostEvents: mocks.subscribe }))
vi.mock('@/api/local/harnessApps', () => ({
  harnessAppsApi: { list: mocks.list, closeView: mocks.closeView },
}))
vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime: () => true }))
vi.mock('@/features/workspace-tabs/workspaceTabsContextValue', () => ({
  useWorkspaceTabs: () => workspaceTabs,
}))
vi.mock('./harnessAppTabs', () => ({
  unregisterHarnessAppTab: mocks.unregister,
  registerHarnessAppTab: mocks.register,
  openHarnessAppTab: mocks.openTab,
  harnessAppRoute: (id: string) => `/app/harness-${id}`,
}))
vi.mock('./harnessAppInstallationsChanged', () => ({
  notifyHarnessAppInstallationsChanged: mocks.notify,
}))
describe('ElectronWorkbenchTabBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    workspaceTabs.tabs = [{ id: 'app', contentRoute: '/app/harness-app-1' }]
    mocks.closeView.mockResolvedValue(undefined)
    mocks.subscribe.mockReturnValue(() => {})
  })
  test('closing a tab hides its presentation and keeps the runtime running', async () => {
    mocks.list.mockResolvedValue([
      { id: 'app-1', presentation: 'tab', state: 'running', visible: true },
    ])
    const view = render(<ElectronWorkbenchTabBridge />)
    workspaceTabs.tabs = []
    view.rerender(<ElectronWorkbenchTabBridge />)
    await waitFor(() => expect(mocks.closeView).toHaveBeenCalledWith('app-1'))
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        installation: expect.objectContaining({ state: 'running' }),
      })
    )
  })
  test('removing an old tab after switching to a window leaves the window visible', async () => {
    mocks.list.mockResolvedValue([{ id: 'app-1', presentation: 'window', visible: true }])
    const view = render(<ElectronWorkbenchTabBridge />)
    workspaceTabs.tabs = []
    view.rerender(<ElectronWorkbenchTabBridge />)
    await waitFor(() => expect(mocks.list).toHaveBeenCalled())
    expect(mocks.closeView).not.toHaveBeenCalled()
  })
  test('attaches Host-requested tabs and closes the matching presentation without repeating native close policy', async () => {
    render(<ElectronWorkbenchTabBridge />)
    const listener = mocks.subscribe.mock.calls[0][0] as (event: DesktopHostEvent) => void
    const installation = {
      id: 'app-1',
      webUrl: 'http://localhost:9000',
      manifest: { displayName: 'Calculator' },
    }
    await act(async () =>
      listener({ sequence: 1, type: 'workbench.open-tab', payload: { installation } })
    )
    expect(mocks.register).toHaveBeenCalledWith(installation)
    expect(mocks.openTab).toHaveBeenCalledWith(workspaceTabs, installation)
    await act(async () =>
      listener({ sequence: 2, type: 'workbench.close-tab', payload: { installationId: 'app-1' } })
    )
    expect(mocks.closeTab).toHaveBeenCalledWith('app')
    expect(mocks.unregister).toHaveBeenCalledWith('app-1')
    expect(mocks.closeView).not.toHaveBeenCalled()
  })
  test('coalesces an open followed by close in the same Host event batch', async () => {
    render(<ElectronWorkbenchTabBridge />)
    const listener = mocks.subscribe.mock.calls[0][0] as (event: DesktopHostEvent) => void
    await act(async () => {
      listener({
        sequence: 1,
        type: 'workbench.open-tab',
        payload: { installation: { id: 'app-2', webUrl: 'http://localhost:9000' } },
      })
      listener({ sequence: 2, type: 'workbench.close-tab', payload: { installationId: 'app-2' } })
    })
    expect(mocks.openTab).not.toHaveBeenCalled()
    expect(mocks.unregister).toHaveBeenCalledWith('app-2')
  })

  test('attaches a restored tab without selecting it over the current tab', async () => {
    render(<ElectronWorkbenchTabBridge />)
    const listener = mocks.subscribe.mock.calls[0][0] as (event: DesktopHostEvent) => void
    const installation = {
      id: 'app-1',
      webUrl: 'http://localhost:9000',
      manifest: { displayName: 'Calculator' },
    }
    await act(async () =>
      listener({
        sequence: 1,
        type: 'workbench.open-tab',
        payload: { installation, activateTab: false },
      })
    )
    expect(mocks.register).toHaveBeenCalledWith(installation)
    expect(mocks.updateTab).toHaveBeenCalledExactlyOnceWith('app', {
      title: 'Calculator',
      contentRoute: '/app/harness-app-1',
    })
    expect(mocks.openTab).not.toHaveBeenCalled()
  })

  test('does not reopen a restored tab closed before the Host attachment arrives', async () => {
    workspaceTabs.tabs = []
    render(<ElectronWorkbenchTabBridge />)
    const listener = mocks.subscribe.mock.calls[0][0] as (event: DesktopHostEvent) => void
    await act(async () =>
      listener({
        sequence: 1,
        type: 'workbench.open-tab',
        payload: {
          installation: {
            id: 'app-1',
            webUrl: 'http://localhost:9000',
            manifest: { displayName: 'Calculator' },
          },
          activateTab: false,
        },
      })
    )
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.openTab).not.toHaveBeenCalled()
    expect(mocks.updateTab).not.toHaveBeenCalled()
  })

  test('preserves explicit activation when a passive attachment shares its Host batch', async () => {
    render(<ElectronWorkbenchTabBridge />)
    const listener = mocks.subscribe.mock.calls[0][0] as (event: DesktopHostEvent) => void
    const installation = {
      id: 'app-1',
      webUrl: 'http://localhost:9000',
      manifest: { displayName: 'Calculator' },
    }
    await act(async () => {
      listener({
        sequence: 1,
        type: 'workbench.open-tab',
        payload: { installation, activateTab: true },
      })
      listener({
        sequence: 2,
        type: 'workbench.open-tab',
        payload: { installation, activateTab: false },
      })
    })
    expect(mocks.openTab).toHaveBeenCalledExactlyOnceWith(workspaceTabs, installation)
    expect(mocks.updateTab).not.toHaveBeenCalled()
  })

  test('does not let a passive attachment supersede a close in the same Host batch', async () => {
    render(<ElectronWorkbenchTabBridge />)
    const listener = mocks.subscribe.mock.calls[0][0] as (event: DesktopHostEvent) => void
    await act(async () => {
      listener({ sequence: 1, type: 'workbench.close-tab', payload: { installationId: 'app-1' } })
      listener({
        sequence: 2,
        type: 'workbench.open-tab',
        payload: {
          installation: {
            id: 'app-1',
            webUrl: 'http://localhost:9000',
            manifest: { displayName: 'Calculator' },
          },
          activateTab: false,
        },
      })
    })
    expect(mocks.closeTab).toHaveBeenCalledExactlyOnceWith('app')
    expect(mocks.register).not.toHaveBeenCalled()
    expect(mocks.openTab).not.toHaveBeenCalled()
    expect(mocks.updateTab).not.toHaveBeenCalled()
  })
  test('does not apply close policy again when the Host explicitly hides a background-disabled app', async () => {
    const view = render(<ElectronWorkbenchTabBridge />)
    const listener = mocks.subscribe.mock.calls[0][0] as (event: DesktopHostEvent) => void
    await act(async () =>
      listener({ sequence: 1, type: 'workbench.close-tab', payload: { installationId: 'app-1' } })
    )
    workspaceTabs.tabs = []
    view.rerender(<ElectronWorkbenchTabBridge />)
    expect(mocks.closeView).not.toHaveBeenCalled()
  })
  test('publishes the Host stopped state when closing a background-disabled app', async () => {
    mocks.list
      .mockResolvedValueOnce([
        { id: 'app-1', presentation: 'tab', state: 'running', background: false },
      ])
      .mockResolvedValue([
        { id: 'app-1', presentation: 'tab', state: 'installed', background: false, visible: false },
      ])
    const view = render(<ElectronWorkbenchTabBridge />)
    workspaceTabs.tabs = []
    view.rerender(<ElectronWorkbenchTabBridge />)
    await waitFor(() =>
      expect(mocks.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          installation: expect.objectContaining({ state: 'installed', visible: false }),
        })
      )
    )
  })
})
