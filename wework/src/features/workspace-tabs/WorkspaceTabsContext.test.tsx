import { act, render, screen } from '@testing-library/react'
import { useEffect, useRef, useState } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { navigateTo } from '@/lib/navigation'
import { WorkspaceTabsProvider } from './WorkspaceTabsContext'
import { useWorkspaceTabs } from './workspaceTabsContextValue'
import { WORKSPACE_TABS_CLOSED_EVENT, type WorkspaceTabsClosedEventDetail } from './workspaceTabs'

const labels = {
  task: '任务',
  board: '项目空间',
  agent: '智能体',
  auxiliary: '工作区',
  auxiliaryRoutes: {
    '/plugins': '插件',
    '/sites': '站点',
    '/automations': '已安排',
    '/cloud-work': '云端工作',
  },
}

function TabsState() {
  const { activeTab, closeTab, openTab, selectTab, tabs, updateActiveTab } = useWorkspaceTabs()
  const boardTab = tabs.find(tab => tab.kind === 'board')
  const backgroundTabIdRef = useRef<string | null>(null)
  const capturedCloseTabRef = useRef<typeof closeTab | null>(null)

  return (
    <>
      <div data-testid="tab-count">{tabs.length}</div>
      <div data-testid="active-tab-id">{activeTab.id}</div>
      <div data-testid="active-tab-kind">{activeTab.kind}</div>
      <div data-testid="active-tab-title">{activeTab.title}</div>
      <div data-testid="active-tab-route">{activeTab.contentRoute}</div>
      <div data-testid="board-tab-title">{boardTab?.title}</div>
      <div data-testid="tab-ids">{tabs.map(tab => tab.id).join(',')}</div>
      <button type="button" onClick={() => openTab('board')}>
        新建项目空间标签
      </button>
      <button type="button" onClick={() => closeTab(activeTab.id)}>
        关闭当前标签
      </button>
      <button
        type="button"
        onClick={() =>
          boardTab &&
          selectTab(boardTab.id, {
            title: 'Wegent V4',
            contentRoute: '/todo?projectId=project-1&itemId=WEG-1',
          })
        }
      >
        打开项目任务
      </button>
      <button
        type="button"
        onClick={() => updateActiveTab({ contentRoute: '/sites?app_type=smart_app' })}
      >
        打开智能工作台市场
      </button>
      <button
        type="button"
        onClick={() => {
          const tab = openTab('auxiliary', {
            title: '后台智能工作台',
            contentRoute: '/app/harness-background',
          })
          backgroundTabIdRef.current = tab.id
        }}
      >
        打开后台智能工作台
      </button>
      <button
        type="button"
        onClick={() => {
          const applicationsTab = tabs.find(tab => tab.contentRoute.startsWith('/sites?'))
          if (applicationsTab) selectTab(applicationsTab.id)
        }}
      >
        返回智能工作台列表
      </button>
      <button
        type="button"
        onClick={() => {
          capturedCloseTabRef.current = closeTab
        }}
      >
        开始异步关闭
      </button>
      <button
        type="button"
        onClick={() => {
          if (backgroundTabIdRef.current) {
            capturedCloseTabRef.current?.(backgroundTabIdRef.current)
          }
        }}
      >
        完成异步关闭
      </button>
    </>
  )
}

function RoutingHarness({
  startupTabKind,
  startupTabId,
  fixedTabs,
  restoreSessionTabs,
  labels: routingLabels = labels,
}: {
  startupTabKind?: 'task' | 'board' | 'agent'
  startupTabId?: string
  fixedTabs?: Parameters<typeof WorkspaceTabsProvider>[0]['fixedTabs']
  restoreSessionTabs?: boolean
  labels?: Parameters<typeof WorkspaceTabsProvider>[0]['labels']
} = {}) {
  const [location, setLocation] = useState(() => ({
    pathname: window.location.pathname,
    search: window.location.search,
  }))

  useEffect(() => {
    const updateLocation = () =>
      setLocation({
        pathname: window.location.pathname,
        search: window.location.search,
      })
    window.addEventListener('popstate', updateLocation)
    return () => window.removeEventListener('popstate', updateLocation)
  }, [])

  return (
    <WorkspaceTabsProvider
      pathname={location.pathname}
      search={location.search}
      storageScope="context-test"
      labels={routingLabels}
      fixedTabs={fixedTabs}
      startupTabId={startupTabId}
      startupTabKind={startupTabKind}
      restoreSessionTabs={restoreSessionTabs}
    >
      <TabsState />
    </WorkspaceTabsProvider>
  )
}

