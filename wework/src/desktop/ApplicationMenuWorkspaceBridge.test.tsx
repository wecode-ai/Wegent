import { render } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ApplicationMenuWorkspaceBridge } from './ApplicationMenuWorkspaceBridge'
import { WorkspaceTabsContext } from '@/features/workspace-tabs/workspaceTabsContextValue'
import type { WorkspaceTabsContextValue } from '@/features/workspace-tabs/workspaceTabsContextValue'
import type { WorkspaceTab } from '@/features/workspace-tabs/workspaceTabs'
import type { DesktopHostEvent } from '@/api/dsh/desktopHost'

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
  invoke: vi.fn(async () => undefined),
  navigate: vi.fn(),
}))
vi.mock('@/api/dsh/desktopHost', () => ({
  subscribeDesktopHostEvents: mocks.subscribe,
  invokeDesktopHost: mocks.invoke,
}))
vi.mock('@/lib/runtime-environment', () => ({ getDesktopWindowLabel: () => 'workspace-one' }))
vi.mock('@/lib/navigation', () => ({
  navigateTo: mocks.navigate,
  isSettingsRoute: (path: string) => path === '/settings' || path.startsWith('/settings/'),
}))

function tab(overrides: Partial<WorkspaceTab> & Pick<WorkspaceTab, 'id' | 'kind'>): WorkspaceTab {
  return {
    contentRoute: '/',
    title: overrides.id,
    fixed: false,
    ...overrides,
  } as WorkspaceTab
}

function setup({
  kind = 'task',
  tabs = [tab({ id: 'active', kind: 'task' })],
  pathname = '/',
}: {
  kind?: 'task' | 'board' | 'auxiliary'
  tabs?: WorkspaceTab[]
  pathname?: string
} = {}) {
  const context = {
    activeTab: { ...tabs[0], kind },
    activeTabId: tabs[0].id,
    tabs,
    openTab: vi.fn(),
    selectTab: vi.fn(),
    closeTab: vi.fn(),
    restoreClosedTab: vi.fn(),
  } as unknown as WorkspaceTabsContextValue
  const unlisten = vi.fn()
  mocks.subscribe.mockReturnValue(unlisten)
  const view = render(
    <WorkspaceTabsContext.Provider value={context}>
      <ApplicationMenuWorkspaceBridge pathname={pathname} />
    </WorkspaceTabsContext.Provider>
  )
  const handle = mocks.subscribe.mock.calls.at(-1)![0] as (event: DesktopHostEvent) => void
  const send = (action: string, windowLabel = 'workspace-one') =>
    handle({ type: 'application-menu.action', sequence: 1, payload: { action, windowLabel } })
  const lastCapabilities = () => {
    const call = mocks.invoke.mock.calls
      .filter(([name]) => name === 'applicationMenu.setCapabilities')
      .at(-1)
    return call?.[1].capabilities as Record<string, boolean>
  }
  return { context, send, view, unlisten, lastCapabilities }
}

