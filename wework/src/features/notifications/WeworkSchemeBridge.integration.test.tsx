import { act, cleanup, render as renderView, screen } from '@testing-library/react'
import { createContext, createRef, useContext, useImperativeHandle, useState } from 'react'
import { useWindowEvent } from '@wegent/collaboration/dom-events'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { WorkspaceTabsProvider } from '@/features/workspace-tabs/WorkspaceTabsContext'
import {
  useWorkspaceTabs,
  type WorkspaceTabsContextValue,
} from '@/features/workspace-tabs/workspaceTabsContextValue'
import type { WorkspaceTab } from '@/features/workspace-tabs/workspaceTabs'
import { createWeworkSchemeService } from './weworkSchemeService'
import i18n from '@/i18n'
import { openWeworkScheme } from './schemeEvents'
import { weworkInteractionScheme } from './scheme'
import {
  CloudConnectionContext,
  type CloudConnectionContextValue,
} from '@/features/cloud-connection/CloudConnectionContext'

vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime: () => false }))

interface TabReadPort {
  tabs: WorkspaceTabsContextValue
  connection: CloudConnectionContextValue | null
}
const ReadPortContext = createContext<ReturnType<typeof createRef<TabReadPort>> | null>(null)
const releaseSchemes = new Set<() => void>()

/** Commit the real tab UI first, then arrange its native navigation owner. */
function render(ui: Parameters<typeof renderView>[0]) {
  const read = createRef<TabReadPort>()
  const view = renderView(<ReadPortContext.Provider value={read}>{ui}</ReadPortContext.Provider>)
  const service = createWeworkSchemeService()
  const observe = () => {
    if (!read.current) throw new Error('Workspace tabs did not commit their read port')
    const { tabs, connection } = read.current
    service.observe({
      tabs: {
        ...tabs,
        selectTab: (...args) => {
          tabs.selectTab(...args)
          observe()
        },
        openTab: (...args) => {
          const tab = tabs.openTab(...args)
          observe()
          return tab
        },
      },
      connection,
      experiment: { enabled: false, loaded: true },
      t: i18n.getFixedT(null, 'common'),
    })
  }
  observe()
  releaseSchemes.add(() => service.disconnect())
  return view
}

function TabsProbe() {
  const value = useWorkspaceTabs()
  const connection = useContext(CloudConnectionContext)
  const read = useContext(ReadPortContext)
  useImperativeHandle(read, () => ({ tabs: value, connection }), [value, connection])
  const { tabs, activeTab } = value
  return (
    <>
      <span data-testid="tab-count">{tabs.length}</span>
      <span data-testid="active-tab">{activeTab.id}</span>
      <span data-testid="active-route">{activeTab.contentRoute}</span>
    </>
  )
}

function Harness({ tabs }: { tabs: WorkspaceTab[] }) {
  const [location, setLocation] = useState(() => ({
    pathname: window.location.pathname,
    search: window.location.search,
  }))
  useWindowEvent('popstate', () =>
    setLocation({ pathname: window.location.pathname, search: window.location.search })
  )
  return (
    <WorkspaceTabsProvider
      {...location}
      storageScope="notification-navigation-test"
      labels={{
        task: 'Tasks',
        board: 'Boards',
        agent: 'Agent',
        auxiliary: 'Other',
        auxiliaryRoutes: {},
      }}
      fixedTabs={tabs}
      restoreSessionTabs={false}
    >
      <TabsProbe />
    </WorkspaceTabsProvider>
  )
}

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState({}, '', '/todo')
})
afterEach(() => {
  for (const release of releaseSchemes) release()
  releaseSchemes.clear()
  cleanup()
})