describe('WorkspaceTabsProvider routing', () => {
  beforeEach(() => {
    localStorage.clear()
    window.history.replaceState({}, '', '/')
  })

  test('ordinary navigation replaces the active tab instead of opening another tab', () => {
    render(<RoutingHarness />)
    const originalTabId = screen.getByTestId('active-tab-id').textContent

    act(() => navigateTo('/plugins'))

    expect(screen.getByTestId('tab-count')).toHaveTextContent('3')
    expect(screen.getByTestId('active-tab-id')).toHaveTextContent(originalTabId!)
    expect(screen.getByTestId('active-tab-kind')).toHaveTextContent('auxiliary')
    expect(screen.getByTestId('active-tab-title')).toHaveTextContent('插件')
    expect(screen.getByTestId('active-tab-route')).toHaveTextContent('/plugins')
  })

  test('notifies resource owners when a workspace tab closes', () => {
    const onTabsClosed = vi.fn()
    window.addEventListener(WORKSPACE_TABS_CLOSED_EVENT, onTabsClosed)
    render(<RoutingHarness />)
    const closingTabId = screen.getByTestId('active-tab-id').textContent

    act(() => screen.getByRole('button', { name: '关闭当前标签' }).click())

    expect(onTabsClosed).toHaveBeenCalledTimes(1)
    expect(
      (onTabsClosed.mock.calls[0][0] as CustomEvent<WorkspaceTabsClosedEventDetail>).detail
    ).toEqual({ tabIds: [closingTabId] })
    window.removeEventListener(WORKSPACE_TABS_CLOSED_EVENT, onTabsClosed)
  })

  test('activates the preferred tab when the main workspace starts at the root route', () => {
    render(<RoutingHarness startupTabKind="board" />)

    expect(screen.getByTestId('active-tab-kind')).toHaveTextContent('board')
    expect(screen.getByTestId('active-tab-route')).toHaveTextContent(
      '/todo?projectId=default-work-items'
    )
    expect(window.location.pathname).toBe('/todo')
    expect(window.location.search).toContain('projectId=default-work-items')
    expect(window.location.search).toContain('workspaceTab=board-')
  })

  test('keeps an explicit route instead of applying the startup tab preference', () => {
    window.history.replaceState({}, '', '/plugins')

    render(<RoutingHarness startupTabKind="board" />)

    expect(screen.getByTestId('active-tab-kind')).toHaveTextContent('auxiliary')
    expect(screen.getByTestId('active-tab-route')).toHaveTextContent('/plugins')
    expect(window.location.pathname).toBe('/plugins')
  })

  test('recreates the preferred startup tab when the persisted list no longer contains it', () => {
    localStorage.setItem(
      'wework.workspaceTabs.v3:context-test',
      JSON.stringify({
        activeTabId: 'task-1',
        tabs: [
          {
            id: 'task-1',
            kind: 'task',
            title: '任务',
            contentRoute: '/',
          },
        ],
      })
    )

    render(<RoutingHarness startupTabKind="board" />)

    expect(screen.getByTestId('tab-count')).toHaveTextContent('2')
    expect(screen.getByTestId('active-tab-kind')).toHaveTextContent('board')
    expect(screen.getByTestId('active-tab-route')).toHaveTextContent(
      '/todo?projectId=default-work-items'
    )
  })

  test('synchronizes a missing fixed startup tab before selecting it', () => {
    localStorage.setItem(
      'wework.workspaceTabs.v3:context-test',
      JSON.stringify({
        activeTabId: 'task-1',
        tabs: [
          {
            id: 'task-1',
            kind: 'task',
            title: '任务',
            contentRoute: '/',
          },
        ],
      })
    )

    render(
      <RoutingHarness
        restoreSessionTabs
        startupTabId="fixed-board"
        fixedTabs={[
          {
            id: 'fixed-task',
            kind: 'task',
            title: '任务',
            contentRoute: '/',
            fixed: true,
          },
          {
            id: 'fixed-board',
            kind: 'board',
            title: '项目空间',
            contentRoute: '/todo',
            fixed: true,
          },
        ]}
      />
    )

    expect(screen.getByTestId('active-tab-id')).toHaveTextContent('fixed-board')
    expect(screen.getByTestId('active-tab-kind')).toHaveTextContent('board')
    expect(window.location.pathname).toBe('/todo')
    expect(window.location.search).toContain('workspaceTab=fixed-board')
  })

  test('replaces bootstrap defaults when fixed tabs load after the provider mounts', () => {
    const fixedTabs = [
      {
        id: 'fixed-task',
        kind: 'task' as const,
        title: '任务',
        contentRoute: '/',
        fixed: true,
      },
      {
        id: 'fixed-board',
        kind: 'board' as const,
        title: '项目空间',
        contentRoute: '/todo',
        fixed: true,
      },
      {
        id: 'fixed-agent',
        kind: 'agent' as const,
        title: '智能体',
        contentRoute: '/app/wegent',
        fixed: true,
      },
    ]
    const { rerender } = render(<RoutingHarness fixedTabs={[]} restoreSessionTabs={false} />)

    expect(screen.getByTestId('tab-count')).toHaveTextContent('3')

    rerender(
      <RoutingHarness fixedTabs={fixedTabs} startupTabId="fixed-task" restoreSessionTabs={false} />
    )

    expect(screen.getByTestId('tab-count')).toHaveTextContent('3')
    expect(screen.getByTestId('tab-ids')).toHaveTextContent('fixed-task,fixed-board,fixed-agent')
    expect(screen.getByTestId('active-tab-id')).toHaveTextContent('fixed-task')
  })

  test('keeps the current task route when delayed fixed tabs replace bootstrap tabs', () => {
    window.history.replaceState({}, '', '/runtime-tasks?deviceId=local-device&taskId=runtime-1')
    const fixedTabs = [
      {
        id: 'fixed-task',
        kind: 'task' as const,
        title: '任务',
        contentRoute: '/',
        fixed: true,
      },
      {
        id: 'fixed-board',
        kind: 'board' as const,
        title: '项目空间',
        contentRoute: '/todo',
        fixed: true,
      },
      {
        id: 'fixed-agent',
        kind: 'agent' as const,
        title: '智能体',
        contentRoute: '/app/wegent',
        fixed: true,
      },
    ]
    const { rerender } = render(<RoutingHarness fixedTabs={[]} restoreSessionTabs={false} />)

    const bootstrapTaskId = screen.getByTestId('active-tab-id').textContent
    expect(bootstrapTaskId).toMatch(/^task-/)
    expect(screen.getByTestId('active-tab-route')).toHaveTextContent(
      '/runtime-tasks?deviceId=local-device&taskId=runtime-1'
    )

    rerender(
      <RoutingHarness fixedTabs={fixedTabs} startupTabId="fixed-task" restoreSessionTabs={false} />
    )

    expect(screen.getByTestId('tab-count')).toHaveTextContent('3')
    expect(screen.getByTestId('tab-ids')).not.toHaveTextContent(bootstrapTaskId!)
    expect(screen.getByTestId('active-tab-id')).toHaveTextContent('fixed-task')
    expect(screen.getByTestId('active-tab-route')).toHaveTextContent(
      '/runtime-tasks?deviceId=local-device&taskId=runtime-1'
    )
  })

  test('renames the persisted default board tab without changing named project tabs', () => {
    localStorage.setItem(
      'wework.workspaceTabs.v3:context-test',
      JSON.stringify({
        activeTabId: 'board-default',
        tabs: [
          {
            id: 'board-default',
            kind: 'board',
            title: '工作项',
            contentRoute: '/todo',
          },
          {
            id: 'board-project',
            kind: 'board',
            title: '产品规划',
            contentRoute: '/todo?projectId=project-1',
          },
        ],
      })
    )
    window.history.replaceState({}, '', '/todo?workspaceTab=board-default')

    render(<RoutingHarness />)

    expect(screen.getByTestId('active-tab-title')).toHaveTextContent('项目空间')
    expect(screen.getByTestId('tab-count')).toHaveTextContent('2')
  })

  test('the explicit new-tab action still opens a separate tab', () => {
    render(<RoutingHarness />)

    act(() => screen.getByRole('button', { name: '新建项目空间标签' }).click())

    expect(screen.getByTestId('tab-count')).toHaveTextContent('4')
    expect(screen.getByTestId('active-tab-kind')).toHaveTextContent('board')
    expect(window.location.search).toContain('workspaceTab=board-')
  })

  test('does not restore or persist regular tabs when session restoration is disabled', () => {
    localStorage.setItem(
      'wework.workspaceTabs.v3:context-test',
      JSON.stringify({
        activeTabId: 'old-tab',
        tabs: [
          {
            id: 'old-tab',
            kind: 'auxiliary',
            title: '旧标签',
            contentRoute: '/plugins',
            fixed: false,
          },
        ],
      })
    )

    render(<RoutingHarness restoreSessionTabs={false} />)
    act(() => screen.getByRole('button', { name: '新建项目空间标签' }).click())

    expect(screen.getByTestId('active-tab-title')).not.toHaveTextContent('旧标签')
    expect(localStorage.getItem('wework.workspaceTabs.v3:context-test')).toContain('old-tab')
  })

  test('does not persist a plugin route whose contribution disables session restoration', () => {
    const defaultRuntime = window.__WEWORK_DSH_UI__
    window.__WEWORK_DSH_UI__ = {
      getEntries: slot =>
        slot === 'wework.route'
          ? [
              {
                id: 'transient.route',
                path: '/transient-route',
                restorePolicy: 'none',
                telemetryFeature: 'apps',
              },
            ]
          : (defaultRuntime?.getEntries(slot) ?? []),
      subscribe: defaultRuntime?.subscribe ?? (() => () => {}),
      attach: defaultRuntime?.attach ?? (() => ({ update: () => {}, dispose: () => {} })),
    }

    render(<RoutingHarness />)
    act(() => navigateTo('/transient-route'))

    const persisted = JSON.parse(
      localStorage.getItem('wework.workspaceTabs.v3:context-test') ?? 'null'
    ) as { tabs?: Array<{ contentRoute?: string }> } | null
    expect(persisted?.tabs?.some(tab => tab.contentRoute === '/transient-route')).toBe(false)

    window.__WEWORK_DSH_UI__ = defaultRuntime
  })

  test('selects and updates an existing board tab for a concrete project task', () => {
    render(<RoutingHarness />)

    act(() => screen.getByRole('button', { name: '打开项目任务' }).click())

    expect(screen.getByTestId('tab-count')).toHaveTextContent('3')
    expect(screen.getByTestId('active-tab-kind')).toHaveTextContent('board')
    expect(screen.getByTestId('active-tab-title')).toHaveTextContent('Wegent V4')
    expect(screen.getByTestId('active-tab-route')).toHaveTextContent(
      '/todo?projectId=project-1&itemId=WEG-1'
    )
    expect(window.location.search).toContain('projectId=project-1')
    expect(window.location.search).toContain('itemId=WEG-1')
  })

  test('updates the active tab before broadcasting the replaced URL', () => {
    window.history.replaceState(
      {},
      '',
      '/sites?app_type=smart_app&view=owned&workspaceTab=auxiliary-apps&workspaceTabTitle=应用'
    )
    render(<RoutingHarness />)
    let routeAtPopState = ''
    const onPopState = () => {
      routeAtPopState = screen.getByTestId('active-tab-route').textContent ?? ''
    }
    window.addEventListener('popstate', onPopState)

    act(() => screen.getByRole('button', { name: '打开智能工作台市场' }).click())

    expect(routeAtPopState).toBe('/sites?app_type=smart_app')
    expect(screen.getByTestId('active-tab-id')).toHaveTextContent('auxiliary-apps')
    expect(screen.getByTestId('active-tab-title')).toHaveTextContent('应用')
    expect(screen.getByTestId('active-tab-route')).toHaveTextContent('/sites?app_type=smart_app')
    const params = new URLSearchParams(window.location.search)
    expect(params.get('app_type')).toBe('smart_app')
    expect(params.has('view')).toBe(false)
    expect(params.get('workspaceTab')).toBe('auxiliary-apps')
    expect(params.get('workspaceTabTitle')).toBe('应用')
    window.removeEventListener('popstate', onPopState)
  })

  test('does not restore a stale route when route labels change after active-tab navigation', () => {
    window.history.replaceState(
      {},
      '',
      '/sites?app_type=smart_app&view=owned&workspaceTab=auxiliary-apps&workspaceTabTitle=应用'
    )
    const { rerender } = render(<RoutingHarness />)

    act(() => screen.getByRole('button', { name: '打开智能工作台市场' }).click())
    rerender(
      <RoutingHarness
        labels={{
          ...labels,
          auxiliaryRoutes: { ...labels.auxiliaryRoutes, '/dsh/new-route': '新页面' },
        }}
      />
    )

    expect(screen.getByTestId('active-tab-route')).toHaveTextContent('/sites?app_type=smart_app')
    const params = new URLSearchParams(window.location.search)
    expect(params.get('app_type')).toBe('smart_app')
    expect(params.has('view')).toBe(false)
  })

  test('does not restore a stale route when an asynchronous tab close finishes', () => {
    window.history.replaceState(
      {},
      '',
      '/sites?app_type=smart_app&view=owned&workspaceTab=auxiliary-apps&workspaceTabTitle=应用'
    )
    render(<RoutingHarness />)

    act(() => screen.getByRole('button', { name: '打开后台智能工作台' }).click())
    act(() => screen.getByRole('button', { name: '返回智能工作台列表' }).click())
    act(() => screen.getByRole('button', { name: '开始异步关闭' }).click())
    act(() => screen.getByRole('button', { name: '打开智能工作台市场' }).click())

    expect(screen.getByTestId('active-tab-route')).toHaveTextContent('/sites?app_type=smart_app')

    act(() => screen.getByRole('button', { name: '完成异步关闭' }).click())

    expect(screen.getByTestId('active-tab-route')).toHaveTextContent('/sites?app_type=smart_app')
    const params = new URLSearchParams(window.location.search)
    expect(params.get('app_type')).toBe('smart_app')
    expect(params.has('view')).toBe(false)
  })
})