describe('application menu workspace actions', () => {
  beforeEach(() => vi.clearAllMocks())

  test('opens new task and project-space tabs without discarding the active tab', () => {
    const { context, send } = setup()
    send('new-task-tab')
    send('new-project-space-tab')
    expect(context.openTab).toHaveBeenCalledWith('task')
    expect(context.openTab).toHaveBeenCalledWith('board')
    expect(context.selectTab).not.toHaveBeenCalled()
  })

  test('closes the active tab through the workspace tab context', () => {
    const { context, send } = setup()
    send('close-tab')
    expect(context.closeTab).toHaveBeenCalledWith('active')
  })

  test('does not re-select the already active work tab', () => {
    const { context, send } = setup()
    send('open-tasks')
    expect(context.selectTab).not.toHaveBeenCalled()
    expect(context.openTab).not.toHaveBeenCalled()
  })

  test('selects an existing work tab of the requested kind', () => {
    const board = tab({ id: 'board-1', kind: 'board', contentRoute: '/todo' })
    const { context, send } = setup({ tabs: [tab({ id: 'active', kind: 'task' }), board] })
    send('open-project-spaces')
    expect(context.selectTab).toHaveBeenCalledWith('board-1')
    expect(context.openTab).not.toHaveBeenCalled()
  })

  test.each(['task', 'board'] as const)(
    'restores the active %s tab when settings replaces its surface',
    kind => {
      const { context, send, view } = setup({
        kind,
        tabs: [tab({ id: 'active', kind })],
      })
      view.rerender(
        <WorkspaceTabsContext.Provider value={context}>
          <ApplicationMenuWorkspaceBridge pathname="/settings/general" />
        </WorkspaceTabsContext.Provider>
      )
      send(kind === 'task' ? 'open-tasks' : 'open-project-spaces')
      expect(context.selectTab).toHaveBeenCalledExactlyOnceWith('active')
      expect(context.openTab).not.toHaveBeenCalled()
      expect(mocks.subscribe).toHaveBeenCalledOnce()
    }
  )

  test('opens a work tab when none of that kind exists yet', () => {
    const { context, send } = setup()
    send('open-project-spaces')
    expect(context.openTab).toHaveBeenCalledWith('board')
  })

  test('routes plugin, automation, and application items through navigation', () => {
    const { send } = setup()
    for (const action of ['open-plugins', 'open-automations', 'open-applications']) send(action)
    expect(mocks.navigate.mock.calls).toEqual([
      ['/plugins'],
      ['/stand-in?view=scheduled'],
      ['/sites'],
    ])
  })

  test('preserves the active identity and device when opening schedules from settings', () => {
    const original = window.location.href
    window.history.replaceState({}, '', '/stand-in?profileId=reviewer&deviceId=device-a')
    try {
      const { send } = setup({ pathname: '/stand-in' })
      send('open-automations')
      expect(mocks.navigate).toHaveBeenCalledWith(
        '/stand-in?view=scheduled&profileId=reviewer&deviceId=device-a'
      )
    } finally {
      window.history.replaceState({}, '', original)
    }
  })

  test('ignores actions addressed to another window', () => {
    const { context, send } = setup()
    send('new-task-tab', 'main')
    expect(context.openTab).not.toHaveBeenCalled()
  })

  test('keeps one host subscription while tab state changes', () => {
    // Re-subscribing during dispatch lets the same menu event reach a freshly
    // added handler, which repeated the action until the renderer hung.
    const { view } = setup()
    const initialSubscriptions = mocks.subscribe.mock.calls.length
    view.rerender(
      <WorkspaceTabsContext.Provider
        value={
          {
            activeTab: tab({ id: 'active', kind: 'task' }),
            activeTabId: 'active',
            tabs: [tab({ id: 'active', kind: 'task' }), tab({ id: 'extra', kind: 'task' })],
            openTab: vi.fn(),
            selectTab: vi.fn(),
            closeTab: vi.fn(),
            restoreClosedTab: vi.fn(),
          } as unknown as WorkspaceTabsContextValue
        }
      >
        <ApplicationMenuWorkspaceBridge pathname="/" />
      </WorkspaceTabsContext.Provider>
    )
    expect(mocks.subscribe.mock.calls.length).toBe(initialSubscriptions)
  })

  test('reports no task surface while settings replace the workspace view', () => {
    const { lastCapabilities } = setup({ pathname: '/settings' })
    expect(lastCapabilities().taskSurface).toBe(false)
  })

  test('reports the task surface for task and board tabs', () => {
    expect(setup({ kind: 'task' }).lastCapabilities().taskSurface).toBe(true)
    expect(setup({ kind: 'board' }).lastCapabilities().taskSurface).toBe(true)
    expect(setup({ kind: 'auxiliary' }).lastCapabilities().taskSurface).toBe(false)
  })

  test('does not close a fixed active tab even when another tab is closable', () => {
    const fixed = tab({ id: 'fixed', kind: 'task', fixed: true })
    const { context, send } = setup({ tabs: [fixed, tab({ id: 'open', kind: 'task' })] })
    send('close-tab')
    expect(context.closeTab).not.toHaveBeenCalled()
  })

  test('reports the active tab closability instead of any closable tab', () => {
    const fixed = tab({ id: 'fixed', kind: 'task', fixed: true })
    expect(setup({ tabs: [fixed] }).lastCapabilities().canCloseTab).toBe(false)
    expect(
      setup({ tabs: [tab({ id: 'open', kind: 'task' })] }).lastCapabilities().canCloseTab
    ).toBe(true)
    // A fixed active tab must stay non-closable, otherwise the menu item it
    // reveals would dispatch an action that the provider refuses.
    expect(
      setup({ tabs: [fixed, tab({ id: 'open', kind: 'task' })] }).lastCapabilities().canCloseTab
    ).toBe(false)
  })

  test('unsubscribes when the bridge unmounts', () => {
    const { view, unlisten } = setup()
    view.unmount()
    expect(unlisten).toHaveBeenCalledOnce()
  })
})
