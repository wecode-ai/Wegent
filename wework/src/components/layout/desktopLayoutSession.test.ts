// @vitest-environment jsdom

import { afterEach, expect, test, vi } from 'vitest'
import { createDesktopLayoutSession, type DesktopLayoutInput } from './desktopLayoutSession'
import { createDesktopLayoutState } from './desktopLayoutState'
import type { createWorkspaceTabsSession } from '@/features/workspace-tabs/workspaceTabsSession'

vi.mock('@/components/settings/archivedConversationsSettingsState', () => ({
  getArchivedCleanupError: () => null,
  subscribeArchivedCleanupError: () => () => undefined,
}))

vi.mock('./desktopLayoutConversations', () => ({
  createDesktopLayoutConversations: () => ({
    reconcile: vi.fn(),
    retire: vi.fn(),
  }),
}))

vi.mock('@/lib/local-terminal', () => ({
  isLocalHarnessAvailable: () => false,
  listLocalHarnessSessions: async () => [],
}))

afterEach(() => {
  window.history.replaceState({}, '', '/')
})

test('synchronizes a workspace when it remounts after an auxiliary route changed', async () => {
  window.history.replaceState({}, '', '/settings')
  const state = createDesktopLayoutState('/settings')
  const tabs = [
    {
      id: 'task-tab',
      kind: 'task' as const,
      title: '任务',
      contentRoute: '/',
      fixed: true,
    },
    {
      id: 'desktop-tab',
      kind: 'auxiliary' as const,
      title: '设备桌面',
      contentRoute: '/device-desktop?deviceId=device-1',
      fixed: false,
    },
  ]
  let activeTabId = 'task-tab'
  const tabsSession = {
    getSessionSnapshot: () => ({
      active: true,
      state: { tabs, activeTabId, closedTabs: [] },
    }),
    subscribeSession: () => () => undefined,
  } as unknown as ReturnType<typeof createWorkspaceTabsSession>
  const input = {
    routeActive: true,
    ownedRoute: '/',
    runtimeWork: undefined,
    loadTranscript: async () => null,
    workItemSurfaceOpen: false,
    sidebarCollapsed: false,
    blankPaneKey: 'blank',
    activatePane: vi.fn(),
    getImSettings: undefined,
    services: {},
  } as unknown as DesktopLayoutInput
  const session = createDesktopLayoutSession(state, 'account', tabsSession, 'task-tab')
  const observation = session.observe(input)

  const firstStop = observation.subscribe(vi.fn())
  expect(state.getSnapshot()).toMatchObject({ currentPath: '/settings', settingsOpen: true })

  // The auxiliary surface becomes active while the task workspace is hidden.
  activeTabId = 'desktop-tab'
  window.history.replaceState({}, '', '/device-desktop?deviceId=device-1')
  firstStop()
  await Promise.resolve()

  // React commits the task tab as active after the tab state changes but before its
  // route observer has processed the device-desktop URL.
  activeTabId = 'task-tab'

  const secondStop = observation.subscribe(vi.fn())
  try {
    expect(state.getSnapshot()).toMatchObject({
      currentPath: '/device-desktop',
      settingsOpen: false,
    })
  } finally {
    secondStop()
  }
})
