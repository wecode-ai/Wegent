import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo } from '@/types/devices'
import { WorktreesSettingsPage } from './WorktreesSettingsPage'
import '@/i18n'

describe('WorktreesSettingsPage', () => {
  const getWorktreeSettings = vi.fn()
  const updateWorktreeSettings = vi.fn()
  const listWorktrees = vi.fn()
  const deleteWorktree = vi.fn()
  const restoreWorktree = vi.fn()

  const api = {
    getWorktreeSettings,
    updateWorktreeSettings,
    listWorktrees,
    deleteWorktree,
    restoreWorktree,
  } as unknown as NonNullable<WorkbenchServices['runtimeWorkApi']>

  const devices = [
    {
      id: 1,
      device_id: 'local-device',
      name: 'This Mac',
      status: 'online',
      device_type: 'local',
      bind_shell: 'codex',
      is_default: true,
    },
  ] as DeviceInfo[]

  beforeEach(() => {
    vi.clearAllMocks()
    getWorktreeSettings.mockResolvedValue({
      deviceId: 'local-device',
      worktreeRoot: '',
      resolvedWorktreeRoot: '/Users/me/.wecode/wegent-executor/workspace/worktrees',
      autoCleanupEnabled: true,
      keepCount: 15,
    })
    updateWorktreeSettings.mockImplementation(async data => ({
      deviceId: 'local-device',
      worktreeRoot: '',
      resolvedWorktreeRoot: '/Users/me/.wecode/wegent-executor/workspace/worktrees',
      autoCleanupEnabled: data.autoCleanupEnabled ?? true,
      keepCount: data.keepCount ?? 15,
    }))
    listWorktrees.mockResolvedValue({
      success: true,
      deviceId: 'local-device',
      items: [
        {
          deviceId: 'local-device',
          worktreeId: 'runtime-1',
          path: '/Users/me/.wecode/wegent-executor/workspace/worktrees/runtime-1/repo',
          repositoryName: 'repo',
          sourcePath: '/Users/me/repo',
          state: 'active',
          conversations: [
            {
              deviceId: 'local-device',
              taskId: 'runtime-1',
              workspacePath: '/Users/me/.wecode/wegent-executor/workspace/worktrees/runtime-1/repo',
              title: 'Fix settings',
              status: 'active',
              running: false,
            },
          ],
        },
      ],
    })
    deleteWorktree.mockResolvedValue({ success: true })
    restoreWorktree.mockResolvedValue({ success: true })
  })

  test('loads Codex defaults and linked tasks from the injected device API', async () => {
    render(<WorktreesSettingsPage api={api} devices={devices} />)

    expect(await screen.findByTestId('worktrees-settings-page')).toBeInTheDocument()
    await waitFor(() =>
      expect(getWorktreeSettings).toHaveBeenCalledWith({ deviceId: 'local-device' })
    )
    expect(screen.getByTestId('worktrees-auto-cleanup-switch')).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByTestId('worktrees-keep-count-input')).toHaveValue(15)
    expect(screen.getByText('Fix settings')).toBeInTheDocument()
  })

  test('matches the Codex project grouping and opens a linked conversation', async () => {
    const onOpenRuntimeTask = vi.fn().mockResolvedValue(undefined)
    const onRefreshWorkLists = vi.fn().mockResolvedValue(undefined)
    const onLeaveSettings = vi.fn()
    render(
      <WorktreesSettingsPage
        api={api}
        devices={devices}
        onOpenRuntimeTask={onOpenRuntimeTask}
        onRefreshWorkLists={onRefreshWorkLists}
        onLeaveSettings={onLeaveSettings}
      />
    )

    const projectHeader = await screen.findByTestId('worktree-project-header')
    expect(projectHeader).toHaveTextContent('/Users/me/repo')
    expect(projectHeader).toContainElement(screen.getByTestId('worktrees-refresh-button'))
    expect(screen.queryByText('已管理的工作树')).not.toBeInTheDocument()
    expect(within(screen.getByTestId('worktree-row')).getByText('工作树')).toBeInTheDocument()
    expect(screen.getByText('对话')).toBeInTheDocument()
    expect(screen.getByTestId('delete-worktree-button-runtime-1')).toHaveTextContent('删除')

    await userEvent.click(screen.getByTestId('worktree-linked-task'))
    await waitFor(() =>
      expect(onOpenRuntimeTask).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: 'local-device', taskId: 'runtime-1' })
      )
    )
    expect(onRefreshWorkLists).toHaveBeenCalledTimes(1)
    expect(onLeaveSettings).toHaveBeenCalledTimes(1)
  })

  test('keeps restorable snapshots out of the active worktree list', async () => {
    listWorktrees.mockResolvedValueOnce({
      success: true,
      deviceId: 'local-device',
      items: [
        {
          deviceId: 'local-device',
          worktreeId: 'runtime-restorable',
          path: '/Users/me/.wecode/wegent-executor/workspace/worktrees/restorable/repo',
          repositoryName: 'repo',
          sourcePath: '/Users/me/repo',
          state: 'restorable',
          conversations: [],
        },
      ],
    })

    render(<WorktreesSettingsPage api={api} devices={devices} />)

    expect(await screen.findByText('创建的工作树将显示在此处。')).toBeInTheDocument()
    expect(screen.queryByText(/worktrees\/restorable/)).not.toBeInTheDocument()
    expect(screen.queryByText('可恢复')).not.toBeInTheDocument()
  })

  test('updates cleanup settings and removes a deleted worktree without reloading the page', async () => {
    render(<WorktreesSettingsPage api={api} devices={devices} />)
    await screen.findByText('Fix settings')

    const cleanupSwitch = screen.getByTestId('worktrees-auto-cleanup-switch')
    expect(cleanupSwitch.querySelector('span')).toHaveClass('h-5', 'w-8', 'overflow-hidden')
    expect(cleanupSwitch.querySelector('span span')).toHaveClass('translate-x-[14px]')
    await userEvent.click(cleanupSwitch)
    expect(screen.getByTestId('disable-worktree-cleanup-dialog')).toBeInTheDocument()
    expect(updateWorktreeSettings).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId('disable-worktree-cleanup-button'))
    await waitFor(() =>
      expect(updateWorktreeSettings).toHaveBeenCalledWith({
        deviceId: 'local-device',
        autoCleanupEnabled: false,
      })
    )
    expect(screen.getByTestId('worktrees-saved-notice')).toHaveTextContent('已保存自动删除设置')
    expect(cleanupSwitch).toHaveAttribute('aria-checked', 'false')
    expect(cleanupSwitch.querySelector('span span')).toHaveClass('translate-x-0.5')

    await userEvent.click(screen.getByTestId('delete-worktree-button-runtime-1'))
    await waitFor(() =>
      expect(deleteWorktree).toHaveBeenCalledWith({
        deviceId: 'local-device',
        path: '/Users/me/.wecode/wegent-executor/workspace/worktrees/runtime-1/repo',
        preserveSnapshot: true,
      })
    )
    expect(screen.queryByRole('dialog', { name: '删除工作树？' })).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByTestId('delete-worktree-button-runtime-1')).not.toBeInTheDocument()
    )
    expect(listWorktrees).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('worktrees-auto-cleanup-switch')).toBeInTheDocument()
  })

  test('saves the cleanup limit on Enter without reloading the list', async () => {
    render(<WorktreesSettingsPage api={api} devices={devices} />)
    await screen.findByText('Fix settings')
    expect(listWorktrees).toHaveBeenCalledTimes(1)

    const input = screen.getByTestId('worktrees-keep-count-input')
    await userEvent.clear(input)
    await userEvent.type(input, '20{Enter}')

    await waitFor(() =>
      expect(updateWorktreeSettings).toHaveBeenCalledWith({
        deviceId: 'local-device',
        keepCount: 20,
      })
    )
    expect(screen.getByTestId('worktrees-saved-notice')).toHaveTextContent('已保存自动删除限制')
    expect(listWorktrees).toHaveBeenCalledTimes(1)
  })
})
