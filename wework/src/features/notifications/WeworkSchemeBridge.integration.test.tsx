import { act, cleanup, render, screen } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { WorkspaceTabsProvider } from '@/features/workspace-tabs/WorkspaceTabsContext'
import { useWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import type { WorkspaceTab } from '@/features/workspace-tabs/workspaceTabs'
import { WeworkSchemeBridge } from './WeworkSchemeBridge'
import { openWeworkScheme } from './schemeEvents'
import {
  CloudConnectionContext,
  type CloudConnectionContextValue,
} from '@/features/cloud-connection/CloudConnectionContext'

vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime: () => false }))

function TabsProbe() {
  const { tabs, activeTab } = useWorkspaceTabs()
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
  useEffect(() => {
    const updateLocation = () =>
      setLocation({ pathname: window.location.pathname, search: window.location.search })
    window.addEventListener('popstate', updateLocation)
    return () => window.removeEventListener('popstate', updateLocation)
  }, [])
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
      <WeworkSchemeBridge />
      <TabsProbe />
    </WorkspaceTabsProvider>
  )
}

beforeEach(() => {
  localStorage.clear()
  window.history.replaceState({}, '', '/todo')
})
afterEach(cleanup)

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
