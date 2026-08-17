import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { ProjectWithTasks } from '@/types/api'
import { PopoutWorkspaceMenu } from './PopoutWorkspaceMenu'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) =>
      ({
        'workbench.popout_workspace_menu': '工作区设置',
        'workbench.popout_workspace_menu_project': '项目',
        'workbench.popout_workspace_menu_no_project': '无项目',
        'workbench.popout_workspace_menu_launch_mode': '启动模式',
        'workbench.popout_workspace_menu_worktree': '工作树',
        'workbench.popout_workspace_menu_current_workspace': '当前工作区',
        'workbench.popout_workspace_menu_branch': '分支',
        'workbench.popout_workspace_menu_no_branch': '无分支',
        'workbench.popout_workspace_menu_permission': '权限',
        'workbench.popout_workspace_menu_full_access': '完全访问',
      })[key] ??
      fallback ??
      key,
  }),
}))

const projects = [
  { id: 1, name: 'Wegent' },
  { id: 2, name: 'wework_video' },
] as ProjectWithTasks[]

function renderMenu(overrides: Partial<ComponentProps<typeof PopoutWorkspaceMenu>> = {}) {
  const props: ComponentProps<typeof PopoutWorkspaceMenu> = {
    branchName: 'main',
    currentProjectId: 1,
    executionMode: 'git_worktree',
    isGitProject: true,
    projectName: 'Wegent',
    projects,
    onCheckoutBranch: vi.fn().mockResolvedValue(undefined),
    onExecutionModeChange: vi.fn(),
    onListBranches: vi.fn().mockResolvedValue(['main', 'fix/menu']),
    onSelectProject: vi.fn(),
    ...overrides,
  }
  render(<PopoutWorkspaceMenu {...props} />)
  return props
}

describe('PopoutWorkspaceMenu', () => {
  test('shows only the Codex workspace summary rows in a body portal', async () => {
    renderMenu()

    await userEvent.click(screen.getByTestId('composer-project-menu-button'))

    const menu = screen.getByTestId('popout-workspace-menu')
    expect(menu.parentElement).toBe(document.body)
    expect(menu).toHaveTextContent('项目')
    expect(menu).toHaveTextContent('Wegent')
    expect(menu).toHaveTextContent('启动模式')
    expect(menu).toHaveTextContent('工作树')
    expect(menu).toHaveTextContent('分支')
    expect(menu).toHaveTextContent('main')
    expect(menu).toHaveTextContent('完全访问')
    expect(menu).not.toHaveTextContent('环境')
  })

  test('switches projects in a compact submenu without opening the legacy project menu', async () => {
    const props = renderMenu()

    await userEvent.click(screen.getByTestId('composer-project-menu-button'))
    await userEvent.click(screen.getByTestId('popout-workspace-project-button'))
    expect(screen.getByTestId('popout-workspace-project-submenu')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('popout-workspace-project-option-2'))

    expect(props.onSelectProject).toHaveBeenCalledWith(2)
    expect(screen.queryByTestId('popout-workspace-menu')).not.toBeInTheDocument()
  })

  test('changes launch mode from its submenu', async () => {
    const props = renderMenu({ executionMode: 'current_workspace' })

    await userEvent.click(screen.getByTestId('composer-project-menu-button'))
    await userEvent.click(screen.getByTestId('popout-workspace-launch-mode-button'))
    await userEvent.click(screen.getByTestId('popout-workspace-launch-mode-git_worktree'))

    expect(props.onExecutionModeChange).toHaveBeenCalledWith('git_worktree')
  })

  test('disables worktree mode when the selected project is not a Git project', async () => {
    renderMenu({ executionMode: 'current_workspace', isGitProject: false })

    await userEvent.click(screen.getByTestId('composer-project-menu-button'))
    await userEvent.click(screen.getByTestId('popout-workspace-launch-mode-button'))

    expect(screen.getByTestId('popout-workspace-launch-mode-git_worktree')).toBeDisabled()
  })

  test('loads, filters, and switches branches from its submenu', async () => {
    const props = renderMenu()

    await userEvent.click(screen.getByTestId('composer-project-menu-button'))
    await userEvent.click(screen.getByTestId('popout-workspace-branch-button'))
    await waitFor(() =>
      expect(screen.getByTestId('popout-workspace-branch-option-fix/menu')).toBeInTheDocument()
    )

    await userEvent.type(screen.getByTestId('popout-workspace-branch-search'), 'fix')
    expect(screen.queryByTestId('popout-workspace-branch-option-main')).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('popout-workspace-branch-option-fix/menu'))

    expect(props.onCheckoutBranch).toHaveBeenCalledWith('fix/menu')
  })

  test('keeps the current branch selectable when loading the branch list fails', async () => {
    renderMenu({ onListBranches: vi.fn().mockRejectedValue(new Error('offline')) })

    await userEvent.click(screen.getByTestId('composer-project-menu-button'))
    await userEvent.click(screen.getByTestId('popout-workspace-branch-button'))

    await waitFor(() =>
      expect(screen.getByTestId('popout-workspace-branch-option-main')).toBeInTheDocument()
    )
    expect(screen.queryByText('加载中…')).not.toBeInTheDocument()
  })

  test('closes the submenu before closing the menu with Escape', async () => {
    renderMenu()

    const trigger = screen.getByTestId('composer-project-menu-button')
    await userEvent.click(trigger)
    await userEvent.click(screen.getByTestId('popout-workspace-project-button'))

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('popout-workspace-project-submenu')).not.toBeInTheDocument()
    expect(screen.getByTestId('popout-workspace-menu')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('popout-workspace-menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  test('handles branch checkout failures without an unhandled rejection', async () => {
    const error = new Error('checkout failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    renderMenu({ onCheckoutBranch: vi.fn().mockRejectedValue(error) })

    await userEvent.click(screen.getByTestId('composer-project-menu-button'))
    await userEvent.click(screen.getByTestId('popout-workspace-branch-button'))
    await waitFor(() =>
      expect(screen.getByTestId('popout-workspace-branch-option-fix/menu')).toBeInTheDocument()
    )
    await userEvent.click(screen.getByTestId('popout-workspace-branch-option-fix/menu'))

    await waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        '[Wework] Failed to checkout Popout Window branch',
        error
      )
    )
    consoleError.mockRestore()
  })
})
