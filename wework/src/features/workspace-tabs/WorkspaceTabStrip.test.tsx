import { defaultAppPreferences, type AppPreferencesPatch } from '@/desktop/appPreferences'
import { AppPreferencesContext } from '@/features/app-preferences/appPreferencesContext'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { createInstance } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  RuntimeInteractionsContext,
  type RuntimeInteractionsValue,
} from '@/features/notifications/RuntimeInteractionsContext'
import {
  interactionQuestion,
  interactionTask,
} from '@/features/notifications/runtimeInteractions.fixtures'
import enCommon from '@/i18n/locales/en/common.json'
import zhCommon from '@/i18n/locales/zh-CN/common.json'
import { createWorkspaceTab, workspaceTabsStorageKey, type WorkspaceTabKind } from './workspaceTabs'
import { WorkspaceTabsProvider } from './WorkspaceTabsContext'
import { WorkspaceTabStrip } from './WorkspaceTabStrip'

const openWorkspaceTabWindow = vi.fn().mockResolvedValue(true)
const returnWorkspaceTabToMain = vi.fn().mockResolvedValue(undefined)
const closeEmptyWorkspaceWindow = vi.fn().mockResolvedValue(undefined)
const updateAppPreferences = vi.hoisted(() => vi.fn())
const getAppPreferences = vi.hoisted(() => vi.fn())
const experimentalFeatures = vi.hoisted(() => ({ enabled: true }))
const listHarnessApps = vi.hoisted(() => vi.fn().mockResolvedValue([]))

vi.mock('@/desktop/appPreferences', async importOriginal => {
  const actual = await importOriginal<typeof import('@/desktop/appPreferences')>()
  return {
    ...actual,
    getAppPreferences,
    updateAppPreferences: (patch: AppPreferencesPatch) => updateAppPreferences(patch),
  }
})

vi.mock('./workspaceWindow', () => ({
  WORKSPACE_TAB_RETURN_PREFIX: 'wework.workspaceTabReturn.v1:',
  returnWorkspaceTabToMain: (tab: unknown) => returnWorkspaceTabToMain(tab),
  closeEmptyWorkspaceWindow: () => closeEmptyWorkspaceWindow(),
  openWorkspaceTabWindow: (tab: unknown, options?: unknown) =>
    options === undefined ? openWorkspaceTabWindow(tab) : openWorkspaceTabWindow(tab, options),
}))

vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => experimentalFeatures.enabled,
}))

vi.mock('@/api/local/harnessApps', () => ({
  harnessAppsApi: {
    list: listHarnessApps,
  },
}))

const labels = {
  task: '任务',
  board: '协作',
  agent: '智能体',
  auxiliary: '工作区',
  auxiliaryRoutes: {
    '/pending-interactions': '待你处理',
    '/plugins': '插件',
    '/sites': '站点',
    '/automations': '已安排',
    '/cloud-work': '云端工作',
  },
}

function renderStrip(
  search = '',
  availableKinds?: ComponentProps<typeof WorkspaceTabStrip>['availableKinds'],
  pathname = '/',
  fixed = false,
  fixedBoardRoute?: string
) {
  return render(
    <AppPreferencesContext.Provider value={{ preferences: defaultAppPreferences, loaded: true }}>
      <WorkspaceTabsProvider
        pathname={pathname}
        search={search}
        storageScope="strip-test"
        labels={labels}
        fixedTabs={
          fixed
            ? (['task', 'board', 'agent'] as const).map(kind =>
                createWorkspaceTab(kind, labels, {
                  id: `fixed-${kind}`,
                  ...(kind === 'board' && fixedBoardRoute
                    ? { contentRoute: fixedBoardRoute }
                    : undefined),
                  fixed: true,
                })
              )
            : undefined
        }
        restoreSessionTabs={!fixed}
      >
        <WorkspaceTabStrip availableKinds={availableKinds} />
      </WorkspaceTabsProvider>
    </AppPreferencesContext.Provider>
  )
}

