import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkspaceTabsProvider } from './WorkspaceTabsContext'
import { WorkspaceTabStrip } from './WorkspaceTabStrip'
import { createWorkspaceTab, workspaceTabsStorageKey, type WorkspaceTabKind } from './workspaceTabs'

const openWorkspaceTabWindow = vi.fn().mockResolvedValue(true)
const experimentalFeatures = vi.hoisted(() => ({ enabled: true }))
const listHarnessApps = vi.hoisted(() => vi.fn().mockResolvedValue([]))

vi.mock('./workspaceWindow', () => ({
  openWorkspaceTabWindow: (tab: unknown) => openWorkspaceTabWindow(tab),
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
  board: '项目空间',
  agent: '智能体',
  auxiliary: '工作区',
  auxiliaryRoutes: {
    plugins: '插件',
    sites: '站点',
    automations: '已安排',
    cloud: '云端工作',
  },
}

function renderStrip(
  search = '',
  availableKinds?: ComponentProps<typeof WorkspaceTabStrip>['availableKinds'],
  pathname = '/',
  fixed = false
) {
  return render(
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
                fixed: true,
              })
            )
          : undefined
      }
      restoreSessionTabs={!fixed}
    >
      <WorkspaceTabStrip availableKinds={availableKinds} />
    </WorkspaceTabsProvider>
  )
}

describe('WorkspaceTabStrip', () => {
  beforeEach(() => {
    localStorage.clear()
    openWorkspaceTabWindow.mockClear()
    experimentalFeatures.enabled = true
    listHarnessApps.mockReset()
    listHarnessApps.mockResolvedValue([])
    window.history.replaceState({}, '', '/')
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
      expect.stringContaining('项目空间'),
      expect.stringContaining('智能体'),
    ])

    await user.click(screen.getByTestId('workspace-tab-add'))
    await user.click(screen.getByTestId('workspace-tab-add-board'))

    expect(within(tablist).getAllByRole('tab')).toHaveLength(4)
    const activeBoardTab = within(tablist)
      .getAllByRole('tab', { name: '项目空间' })
      .find(tab => tab.getAttribute('aria-selected') === 'true')
    expect(activeBoardTab).toBeDefined()
    expect(activeBoardTab?.parentElement).toHaveClass('bg-white/55', 'rounded-md')

    await user.click(within(tablist).getByText('任务'))
    expect(within(tablist).getByText('任务').closest('[role="tab"]')).toHaveAttribute(
      'aria-selected',
      'true'
    )
  })

  test('keeps fixed tabs selectable and prevents closing them', async () => {
    const user = userEvent.setup()
    renderStrip('', undefined, '/', true)

    await user.click(screen.getByTestId('workspace-tab-select-fixed-board'))
    expect(screen.getByTestId('workspace-tab-select-fixed-board')).toHaveAttribute(
      'aria-selected',
      'true'
    )
    expect(screen.queryByTestId('workspace-tab-close-fixed-board')).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'w', metaKey: true })
    expect(screen.getAllByRole('tab')).toHaveLength(3)
    expect(screen.getByTestId('workspace-tab-select-fixed-board')).toHaveAttribute(
      'aria-selected',
      'true'
    )
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
    expect(screen.queryByRole('tab', { name: '项目空间' })).not.toBeInTheDocument()

    await user.click(screen.getByTestId('workspace-tab-add'))
    expect(screen.getByTestId('workspace-tab-add-menu')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-tab-add-board')).not.toBeInTheDocument()
    expect(screen.getByTestId('workspace-tab-add-task')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-tab-add-agent')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-tab-add-smart-app')).toBeInTheDocument()
  })

  test('opens Smart apps from the top tab add menu', async () => {
    const user = userEvent.setup()
    renderStrip()

    await user.click(screen.getByTestId('workspace-tab-add'))
    await user.click(screen.getByTestId('workspace-tab-add-smart-app'))

    expect(window.location.pathname).toBe('/sites')
    expect(new URLSearchParams(window.location.search).get('app_type')).toBe('smart_app')
    expect(screen.getByRole('tab', { name: '应用' })).toHaveAttribute('aria-selected', 'true')
  })

  test('opens an installed Smart app directly from the top tab add menu', async () => {
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
    expect(screen.getByRole('tab', { name: '研究工作台' })).toHaveAttribute('aria-selected', 'true')
  })

  test('hides Smart apps from the top tab add menu while experiments are disabled', async () => {
    experimentalFeatures.enabled = false
    const user = userEvent.setup()
    renderStrip()

    await user.click(screen.getByTestId('workspace-tab-add'))

    expect(screen.queryByTestId('workspace-tab-add-smart-app')).not.toBeInTheDocument()
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
      expect(screen.queryByRole('tab', { name: '项目空间' })).not.toBeInTheDocument()
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
      .getAllByRole('tab', { name: '项目空间' })
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
    const boardTab = screen.getAllByRole('tab', { name: '项目空间' })[0]
    const dataTransfer = {
      effectAllowed: 'none',
      setData: vi.fn(),
      getData: vi.fn(() => ''),
    }
    fireEvent.dragStart(taskTab.parentElement!, { dataTransfer })
    fireEvent.dragOver(boardTab.parentElement!, { dataTransfer })

    expect(dataTransfer.getData).not.toHaveBeenCalled()
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual([
      expect.stringContaining('项目空间'),
      expect.stringContaining('任务'),
      expect.stringContaining('智能体'),
      expect.stringContaining('项目空间'),
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
