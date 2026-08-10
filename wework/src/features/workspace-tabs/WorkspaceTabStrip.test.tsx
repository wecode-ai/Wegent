import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkspaceTabsProvider } from './WorkspaceTabsContext'
import { WorkspaceTabStrip } from './WorkspaceTabStrip'

const openWorkspaceTabWindow = vi.fn().mockResolvedValue(true)

vi.mock('./workspaceWindow', () => ({
  openWorkspaceTabWindow: (tab: unknown) => openWorkspaceTabWindow(tab),
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
    apps: '应用',
  },
}

function renderStrip(search = '') {
  return render(
    <WorkspaceTabsProvider pathname="/" search={search} storageScope="strip-test" labels={labels}>
      <WorkspaceTabStrip />
    </WorkspaceTabsProvider>
  )
}

describe('WorkspaceTabStrip', () => {
  beforeEach(() => {
    localStorage.clear()
    openWorkspaceTabWindow.mockClear()
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