test('interaction deep links reuse a restored pending-route tab when the canonical tab points elsewhere', () => {
  render(
    <Harness
      tabs={[
        { id: 'boards', kind: 'board', title: 'Boards', contentRoute: '/todo', fixed: true },
        {
          id: 'pending-interactions',
          kind: 'auxiliary',
          title: 'Sites',
          contentRoute: '/sites',
          fixed: true,
        },
        {
          id: 'restored-inbox',
          kind: 'auxiliary',
          title: 'Pending',
          contentRoute: '/pending-interactions?interaction=old',
          fixed: false,
        },
      ]}
    />
  )
  act(() =>
    openWeworkScheme(weworkInteractionScheme({ deviceId: 'device', taskId: 'task' }, 'request'))
  )
  expect(screen.getByTestId('tab-count')).toHaveTextContent('3')
  expect(screen.getByTestId('active-tab')).toHaveTextContent('restored-inbox')
  expect(new URLSearchParams(window.location.search).get('interaction')).toBe(
    JSON.stringify(['device', 'task', 'request'])
  )
})

test('repeated comment notifications update real tab routing without duplicating the board', () => {
  render(
    <CloudConnectionContext.Provider
      value={{ isConnected: true, token: 'test-token' } as CloudConnectionContextValue}
    >
      <Harness
        tabs={[
          { id: 'boards', kind: 'board', title: 'Boards', contentRoute: '/todo', fixed: true },
        ]}
      />
    </CloudConnectionContext.Provider>
  )

  const open = () => {
    act(() => {
      openWeworkScheme('wework://boards/12/issues/WEG-1/comments/comment-1')
    })
    const params = new URLSearchParams(window.location.search)
    expect(params.get('projectId')).toBe('12')
    expect(params.get('itemId')).toBe('WEG-1')
    expect(params.get('commentId')).toBe('comment-1')
    expect(params.get('focusRequest')).toBeTruthy()
    expect(screen.getByTestId('active-route')).toHaveTextContent(
      `focusRequest=${params.get('focusRequest')}`
    )
    return params.get('focusRequest')
  }
  const first = open()
  const second = open()
  expect(second).not.toBe(first)
  expect(screen.getByTestId('tab-count')).toHaveTextContent('1')
  expect(screen.getByTestId('active-tab')).toHaveTextContent('boards')
})

test('repeated first-turn notifications reuse the existing task surface with real tab routing', () => {
  render(
    <Harness
      tabs={[
        { id: 'tasks', kind: 'task', title: 'Tasks', contentRoute: '/', fixed: true },
        { id: 'boards', kind: 'board', title: 'Boards', contentRoute: '/todo', fixed: true },
      ]}
    />
  )

  act(() => {
    openWeworkScheme('wework://tasks/device-1/first-turn')
    openWeworkScheme('wework://tasks/device-1/first-turn')
  })

  expect(screen.getByTestId('tab-count')).toHaveTextContent('2')
  expect(screen.getByTestId('active-tab')).toHaveTextContent('tasks')
  expect(screen.getByTestId('active-route')).toHaveTextContent(
    '/runtime-tasks?deviceId=device-1&taskId=first-turn'
  )
  expect(new URLSearchParams(window.location.search).get('workspaceTab')).toBe('tasks')
})

test('creates one task tab when absent and reuses it for subsequent notifications', () => {
  window.history.replaceState({}, '', '/app/wegent')
  render(
    <Harness
      tabs={[
        { id: 'agent', kind: 'agent', title: 'Agent', contentRoute: '/app/wegent', fixed: true },
      ]}
    />
  )

  act(() => {
    openWeworkScheme('wework://tasks/device-1/first-turn')
    openWeworkScheme('wework://tasks/device-1/first-turn')
  })
  const firstTab = screen.getByTestId('active-tab').textContent
  act(() => {
    openWeworkScheme('wework://tasks/device-1/second-task')
  })

  expect(screen.getByTestId('tab-count')).toHaveTextContent('2')
  expect(screen.getByTestId('active-tab').textContent).toBe(firstTab)
  expect(screen.getByTestId('active-route')).toHaveTextContent(
    '/runtime-tasks?deviceId=device-1&taskId=second-task'
  )
})
