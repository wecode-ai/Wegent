import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkspaceTabsProvider } from './WorkspaceTabsContext'
import { WorkspaceTabStrip } from './WorkspaceTabStrip'

const openWorkspaceTabWindow = vi.fn().mockResolvedValue(undefined)

vi.mock('./workspaceWindow', () => ({
  openWorkspaceTabWindow: (tab: unknown) => openWorkspaceTabWindow(tab),
}))

const labels = {
  task: '任务',
  board: '项目空间',
  agent: '智能体',
  auxiliary: '工作区',
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

    await user.click(screen.getByTestId('workspace-tab-add'))
    await user.click(screen.getByTestId('workspace-tab-add-board'))

    const tablist = screen.getByTestId('workspace-tab-strip')
    expect(within(tablist).getAllByRole('tab')).toHaveLength(2)
    expect(within(tablist).getByText('项目空间').closest('[role="tab"]')).toHaveAttribute(
      'aria-selected',
      'true'
    )

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
    fireEvent.keyDown(window, { key: 'w', metaKey: true })
    expect(screen.queryByText('项目空间')).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 't', metaKey: true, shiftKey: true })
    await waitFor(() => expect(screen.getByText('项目空间')).toBeInTheDocument())
  })

  test('opens a tab in a new window from its context menu', async () => {
    const user = userEvent.setup()
    renderStrip()

    fireEvent.contextMenu(screen.getByText('任务').closest('[role="tab"]')!)
    await user.click(screen.getByTestId('workspace-tab-open-new-window'))

    expect(openWorkspaceTabWindow).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'task', title: '任务' })
    )
  })

  test('opens the tab context menu from the keyboard', () => {
    renderStrip()

    fireEvent.keyDown(screen.getByText('任务').closest('button')!, {
      key: 'F10',
      shiftKey: true,
    })

    expect(screen.getByTestId('workspace-tab-context-menu')).toBeVisible()
  })
})
