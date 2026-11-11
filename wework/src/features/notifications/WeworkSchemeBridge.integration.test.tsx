import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { WorkspaceTabsProvider } from '@/features/workspace-tabs/WorkspaceTabsContext'
import { useWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import type { WorkspaceTab } from '@/features/workspace-tabs/workspaceTabs'
import type { HarnessAppInstallation } from '@/api/local/harnessApps'
import {
  openHarnessAppTab,
  registerHarnessAppTab,
  resolveRunningHarnessAppInstallation,
  unregisterHarnessAppTab,
} from '@/features/harness-apps/harnessAppTabs'
import { WeworkSchemeBridge } from './WeworkSchemeBridge'
import { openWeworkScheme } from './schemeEvents'
import { weworkInteractionScheme } from './scheme'
import {
  CloudConnectionContext,
  type CloudConnectionContextValue,
} from '@/features/cloud-connection/CloudConnectionContext'

vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime: () => false }))
const { listInstallations, openInstallation } = vi.hoisted(() => ({
  listInstallations: vi.fn(),
  openInstallation: vi.fn(),
}))
vi.mock('@/api/local/harnessApps', () => ({
  harnessAppsApi: { list: listInstallations, open: openInstallation },
}))

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

function Harness({ tabs, children }: { tabs: WorkspaceTab[]; children?: ReactNode }) {
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
      {children}
    </WorkspaceTabsProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  window.history.replaceState({}, '', '/todo')
})
afterEach(() => {
  cleanup()
  unregisterHarnessAppTab('research-local')
})

function HostOpenControls({ installation }: { installation: HarnessAppInstallation }) {
  const tabs = useWorkspaceTabs()
  return (
    <>
      <button
        data-testid="host-activate-app"
        onClick={() => {
          registerHarnessAppTab(installation)
          openHarnessAppTab(tabs, installation)
        }}
      >
        Host activation
      </button>
      <button data-testid="user-select-management" onClick={() => tabs.selectTab('management')}>
        Management
      </button>
    </>
  )
}

test('a delayed running-app deep-link response preserves real tab routing and Host registration', async () => {
  const installation: HarnessAppInstallation = {
    id: 'research-local',
    smartAppId: 42,
    manifest: {
      name: 'research',
      displayName: 'Research desk',
      description: 'Research workbench',
      version: '1.0.0',
      type: 'deepseek-harness-plugin-bundle',
      entry: { installPackage: 'packages/app', profile: 'default' },
      requirements: { dsh: '>=0.1.0', node: '>=22' },
    },
    webUrl: 'http://127.0.0.1:39000/',
    state: 'running',
    presentation: 'tab',
    packagePath: '/tmp/research',
    sha256: 'hash',
    modelKey: null,
    resident: false,
    runtimeVersion: null,
    error: null,
    source: 'market',
    grantedCapabilities: { decisionModel: false },
  }
  listInstallations.mockResolvedValue([installation])
  let completeOpen!: (value: HarnessAppInstallation) => void
  openInstallation.mockReturnValue(
    new Promise<HarnessAppInstallation>(resolve => {
      completeOpen = resolve
    })
  )
  window.history.replaceState({}, '', '/sites')
  render(
    <Harness
      tabs={[
        {
          id: 'management',
          kind: 'auxiliary',
          title: 'Workbenches',
          contentRoute: '/sites',
          fixed: true,
        },
      ]}
    >
      <HostOpenControls installation={installation} />
    </Harness>
  )
  act(() => openWeworkScheme('wework://smart-apps/42'))
  await waitFor(() => expect(openInstallation).toHaveBeenCalledExactlyOnceWith(installation.id))
  fireEvent.click(screen.getByTestId('host-activate-app'))
  expect(screen.getByTestId('active-route')).toHaveTextContent('/app/harness-research-local')
  fireEvent.click(screen.getByTestId('user-select-management'))
  expect(screen.getByTestId('active-tab')).toHaveTextContent('management')

  await act(async () => completeOpen({ ...installation, webUrl: 'http://127.0.0.1:39001/' }))

  expect(screen.getByTestId('active-tab')).toHaveTextContent('management')
  expect(screen.getByTestId('active-route')).toHaveTextContent('/sites')
  expect(screen.getByTestId('tab-count')).toHaveTextContent('2')
  expect(new URLSearchParams(window.location.search).get('workspaceTab')).toBe('management')
  expect(resolveRunningHarnessAppInstallation('harness-research-local')).toBe(installation)
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
