import { act, cleanup, render, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CloudConnectionContext,
  type CloudConnectionContextValue,
} from '@/features/cloud-connection/CloudConnectionContext'
import { WeworkSchemeBridge } from './WeworkSchemeBridge'
import { openWeworkScheme } from './schemeEvents'
import type { WorkspaceTab } from '@/features/workspace-tabs/workspaceTabs'

const {
  openTab,
  invokeDesktopHost,
  isElectronRuntime,
  getDesktopWindowLabel,
  subscribeDesktopHostEvents,
} = vi.hoisted(() => ({
  openTab: vi.fn(),
  invokeDesktopHost: vi.fn(),
  isElectronRuntime: vi.fn(() => false),
  getDesktopWindowLabel: vi.fn(() => 'main'),
  subscribeDesktopHostEvents: vi
    .fn<(handler: (event: { type: string }) => void) => () => void>()
    .mockReturnValue(() => {}),
}))
const workspaceTabs = vi.hoisted(() => ({
  tabs: [] as WorkspaceTab[],
  activeTabId: '',
  openTab: vi.fn(),
  selectTab: vi.fn(),
}))
vi.mock('@/features/workspace-tabs/workspaceTabsContextValue', () => ({
  useWorkspaceTabs: () => workspaceTabs,
}))
vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime, getDesktopWindowLabel }))
vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost,
  subscribeDesktopHostEvents,
}))

beforeEach(() => {
  vi.clearAllMocks()
  isElectronRuntime.mockReturnValue(false)
  getDesktopWindowLabel.mockReturnValue('main')
  workspaceTabs.tabs = []
  workspaceTabs.activeTabId = ''
  workspaceTabs.openTab = openTab
})
afterEach(cleanup)

