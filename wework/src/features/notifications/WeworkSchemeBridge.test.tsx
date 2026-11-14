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
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'

const experimentFeature = vi.hoisted(() => ({ enabled: false, loaded: true }))
vi.mock('@/features/experimental-features/useAppPreferenceFeatureState', () => ({
  useAppPreferenceFeatureState: () => experimentFeature,
}))

const {
  openTab,
  openHarnessAppTab,
  listHarnessApps,
  invokeDesktopHost,
  isElectronRuntime,
  getDesktopWindowLabel,
  subscribeDesktopHostEvents,
} = vi.hoisted(() => ({
  openTab: vi.fn(),
  openHarnessAppTab: vi.fn(),
  listHarnessApps: vi.fn(),
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
vi.mock('@/api/local/harnessApps', () => ({
  harnessAppsApi: { list: listHarnessApps },
}))
vi.mock('@/features/harness-apps/harnessAppTabs', () => ({
  openHarnessAppTab,
}))

beforeEach(() => {
  vi.clearAllMocks()
  isElectronRuntime.mockReturnValue(false)
  getDesktopWindowLabel.mockReturnValue('main')
  listHarnessApps.mockResolvedValue([])
  workspaceTabs.tabs = []
  workspaceTabs.activeTabId = ''
  workspaceTabs.openTab = openTab
  experimentFeature.enabled = false
  experimentFeature.loaded = true
})
afterEach(cleanup)

describe('Wework scheme bridge', () => {
  it('keeps existing project notifications on the original board when the experiment is disabled', () => {
    workspaceTabs.tabs = [
      {
        id: 'fixed-collaboration-exp',
        kind: 'auxiliary',
        title: '协作 exp',
        contentRoute: '/collaboration-exp?projectId=old',
        fixed: true,
      },
    ]
    render(<WeworkSchemeBridge />)
    act(() => openWeworkScheme('wework://boards/local/local-project/issues/OFF-1'))
    expect(openTab).toHaveBeenCalledExactlyOnceWith('board', {
      contentRoute: expect.stringMatching(
        /^\/todo\?projectStore=local&projectId=local-project&itemId=OFF-1&focusRequest=/
      ),
    })
    expect(workspaceTabs.selectTab).not.toHaveBeenCalled()
  })

  it('reuses an already open experiment for existing project notifications and retains its view scope', () => {
    experimentFeature.enabled = true
    workspaceTabs.tabs = [
      {
        id: 'fixed-collaboration-exp',
        kind: 'auxiliary',
        title: '协作 exp',
        contentRoute:
          '/collaboration-exp?view=tasks&projectStore=local&projectId=old&issueId=old&nodeId=old&discussion=private&inspector=details&timelineFilter=attachments&projectView=plan&assistantDeviceId=device&assistantTaskId=task&search=release&status=in_progress&relevance=all&future=keep',
        fixed: true,
      },
    ]
    render(<WeworkSchemeBridge />)
    act(() => {
      openWeworkScheme('wework://boards/local/local-project/issues/OFF-1/comments/comment-1')
      openWeworkScheme('wework://boards/local/other-project/issues/OFF-2')
    })
    expect(openTab).not.toHaveBeenCalled()
    expect(workspaceTabs.selectTab).toHaveBeenCalledTimes(2)
    for (const [index, projectId, issueId] of [
      [0, 'local-project', 'OFF-1'],
      [1, 'other-project', 'OFF-2'],
    ] as const) {
      const [tabId, updates] = workspaceTabs.selectTab.mock.calls[index]
      expect(tabId).toBe('fixed-collaboration-exp')
      const params = new URL(updates.contentRoute, 'https://local').searchParams
      expect(Object.fromEntries(params)).toMatchObject({
        view: 'tasks',
        projectStore: 'local',
        projectId,
        issueId,
        search: 'release',
        status: 'in_progress',
        relevance: 'all',
        future: 'keep',
      })
      expect(params.has('nodeId')).toBe(false)
      expect(params.has('discussion')).toBe(false)
      for (const key of [
        'inspector',
        'timelineFilter',
        'projectView',
        'assistantDeviceId',
        'assistantTaskId',
      ])
        expect(params.has(key)).toBe(false)
    }
  })

  it('leaves legacy notifications on /todo until an experiment tab has been opened', () => {
    experimentFeature.enabled = true
    render(<WeworkSchemeBridge />)
    act(() => openWeworkScheme('wework://boards/local/local-project/issues/OFF-1'))
    expect(openTab).toHaveBeenCalledExactlyOnceWith('board', {
      contentRoute: expect.stringMatching(/^\/todo\?/),
    })
  })

  it('ignores explicit experiment schemes while disabled and reuses the experiment after enabling', () => {
    const { rerender } = render(<WeworkSchemeBridge />)
    act(() =>
      openWeworkScheme('wework://collaboration-exp?projectStore=local&projectId=one&issueId=first')
    )
    expect(openTab).not.toHaveBeenCalled()
    experimentFeature.enabled = true
    workspaceTabs.tabs = [
      {
        id: 'fixed-collaboration-exp',
        kind: 'auxiliary',
        title: '协作 exp',
        contentRoute: '/collaboration-exp?projectId=old',
        fixed: true,
      },
    ]
    rerender(<WeworkSchemeBridge />)
    act(() =>
      openWeworkScheme('wework://collaboration-exp?projectStore=local&projectId=two&issueId=second')
    )
    expect(workspaceTabs.selectTab).toHaveBeenCalledExactlyOnceWith('fixed-collaboration-exp', {
      title: expect.any(String),
      contentRoute: expect.stringMatching(
        /^\/collaboration-exp\?projectStore=local&projectId=two&issueId=second&focusRequest=\d+-1$/
      ),
    })
    expect(openTab).not.toHaveBeenCalled()
  })

  it('gives repeated explicit experiment targets a new focus request while preserving their query', () => {
    experimentFeature.enabled = true
    render(<WeworkSchemeBridge />)
    const params = new URLSearchParams({
      projectStore: 'local',
      projectId: 'one',
      issueId: 'first',
      nodeId: 'canonical-node',
      projectScope: JSON.stringify(['local', 'other']),
      search: 'release',
      future: 'keep',
      focusRequest: 'old-token',
    })
    act(() => {
      openWeworkScheme(`wework://collaboration-exp?${params}`)
      openWeworkScheme(`wework://collaboration-exp?${params}`)
    })
    expect(openTab).toHaveBeenCalledTimes(2)
    const tokens = new Set<string>()
    for (const [, updates] of openTab.mock.calls) {
      const actual = new URL(updates.contentRoute, 'https://local').searchParams
      tokens.add(actual.get('focusRequest')!)
      actual.delete('focusRequest')
      const expected = new URLSearchParams(params)
      expected.delete('focusRequest')
      expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(expected))
    }
    expect(tokens.size).toBe(2)
    expect(tokens.has('old-token')).toBe(false)
  })
  it('opens a local assignment even when cloud authentication is unavailable', () => {
    render(<WeworkSchemeBridge />)
    act(() => {
      openWeworkScheme('wework://boards/local/local-project-1/issues/OFF-1')
    })
    expect(openTab).toHaveBeenCalledExactlyOnceWith('board', {
      contentRoute: expect.stringMatching(
        /^\/todo\?projectStore=local&projectId=local-project-1&itemId=OFF-1&focusRequest=\d+-1$/
      ),
    })
  })

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
        contentRoute: `${contentRoute}&focusRequest=previous-request`,
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
      const key = route.searchParams.get('focusRequest')
      expect(key).toBeTruthy()
      expect(key).not.toBe('previous-request')
      route.searchParams.delete('focusRequest')
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
      expect(openTab).toHaveBeenCalledOnce()
      const route = new URL(openTab.mock.calls[0][1].contentRoute, 'https://local')
      expect(route.searchParams.has('focusRequest')).toBe(kind === 'board')
      route.searchParams.delete('focusRequest')
      expect(openTab.mock.calls[0][0]).toBe(kind)
      expect(`${route.pathname}${route.search}`).toBe(contentRoute)
    }
  )

  it('opens a registered DSH app through the workspace tab navigator', async () => {
    render(
      <CloudConnectionContext.Provider
        value={{ isConnected: true, token: 'test-token' } as CloudConnectionContextValue}
      >
        <WeworkSchemeBridge />
      </CloudConnectionContext.Provider>
    )

    act(() => {
      openWeworkScheme('wework://apps/wegent')
    })

    await waitFor(() =>
      expect(openTab).toHaveBeenCalledWith('agent', { contentRoute: '/app/wegent' })
    )
  })

  it('rejects an unregistered DSH app without opening a route-shaped tab', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    render(<WeworkSchemeBridge />)

    act(() => {
      openWeworkScheme('wework://apps/harness-research-local')
    })

    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(openTab).not.toHaveBeenCalled()
    expect(openHarnessAppTab).not.toHaveBeenCalled()
  })

  it('keeps an app deep link pending until the DSH app slot loads', async () => {
    const runtime = window.__WEWORK_DSH_UI__!
    const originalGetEntries = runtime.getEntries
    const originalSubscribe = runtime.subscribe
    let notify = () => {}
    runtime.getEntries = slotName =>
      slotName === WEWORK_DSH_SLOTS.app ? [] : originalGetEntries(slotName)
    runtime.subscribe = (slotName, listener) => {
      if (slotName === WEWORK_DSH_SLOTS.app) notify = listener
      return () => {}
    }
    try {
      render(
        <CloudConnectionContext.Provider
          value={{ isConnected: true, token: 'test-token' } as CloudConnectionContextValue}
        >
          <WeworkSchemeBridge />
        </CloudConnectionContext.Provider>
      )
      act(() => {
        openWeworkScheme('wework://apps/wegent')
      })
      await waitFor(() => expect(openTab).not.toHaveBeenCalled())

      runtime.getEntries = originalGetEntries
      act(() => notify())

      await waitFor(() =>
        expect(openTab).toHaveBeenCalledWith('agent', { contentRoute: '/app/wegent' })
      )
    } finally {
      runtime.getEntries = originalGetEntries
      runtime.subscribe = originalSubscribe
    }
  })

  it('opens an installed Smart app returned by its marketplace identity', async () => {
    const installation = {
      id: 'research-local',
      smartAppId: 42,
      manifest: { displayName: 'Research desk' },
      webUrl: 'http://127.0.0.1:3000',
      state: 'running',
    }
    listHarnessApps.mockResolvedValue([installation])
    render(<WeworkSchemeBridge />)

    act(() => {
      openWeworkScheme('wework://smart-apps/42')
    })

    await waitFor(() =>
      expect(openHarnessAppTab).toHaveBeenCalledWith(expect.anything(), installation)
    )
    expect(openTab).not.toHaveBeenCalled()
  })

  it('routes a missing Smart app to the targeted installation prompt', async () => {
    render(<WeworkSchemeBridge />)

    act(() => {
      openWeworkScheme('wework://smart-apps/42')
    })

    await waitFor(() =>
      expect(openTab).toHaveBeenCalledWith('auxiliary', {
        title: '智能工作台',
        contentRoute: '/sites?app_type=smart_app&smartAppId=42',
      })
    )
    expect(openHarnessAppTab).not.toHaveBeenCalled()
  })

  it('routes a stopped Smart app through its targeted start flow', async () => {
    const installation = {
      id: 'research-local',
      smartAppId: 42,
      manifest: { displayName: 'Research desk' },
      webUrl: null,
      state: 'installed',
    }
    listHarnessApps.mockResolvedValue([installation])
    render(<WeworkSchemeBridge />)

    act(() => {
      openWeworkScheme('wework://smart-apps/42')
    })

    await waitFor(() =>
      expect(openTab).toHaveBeenCalledWith('auxiliary', {
        title: '智能工作台',
        contentRoute: '/sites?app_type=smart_app&smartAppId=42',
      })
    )
    expect(openHarnessAppTab).not.toHaveBeenCalled()
  })

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

  it('retries only acknowledgement after a native navigation acknowledgement fails', async () => {
    isElectronRuntime.mockReturnValue(true)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let requests = [
      { id: 1, url: 'wework://tasks/device-1/task-1' },
      { id: 2, url: 'wework://tasks/device-2/task-2' },
    ]
    let failedFirstAcknowledgement = false
    invokeDesktopHost.mockImplementation(async (capability: string, input?: { id?: number }) => {
      if (capability === 'navigation.pendingSchemes') return requests
      if (capability === 'navigation.acknowledgeScheme' && input?.id === 1) {
        if (!failedFirstAcknowledgement) {
          failedFirstAcknowledgement = true
          throw new Error('acknowledgement unavailable')
        }
      }
      requests = requests.filter(request => request.id !== input?.id)
      return undefined
    })
    render(<WeworkSchemeBridge />)

    await waitFor(() =>
      expect(invokeDesktopHost).toHaveBeenCalledWith('navigation.acknowledgeScheme', { id: 2 })
    )
    expect(openTab).toHaveBeenCalledTimes(2)

    const handler = subscribeDesktopHostEvents.mock.calls[0][0]
    act(() => handler({ type: 'wework-scheme-requested' }))

    await waitFor(() =>
      expect(
        invokeDesktopHost.mock.calls.filter(
          ([capability, input]) =>
            capability === 'navigation.acknowledgeScheme' && (input as { id?: number }).id === 1
        )
      ).toHaveLength(2)
    )
    expect(openTab).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalledWith(
      '[Wework] Failed to acknowledge scheme navigation',
      expect.any(Error)
    )
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
        contentRoute: expect.stringMatching(
          /^\/todo\?projectStore=backend&projectId=12&itemId=ISSUE-1&focusRequest=\d+-1$/
        ),
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