describe('WorkspaceTabStrip', () => {
  beforeEach(() => {
    localStorage.clear()
    openWorkspaceTabWindow.mockClear()
    returnWorkspaceTabToMain.mockReset().mockResolvedValue(undefined)
    closeEmptyWorkspaceWindow.mockReset().mockResolvedValue(undefined)
    updateAppPreferences.mockReset()
    getAppPreferences.mockReset().mockResolvedValue(defaultAppPreferences)
    updateAppPreferences.mockImplementation(async (patch: AppPreferencesPatch) => ({
      ...defaultAppPreferences,
      ...patch,
    }))
    experimentalFeatures.enabled = false
    listHarnessApps.mockReset()
    listHarnessApps.mockResolvedValue([])
    window.history.replaceState({}, '', '/')
    delete window.__WEWORK_DSH_UI__
    delete window.__WEWORK_RUNTIME_CONFIG__
  })

  test('opens project spaces as a real tab and switches between tabs', async () => {
    const user = userEvent.setup()
    renderStrip()

    const tablist = screen.getByTestId('workspace-tab-strip')
    const addButton = screen.getByTestId('workspace-tab-add')
    expect(screen.getByTestId('workspace-tab-strip-container')).toContainElement(addButton)
    expect(tablist).not.toContainElement(addButton)
    expect(tablist.nextElementSibling).toBe(addButton)
    expect(tablist).not.toHaveClass('max-w-[760px]')
    expect(
      within(tablist)
        .getAllByRole('tab')
        .map(tab => tab.textContent)
    ).toEqual([
      expect.stringContaining('任务'),
      expect.stringContaining('协作'),
      expect.stringContaining('智能体'),
    ])

    await user.click(screen.getByTestId('workspace-tab-add'))
    await user.click(screen.getByTestId('workspace-tab-add-board'))

    expect(within(tablist).getAllByRole('tab')).toHaveLength(4)
    const activeBoardTab = within(tablist)
      .getAllByRole('tab', { name: '协作' })
      .find(tab => tab.getAttribute('aria-selected') === 'true')
    expect(activeBoardTab).toBeDefined()
    expect(activeBoardTab?.parentElement).toHaveClass(
      'bg-surface',
      'border-border/70',
      'shadow-sm',
      'rounded-md'
    )

    await user.click(within(tablist).getByText('任务'))
    expect(within(tablist).getByText('任务').closest('[role="tab"]')).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  test('keeps fixed tabs selectable and prevents closing them', async () => {
    const user = userEvent.setup()
    renderStrip('', undefined, '/', true, '/todo')

    await user.click(screen.getByTestId('workspace-tab-select-fixed-board'))
    expect(screen.getByTestId('workspace-tab-select-fixed-board')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(window.location.pathname).toBe('/todo')
    expect(new URLSearchParams(window.location.search).get('projectId')).toBeNull()
    expect(screen.queryByTestId('workspace-tab-close-fixed-board')).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'w', metaKey: true })
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    expect(screen.getByTestId('workspace-tab-select-fixed-board')).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  test('keeps the selected project when clicking the active fixed project-space tab', async () => {
    const user = userEvent.setup()
    renderStrip(
      '?projectStore=local&projectId=project-1',
      undefined,
      '/todo',
      true,
      '/todo?projectStore=local&projectId=project-1'
    )

    await user.click(screen.getByTestId('workspace-tab-select-fixed-board'))

    expect(screen.getByTestId('workspace-tab-select-fixed-board')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(new URLSearchParams(window.location.search).get('projectStore')).toBe('local')
    expect(new URLSearchParams(window.location.search).get('projectId')).toBe('project-1')
  })

  test('keeps the selected project when returning to an inactive fixed project-space tab', async () => {
    const user = userEvent.setup()
    renderStrip('', undefined, '/', true, '/todo?projectStore=local&projectId=default-work-items')

    await user.click(screen.getByTestId('workspace-tab-select-fixed-board'))

    expect(screen.getByTestId('workspace-tab-select-fixed-board')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(new URLSearchParams(window.location.search).get('projectStore')).toBe('local')
    expect(new URLSearchParams(window.location.search).get('projectId')).toBe('default-work-items')
  })

  test('hides the project-space tab and add action when board is not available', async () => {
    const user = userEvent.setup()
    renderStrip('', ['task', 'agent', 'auxiliary'] satisfies WorkspaceTabKind[])

    const tablist = screen.getByTestId('workspace-tab-strip')
    expect(
      within(tablist)
        .getAllByRole('tab')
        .map(tab => tab.textContent)
    ).toEqual([expect.stringContaining('任务'), expect.stringContaining('智能体')])
    expect(screen.queryByRole('tab', { name: '协作' })).not.toBeInTheDocument()

    await user.click(screen.getByTestId('workspace-tab-add'))
    expect(screen.getByTestId('workspace-tab-add-menu')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-tab-add-board')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-tab-add-task')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-tab-add-agent')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-tab-add-smart-app')).toBeInTheDocument()
  })

  test('opens pending interactions without experimental features and reuses its tab', async () => {
    experimentalFeatures.enabled = false
    const user = userEvent.setup()
    renderStrip()

    await user.click(screen.getByTestId('workspace-tab-add'))
    expect(screen.getByTestId('workspace-tab-add-pending-interactions')).toHaveTextContent(
      '待你处理'
    )
    await user.click(screen.getByTestId('workspace-tab-add-pending-interactions'))

    expect(window.location.pathname).toBe('/pending-interactions')
    expect(screen.getByRole('tab', { name: '待你处理' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByTestId('workspace-tab-add-menu')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: '任务' }))
    await user.click(screen.getByTestId('workspace-tab-add'))
    await user.click(screen.getByTestId('workspace-tab-add-pending-interactions'))
    expect(screen.getAllByRole('tab', { name: '待你处理' })).toHaveLength(1)
    expect(screen.getByRole('tab', { name: '待你处理' })).toHaveAttribute('aria-selected', 'true')
  })

  test('selects the default fixed pending-interactions tab from the add menu', async () => {
    const user = userEvent.setup()
    render(
      <WorkspaceTabsProvider
        pathname="/"
        search=""
        storageScope="fixed-interactions-test"
        labels={labels}
        fixedTabs={defaultAppPreferences.fixedWorkspaceTabs.map(preference =>
          createWorkspaceTab(preference.kind as WorkspaceTabKind, labels, {
            id: preference.id,
            contentRoute: preference.contentRoute,
            fixed: true,
          })
        )}
        restoreSessionTabs={false}
      >
        <WorkspaceTabStrip />
      </WorkspaceTabsProvider>
    )

    expect(screen.getByTestId('workspace-tab-select-pending-interactions')).toHaveTextContent(
      '待你处理'
    )
    expect(screen.queryByTestId('workspace-tab-close-pending-interactions')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('workspace-tab-add'))
    await user.click(screen.getByTestId('workspace-tab-add-pending-interactions'))
    expect(window.location.pathname).toBe('/pending-interactions')
    expect(screen.getAllByRole('tab', { name: /待你处理/ })).toHaveLength(1)
    expect(screen.getByTestId('workspace-tab-select-pending-interactions')).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  test('restores the pending route when its tab has navigated to another page', async () => {
    localStorage.setItem(
      workspaceTabsStorageKey('strip-test'),
      JSON.stringify({
        activeTabId: 'pending-interactions',
        tabs: [
          {
            id: 'pending-interactions',
            kind: 'auxiliary',
            title: '站点',
            contentRoute: '/sites',
            fixed: false,
          },
        ],
      })
    )
    const user = userEvent.setup()
    renderStrip('', undefined, '/sites')
    await user.click(screen.getByTestId('workspace-tab-add'))
    await user.click(screen.getByTestId('workspace-tab-add-pending-interactions'))
    expect(window.location.pathname).toBe('/pending-interactions')
    expect(screen.getByTestId('workspace-tab-select-pending-interactions')).toHaveTextContent(
      '待你处理'
    )
    expect(screen.getAllByRole('tab')).toHaveLength(1)
  })

  test('reuses a restored pending-route tab before repurposing the canonical tab', async () => {
    localStorage.setItem(
      workspaceTabsStorageKey('strip-test'),
      JSON.stringify({
        activeTabId: 'pending-interactions',
        tabs: [
          {
            id: 'pending-interactions',
            kind: 'auxiliary',
            title: '站点',
            contentRoute: '/sites',
            fixed: false,
          },
          {
            id: 'restored-inbox',
            kind: 'auxiliary',
            title: '待你处理',
            contentRoute: '/pending-interactions?interaction=review',
            fixed: false,
          },
        ],
      })
    )
    const user = userEvent.setup()
    renderStrip('', undefined, '/sites')
    await user.click(screen.getByTestId('workspace-tab-add'))
    await user.click(screen.getByTestId('workspace-tab-add-pending-interactions'))
    expect(screen.getByTestId('workspace-tab-select-restored-inbox')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.getByTestId('workspace-tab-select-pending-interactions')).toHaveTextContent(
      '站点'
    )
    expect(screen.getAllByRole('tab')).toHaveLength(2)
  })

  test('hides pending interactions when auxiliary tabs are unavailable', async () => {
    const user = userEvent.setup()
    renderStrip('', ['task'])
    await user.click(screen.getByTestId('workspace-tab-add'))
    expect(screen.queryByTestId('workspace-tab-add-pending-interactions')).not.toBeInTheDocument()
  })

  test.each(['zh-CN', 'en'])('updates the pending count in the %s tab title', async language => {
    const i18n = createInstance()
    await i18n.init({
      lng: language,
      resources: { 'zh-CN': { common: zhCommon }, en: { common: enCommon } },
      defaultNS: 'common',
      interpolation: { escapeValue: false },
    })
    const value: RuntimeInteractionsValue = {
      pending: [],
      history: [],
      errors: {},
      drafts: {},
      replyDrafts: [],
      busy: new Set(),
      loading: false,
      setDraft: vi.fn(),
      discardDraft: vi.fn().mockResolvedValue(true),
      respond: vi.fn(),
      refresh: vi.fn(),
      open: vi.fn(),
      notice: null,
      dismissNotice: vi.fn(),
      dismiss: vi.fn(),
      registerView: vi.fn(),
    }
    const tab = createWorkspaceTab('auxiliary', labels, {
      id: 'pending-interactions',
      contentRoute: '/pending-interactions?interaction=review',
      fixed: true,
    })
    const tree = (count: number, projectCount?: number | null) => (
      <I18nextProvider i18n={i18n}>
        <RuntimeInteractionsContext.Provider
          value={{
            ...value,
            projectItemsSupported: projectCount !== undefined,
            pendingProjectCount: projectCount,
            pending: Array.from({ length: count }, (_, index) => ({
              id: `request-${index}`,
              requestKey: `request-${index}`,
              task: interactionTask,
              payload: interactionQuestion,
              question: 'Review?',
              createdAt: index,
              answered: false,
            })),
          }}
        >
          <WorkspaceTabsProvider
            pathname="/pending-interactions"
            search="?interaction=review"
            storageScope="count-test"
            labels={labels}
            fixedTabs={[tab]}
            restoreSessionTabs={false}
          >
            <WorkspaceTabStrip />
          </WorkspaceTabsProvider>
        </RuntimeInteractionsContext.Provider>
      </I18nextProvider>
    )
    const rendered = render(tree(0))
    for (const count of [0, 2, 1234, 1, 0]) {
      rendered.rerender(tree(count))
      const title = language === 'zh-CN' ? `待你处理（${count}）` : `Needs your input (${count})`
      const button = screen.getByTestId('workspace-tab-select-pending-interactions')
      expect(button).toHaveTextContent(title)
      expect(button).toHaveAttribute('title', title)
      expect(
        screen.getByTestId('workspace-tab-pending-count-pending-interactions')
      ).toHaveTextContent(String(count))
      expect(screen.getAllByRole('tab')).toHaveLength(1)
    }
    rendered.rerender(tree(2, 3))
    expect(screen.getByTestId('workspace-tab-select-pending-interactions')).toHaveAttribute(
      'data-pending-question-count',
      '2'
    )
    expect(screen.getByTestId('workspace-tab-select-pending-interactions')).toHaveAttribute(
      'data-project-pending-count',
      '3'
    )
    expect(screen.getByTestId('workspace-tab-select-pending-interactions')).toHaveAttribute(
      'data-project-count-state',
      'known'
    )
    expect(
      screen.getByTestId('workspace-tab-pending-count-pending-interactions')
    ).toHaveTextContent('5')
    rendered.rerender(tree(2, null))
    expect(screen.getByTestId('workspace-tab-select-pending-interactions')).toHaveAttribute(
      'data-pending-question-count',
      '2'
    )
    expect(screen.getByTestId('workspace-tab-select-pending-interactions')).toHaveAttribute(
      'data-project-count-state',
      'unknown'
    )
    expect(screen.getByTestId('workspace-tab-select-pending-interactions')).not.toHaveAttribute(
      'data-project-pending-count'
    )
    expect(screen.queryByTestId('workspace-tab-pending-count-pending-interactions')).toBeNull()
    expect(screen.getByTestId('workspace-tab-select-pending-interactions')).toHaveTextContent(
      language === 'zh-CN' ? '待你处理' : 'Needs your input'
    )
  })

  test.each([false, true])(
    'opens Workbenches from the top tab add menu with experiments %s',
    async enabled => {
      experimentalFeatures.enabled = enabled
      const user = userEvent.setup()
      renderStrip()

      await user.click(screen.getByTestId('workspace-tab-add'))
      expect(screen.getByTestId('workspace-tab-add-smart-app')).toHaveTextContent('管理工作台')
      expect(
        screen.queryByTestId('workspace-tab-add-smart-app-experimental-badge')
      ).not.toBeInTheDocument()
      await user.click(screen.getByTestId('workspace-tab-add-smart-app'))

      expect(window.location.pathname).toBe('/sites')
      expect(new URLSearchParams(window.location.search).get('app_type')).toBe('smart_app')
      expect(screen.getByRole('tab', { name: '应用' })).toHaveAttribute('aria-selected', 'true')
    }
  )

  test.each([false, true])(
    'opens an installed Workbench from the top tab add menu with experiments %s',
    async enabled => {
      experimentalFeatures.enabled = enabled
      listHarnessApps.mockResolvedValue([
        {
          id: 'research',
          manifest: {
            displayName: '研究工作台',
          },
        },
      ])
      const user = userEvent.setup()
      renderStrip()

      await user.click(screen.getByTestId('workspace-tab-add'))
      await user.click(await screen.findByTestId('workspace-tab-add-smart-app-research'))

      expect(window.location.pathname).toBe('/app/harness-research')
      expect(screen.getByRole('tab', { name: '研究工作台' })).toHaveAttribute(
        'aria-selected',
        'true'
      )
    }
  )

  test('opens a native DSH workspace slot from the top tab add menu', async () => {
    const descriptors = [{ id: 'dashboard', label: 'DSH Dashboard', order: 1 }]
    window.__WEWORK_DSH_UI__ = {
      getEntries: slot => (slot === 'wework.workspace.tab' ? descriptors : []),
      subscribe: () => () => undefined,
      attach: vi.fn(),
    }
    const user = userEvent.setup()
    renderStrip()

    await user.click(screen.getByTestId('workspace-tab-add'))
    await user.click(screen.getByTestId('workspace-tab-add-dsh-dashboard'))

    expect(window.location.pathname).toBe('/dsh/workspace/dashboard')
    expect(screen.getByRole('tab', { name: 'DSH Dashboard' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  test('does not fetch or expose Workbenches in a window without auxiliary tabs', async () => {
    const user = userEvent.setup()
    renderStrip('', ['task', 'agent'])

    await user.click(screen.getByTestId('workspace-tab-add'))

    expect(screen.queryByTestId('workspace-tab-add-smart-app')).not.toBeInTheDocument()
    expect(listHarnessApps).not.toHaveBeenCalled()
  })

  test('opens an allowed fallback tab in a board-only window when board is unavailable', async () => {
    localStorage.setItem(
      workspaceTabsStorageKey('strip-test'),
      JSON.stringify({
        activeTabId: 'board-only',
        tabs: [{ id: 'board-only', kind: 'board', title: '项目空间', contentRoute: '/todo' }],
      })
    )

    renderStrip('', ['task', 'agent', 'auxiliary'] satisfies WorkspaceTabKind[], '/todo')

    const tablist = screen.getByTestId('workspace-tab-strip')
    await waitFor(() => {
      expect(screen.queryByRole('tab', { name: '协作' })).not.toBeInTheDocument()
      expect(within(tablist).getAllByRole('tab')).toHaveLength(1)
    })
    expect(within(tablist).getByRole('tab', { name: '任务' })).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  test('closes and restores the active tab with browser shortcuts', async () => {
    const user = userEvent.setup()
    renderStrip()

    await user.click(screen.getByTestId('workspace-tab-add'))
    await user.click(screen.getByTestId('workspace-tab-add-board'))
    const openedTab = screen
      .getAllByRole('tab', { name: '协作' })
      .find(tab => tab.getAttribute('aria-selected') === 'true')?.parentElement
    expect(openedTab).toBeDefined()
    fireEvent.keyDown(window, { key: 'w', metaKey: true })
    expect(screen.queryByTestId(openedTab!.dataset.testid!)).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 't', metaKey: true, shiftKey: true })
    await waitFor(() => expect(screen.getByTestId(openedTab!.dataset.testid!)).toBeInTheDocument())
  })

  test('opens a tab in a new window from its context menu', async () => {
    const user = userEvent.setup()
    renderStrip()

    fireEvent.contextMenu(screen.getByText('任务').closest('[role="tab"]')!)
    await user.click(screen.getByTestId('workspace-tab-open-new-window'))

    expect(openWorkspaceTabWindow).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'task', title: '任务' })
    )
    await waitFor(() => expect(screen.queryByRole('tab', { name: '任务' })).not.toBeInTheDocument())
    expect(screen.getAllByRole('tab')).toHaveLength(2)
  })

  test('pins a non-fixed tab through the shared fixed-tab preferences', async () => {
    const user = userEvent.setup()
    renderStrip()

    fireEvent.contextMenu(screen.getByText('任务').closest('[role="tab"]')!)
    await user.click(screen.getByTestId('workspace-tab-pin'))

    expect(updateAppPreferences).toHaveBeenCalledWith({
      fixedWorkspaceTabs: [
        ...defaultAppPreferences.fixedWorkspaceTabs,
        expect.objectContaining({
          kind: 'task',
          title: '任务',
          contentRoute: '/',
        }),
      ],
      startupWorkspaceTabId: defaultAppPreferences.startupWorkspaceTabId,
    })
  })

  test('offers return only in detached windows and moves the selected tab', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = {
      desktopHost: 'electron',
      desktopWindowLabel: 'workspace-detached-task',
    }
    const user = userEvent.setup()
    renderStrip()
    fireEvent.contextMenu(screen.getByRole('tab', { name: '任务' }))
    await user.click(screen.getByTestId('workspace-tab-return-to-main'))
    expect(returnWorkspaceTabToMain).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'task', title: '任务' })
    )
    await waitFor(() => expect(screen.queryByRole('tab', { name: '任务' })).toBeNull())
    expect(closeEmptyWorkspaceWindow).not.toHaveBeenCalled()
  })

  test('does not offer return in the main window', () => {
    renderStrip()
    fireEvent.contextMenu(screen.getByRole('tab', { name: '任务' }))
    expect(screen.queryByTestId('workspace-tab-return-to-main')).toBeNull()
  })

  test('pins against the latest preferences and replaces a stale detached assignment', async () => {
    const user = userEvent.setup()
    renderStrip()
    const id = screen
      .getByRole('tab', { name: '任务' })
      .getAttribute('data-testid')!
      .replace('workspace-tab-select-', '')
    getAppPreferences.mockResolvedValue({
      ...defaultAppPreferences,
      fixedWorkspaceTabs: [
        ...defaultAppPreferences.fixedWorkspaceTabs,
        { id, kind: 'task', title: '任务', contentRoute: '/', windowLabel: 'workspace-old' },
      ],
    })
    fireEvent.contextMenu(screen.getByRole('tab', { name: '任务' }))
    await user.click(screen.getByTestId('workspace-tab-pin'))
    await waitFor(() => expect(updateAppPreferences).toHaveBeenCalledOnce())
    const patch = updateAppPreferences.mock.calls[0][0] as AppPreferencesPatch
    expect(patch.fixedWorkspaceTabs?.filter(tab => tab.id === id)).toEqual([
      { id, kind: 'task', title: '任务', contentRoute: '/' },
    ])
  })

  test('closes the detached window after returning its last tab', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = {
      desktopHost: 'electron',
      desktopWindowLabel: 'workspace-only-task',
    }
    localStorage.setItem(
      workspaceTabsStorageKey('strip-test'),
      JSON.stringify({
        activeTabId: 'only-task',
        tabs: [{ id: 'only-task', kind: 'task', title: '任务', contentRoute: '/' }],
      })
    )
    const user = userEvent.setup()
    renderStrip()
    fireEvent.contextMenu(screen.getByTestId('workspace-tab-select-only-task'))
    await user.click(screen.getByTestId('workspace-tab-return-to-main'))
    await waitFor(() => expect(closeEmptyWorkspaceWindow).toHaveBeenCalledOnce())
    expect(screen.queryByTestId('workspace-tab-select-only-task')).toBeNull()
  })

  test('retains the tab when the main window cannot accept it', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = {
      desktopHost: 'electron',
      desktopWindowLabel: 'workspace-detached-task',
    }
    returnWorkspaceTabToMain.mockRejectedValueOnce(new Error('Main window unavailable'))
    const user = userEvent.setup()
    renderStrip()
    fireEvent.contextMenu(screen.getByRole('tab', { name: '任务' }))
    await user.click(screen.getByTestId('workspace-tab-return-to-main'))
    await waitFor(() => expect(returnWorkspaceTabToMain).toHaveBeenCalledOnce())
    expect(screen.getByRole('tab', { name: '任务' })).toBeInTheDocument()
    expect(closeEmptyWorkspaceWindow).not.toHaveBeenCalled()
  })

  test('keeps a pinned tab assigned to its detached workspace window', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = {
      desktopHost: 'electron',
      desktopWindowLabel: 'workspace-detached-task',
    }
    const user = userEvent.setup()
    renderStrip()

    fireEvent.contextMenu(screen.getByText('任务').closest('[role="tab"]')!)
    await user.click(screen.getByTestId('workspace-tab-pin'))

    expect(updateAppPreferences).toHaveBeenCalledWith({
      fixedWorkspaceTabs: [
        ...defaultAppPreferences.fixedWorkspaceTabs,
        expect.objectContaining({
          kind: 'task',
          title: '任务',
          contentRoute: '/',
          windowLabel: 'workspace-detached-task',
        }),
      ],
      startupWorkspaceTabId: defaultAppPreferences.startupWorkspaceTabId,
    })
  })

  test('unpins a fixed tab through the shared fixed-tab preferences', async () => {
    const user = userEvent.setup()
    renderStrip('', undefined, '/', true)

    fireEvent.contextMenu(screen.getByTestId('workspace-tab-select-fixed-task'))
    await user.click(screen.getByTestId('workspace-tab-unpin'))

    expect(updateAppPreferences).toHaveBeenCalledWith({
      fixedWorkspaceTabs: defaultAppPreferences.fixedWorkspaceTabs.filter(
        tab => tab.id !== 'fixed-task'
      ),
      startupWorkspaceTabId: 'fixed-board',
    })
  })

  test('opens a fixed tab in a persistent workspace window', async () => {
    const user = userEvent.setup()
    renderStrip('', undefined, '/', true)

    fireEvent.contextMenu(screen.getByTestId('workspace-tab-select-fixed-task'))
    await user.click(screen.getByTestId('workspace-tab-open-new-window'))

    const assignedPreferences = expect.arrayContaining([
      expect.objectContaining({
        id: 'fixed-task',
        title: '任务',
        contentRoute: '/',
        windowLabel: expect.stringMatching(/^workspace-fixed-task-/),
      }),
    ])
    expect(updateAppPreferences).toHaveBeenCalledWith({
      fixedWorkspaceTabs: assignedPreferences,
      startupWorkspaceTabId: defaultAppPreferences.startupWorkspaceTabId,
    })
    expect(openWorkspaceTabWindow).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'fixed-task', fixed: true }),
      {
        label: expect.stringMatching(/^workspace-fixed-task-/),
      }
    )
    await waitFor(() =>
      expect(screen.queryByTestId('workspace-tab-fixed-task')).not.toBeInTheDocument()
    )
  })

  test('restores a fixed tab assignment when its workspace window fails to open', async () => {
    openWorkspaceTabWindow.mockRejectedValueOnce(new Error('window failed'))
    const user = userEvent.setup()
    renderStrip('', undefined, '/', true)

    fireEvent.contextMenu(screen.getByTestId('workspace-tab-select-fixed-task'))
    await user.click(screen.getByTestId('workspace-tab-open-new-window'))

    await waitFor(() => expect(updateAppPreferences).toHaveBeenCalledTimes(2))
    expect(updateAppPreferences).toHaveBeenLastCalledWith({
      fixedWorkspaceTabs: defaultAppPreferences.fixedWorkspaceTabs,
      startupWorkspaceTabId: defaultAppPreferences.startupWorkspaceTabId,
    })
    expect(screen.getByTestId('workspace-tab-fixed-task')).toBeInTheDocument()
  })

  test('keeps the source tab when opening its new window fails', async () => {
    openWorkspaceTabWindow.mockRejectedValueOnce(new Error('window failed'))
    const user = userEvent.setup()
    renderStrip()

    fireEvent.contextMenu(screen.getByText('任务').closest('[role="tab"]')!)
    await user.click(screen.getByTestId('workspace-tab-open-new-window'))

    await waitFor(() => expect(openWorkspaceTabWindow).toHaveBeenCalledOnce())
    expect(screen.getByRole('tab', { name: '任务' })).toBeInTheDocument()
  })

  test('opens the tab context menu from the keyboard', () => {
    renderStrip()

    fireEvent.keyDown(screen.getByText('任务').closest('button')!, {
      key: 'F10',
      shiftKey: true,
    })

    expect(screen.getByTestId('workspace-tab-context-menu')).toBeVisible()
  })

  test('opens cloud connection when the default agent tab is unavailable', async () => {
    const user = userEvent.setup()
    renderStrip()

    await user.click(screen.getByRole('tab', { name: '智能体' }))

    expect(screen.getByTestId('cloud-connection-dialog')).toBeVisible()
    expect(screen.getByRole('tab', { name: '任务' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: '智能体' })).toHaveAttribute('aria-selected', 'false')
  })

  test('reorders tabs during dragover without reading drag payload data', async () => {
    const user = userEvent.setup()
    renderStrip()
    await user.click(screen.getByTestId('workspace-tab-add'))
    await user.click(screen.getByTestId('workspace-tab-add-board'))

    const taskTab = screen.getByRole('tab', { name: '任务' })
    const boardTab = screen.getAllByRole('tab', { name: '协作' })[0]
    const dataTransfer = {
      effectAllowed: 'none',
      setData: vi.fn(),
      getData: vi.fn(() => ''),
    }
    fireEvent.dragStart(taskTab.parentElement!, { dataTransfer })
    fireEvent.dragOver(boardTab.parentElement!, { dataTransfer })

    expect(dataTransfer.getData).not.toHaveBeenCalled()
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      expect.stringContaining('协作'),
      expect.stringContaining('任务'),
      expect.stringContaining('智能体'),
      expect.stringContaining('协作'),
    ])
  })

  test('restores a closed tab with a fresh identity when its old id is already open', async () => {
    const uuid = vi
      .spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000001')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000002')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000003')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000004')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000005')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000004')
      .mockReturnValueOnce('00000000-0000-4000-8000-000000000006')
    const user = userEvent.setup()
    renderStrip()

    await user.click(screen.getByTestId('workspace-tab-add'))
    await user.click(screen.getByTestId('workspace-tab-add-board'))
    fireEvent.keyDown(window, { key: 'w', metaKey: true })
    await user.click(screen.getByTestId('workspace-tab-add'))
    await user.click(screen.getByTestId('workspace-tab-add-board'))
    await waitFor(() =>
      expect(window.location.search).toContain(
        'workspaceTab=board-00000000-0000-4000-8000-000000000004'
      )
    )
    fireEvent.keyDown(window, { key: 't', metaKey: true, shiftKey: true })

    await waitFor(() =>
      expect(
        screen.getByTestId('workspace-tab-board-00000000-0000-4000-8000-000000000006')
      ).toBeInTheDocument()
    )
    expect(screen.getAllByRole('tab')).toHaveLength(5)
    expect(new Set(screen.getAllByRole('tab').map(tab => tab.dataset.testid)).size).toBe(5)
    await waitFor(() =>
      expect(window.location.search).toContain(
        'workspaceTab=board-00000000-0000-4000-8000-000000000006'
      )
    )
    uuid.mockRestore()
  })
})