describe('Wework scheme bridge', () => {
  it.each(['popout-window', 'workspace-window'])(
    'leaves global native requests to the main window from %s',
    async windowLabel => {
      isElectronRuntime.mockReturnValue(true)
      getDesktopWindowLabel.mockReturnValue(windowLabel)
      invokeDesktopHost.mockResolvedValue([{ id: 1, url: 'wework://tasks/device-1/task-1' }])

      render(<WeworkSchemeBridge />)
      await act(async () => {})

      expect(invokeDesktopHost).not.toHaveBeenCalled()
      expect(subscribeDesktopHostEvents).not.toHaveBeenCalled()
      expect(openTab).not.toHaveBeenCalled()
    }
  )

  it('selects the existing conversation by device and task identity', () => {
    workspaceTabs.tabs = [
      {
        id: 'active-task',
        kind: 'task',
        title: 'Other conversation',
        contentRoute: '/runtime-tasks?deviceId=other-device&taskId=first-turn',
        fixed: false,
      },
      {
        id: 'target-task',
        kind: 'task',
        title: 'First turn',
        contentRoute: '/runtime-tasks?taskId=first-turn&deviceId=local-device',
        fixed: false,
      },
    ]
    workspaceTabs.activeTabId = 'active-task'
    render(<WeworkSchemeBridge />)

    act(() => {
      openWeworkScheme('wework://tasks/local-device/first-turn')
    })

    expect(workspaceTabs.selectTab).toHaveBeenCalledExactlyOnceWith('target-task', {
      contentRoute: '/runtime-tasks?deviceId=local-device&taskId=first-turn',
    })
    expect(openTab).not.toHaveBeenCalled()
  })

  it.each(['task', 'board'] as const)('reuses the current %s tab for a notification', kind => {
    workspaceTabs.tabs = [
      { id: 'current', kind, title: 'Current', contentRoute: '/', fixed: false },
    ]
    workspaceTabs.activeTabId = 'current'
    render(
      <CloudConnectionContext.Provider
        value={{ isConnected: true, token: 'test-token' } as CloudConnectionContextValue}
      >
        <WeworkSchemeBridge />
      </CloudConnectionContext.Provider>
    )

    act(() => {
      openWeworkScheme(
        kind === 'task' ? 'wework://tasks/local-device/first-turn' : 'wework://boards/12/issues/1'
      )
    })

    expect(workspaceTabs.selectTab).toHaveBeenCalledOnce()
    expect(workspaceTabs.selectTab.mock.calls[0][0]).toBe('current')
    expect(openTab).not.toHaveBeenCalled()
  })

  it('gives repeated comment notifications distinct focus requests on the existing board', () => {
    const contentRoute = '/todo?projectStore=backend&projectId=12&itemId=WEG-1&commentId=c-1'
    workspaceTabs.tabs = [
      { id: 'other', kind: 'board', title: 'Other', contentRoute: '/todo', fixed: true },
      {
        id: 'target',
        kind: 'board',
        title: 'Target',
        contentRoute: `${contentRoute}&commentFocusKey=previous-request`,
        fixed: false,
      },
    ]
    workspaceTabs.activeTabId = 'other'
    render(
      <CloudConnectionContext.Provider
        value={{ isConnected: true, token: 'test-token' } as CloudConnectionContextValue}
      >
        <WeworkSchemeBridge />
      </CloudConnectionContext.Provider>
    )

    act(() => {
      openWeworkScheme('wework://boards/12/issues/WEG-1/comments/c-1')
      openWeworkScheme('wework://boards/12/issues/WEG-1/comments/c-1')
    })

    expect(workspaceTabs.selectTab).toHaveBeenCalledTimes(2)
    const requests = workspaceTabs.selectTab.mock.calls.map(([tabId, updates]) => {
      expect(tabId).toBe('target')
      const route = new URL(updates.contentRoute, 'https://local')
      const key = route.searchParams.get('commentFocusKey')
      expect(key).toBeTruthy()
      expect(key).not.toBe('previous-request')
      route.searchParams.delete('commentFocusKey')
      expect(`${route.pathname}${route.search}`).toBe(contentRoute)
      return key
    })
    expect(requests[0]).not.toBe(requests[1])
    expect(openTab).not.toHaveBeenCalled()
  })

  it('reuses the fixed task tab while another app is active', () => {
    workspaceTabs.tabs = [
      { id: 'other-task', kind: 'task', title: 'Other', contentRoute: '/', fixed: false },
      { id: 'tasks', kind: 'task', title: 'Tasks', contentRoute: '/', fixed: true },
      { id: 'board', kind: 'board', title: 'Board', contentRoute: '/todo', fixed: true },
    ]
    workspaceTabs.activeTabId = 'board'
    render(<WeworkSchemeBridge />)

    act(() => {
      openWeworkScheme('wework://tasks/local-device/first-turn')
    })

    expect(workspaceTabs.selectTab).toHaveBeenCalledExactlyOnceWith('tasks', {
      contentRoute: '/runtime-tasks?deviceId=local-device&taskId=first-turn',
    })
    expect(openTab).not.toHaveBeenCalled()
  })

  it.each([
    ['wework://tasks/device-1/task-1', 'task', '/runtime-tasks?deviceId=device-1&taskId=task-1'],
    [
      'wework://boards/12/issues/gitlab%3A12%2Fissue%233',
      'board',
      '/todo?projectStore=backend&projectId=12&itemId=gitlab%3A12%2Fissue%233',
    ],
  ])(
    'opens and acknowledges a queued notification after its native click: %s',
    async (url, kind, contentRoute) => {
      isElectronRuntime.mockReturnValue(true)
      let pending: Array<{ id: number; url: string }> = []
      invokeDesktopHost.mockImplementation(async (capability: string) =>
        capability === 'navigation.pendingSchemes' ? pending : undefined
      )
      render(
        <CloudConnectionContext.Provider
          value={{ isConnected: true, token: 'test-token' } as CloudConnectionContextValue}
        >
          <WeworkSchemeBridge />
        </CloudConnectionContext.Provider>
      )
      await act(async () => {})
      expect(openTab).not.toHaveBeenCalled()
      pending = [{ id: 3, url }]
      const handler = subscribeDesktopHostEvents.mock.calls[0][0]
      act(() => handler({ type: 'wework-scheme-requested' }))

      await waitFor(() =>
        expect(invokeDesktopHost).toHaveBeenCalledWith('navigation.acknowledgeScheme', { id: 3 })
      )
      expect(openTab).toHaveBeenCalledExactlyOnceWith(kind, { contentRoute })
    }
  )

  it('acknowledges native links only after navigation, including StrictMode remounts', async () => {
    isElectronRuntime.mockReturnValue(true)
    const pending = [{ id: 1, url: 'wework://tasks/device/task' }]
    invokeDesktopHost.mockImplementation(async (capability: string) =>
      capability === 'navigation.pendingSchemes' ? pending : undefined
    )
    render(
      <StrictMode>
        <WeworkSchemeBridge />
      </StrictMode>
    )
    await waitFor(() =>
      expect(invokeDesktopHost).toHaveBeenCalledWith('navigation.acknowledgeScheme', { id: 1 })
    )
    expect(openTab).toHaveBeenCalledExactlyOnceWith('task', {
      contentRoute: '/runtime-tasks?deviceId=device&taskId=task',
    })
  })

  it('keeps native board requests unacknowledged until authentication is restored', async () => {
    isElectronRuntime.mockReturnValue(true)
    invokeDesktopHost.mockImplementation(async (capability: string) =>
      capability === 'navigation.pendingSchemes'
        ? [{ id: 2, url: 'wework://boards/12/issues/ISSUE-1' }]
        : undefined
    )
    const view = (connected: boolean) => (
      <CloudConnectionContext.Provider
        value={
          {
            status: connected ? 'connected' : 'restoring',
            isConnected: connected,
            token: connected ? 'test-token' : null,
          } as CloudConnectionContextValue
        }
      >
        <WeworkSchemeBridge />
      </CloudConnectionContext.Provider>
    )
    const rendered = render(view(false))
    await act(async () => {})
    expect(openTab).not.toHaveBeenCalled()
    expect(invokeDesktopHost).not.toHaveBeenCalledWith('navigation.acknowledgeScheme', { id: 2 })
    rendered.rerender(view(true))
    await waitFor(() =>
      expect(invokeDesktopHost).toHaveBeenCalledWith('navigation.acknowledgeScheme', { id: 2 })
    )
    expect(openTab).toHaveBeenCalledOnce()
  })

  it('retains a board link until the cloud account reconnects', async () => {
    openTab.mockClear()
    const connection = {
      status: 'restoring',
      isConnected: false,
      token: null,
    } as CloudConnectionContextValue
    const view = (value: CloudConnectionContextValue) => (
      <CloudConnectionContext.Provider value={value}>
        <WeworkSchemeBridge />
      </CloudConnectionContext.Provider>
    )
    const rendered = render(view(connection))
    act(() => {
      openWeworkScheme('wework://boards/12/issues/ISSUE-1')
    })
    expect(openTab).not.toHaveBeenCalled()
    rendered.rerender(
      view({ ...connection, status: 'connected', isConnected: true, token: 'test-token' })
    )
    await waitFor(() =>
      expect(openTab).toHaveBeenCalledWith('board', {
        contentRoute: '/todo?projectStore=backend&projectId=12&itemId=ISSUE-1',
      })
    )
    expect(openTab).toHaveBeenCalledOnce()
  })

  it('opens the board homepage without a cloud account', () => {
    render(<WeworkSchemeBridge />)
    act(() => {
      openWeworkScheme('wework://boards')
    })
    expect(openTab).toHaveBeenCalledExactlyOnceWith('board', { contentRoute: '/todo' })
  })

  it('opens local task links without a cloud account and rejects unknown routes', () => {
    openTab.mockClear()
    render(<WeworkSchemeBridge />)
    act(() => {
      openWeworkScheme('wework://tasks/local-device/task-1')
    })
    expect(openTab).toHaveBeenCalledWith('task', {
      contentRoute: '/runtime-tasks?deviceId=local-device&taskId=task-1',
    })
    expect(openWeworkScheme('wework://shell/run')).toBe(false)
    expect(openTab).toHaveBeenCalledOnce()
  })
})
