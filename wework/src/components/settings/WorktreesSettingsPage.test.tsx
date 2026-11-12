import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import '@/i18n'
import type { DeviceInfo } from '@/types/api'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { WorktreesSettingsPage } from './WorktreesSettingsPage'

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
      runtime_features: {
        schemaVersion: 1,
        worktrees: {
          version: 1,
          managed: true,
          deferredPrepare: true,
          snapshots: true,
          restore: true,
          preflight: true,
        },
      },
    },
  ] as DeviceInfo[]

  beforeEach(() => {
    vi.clearAllMocks()
    getWorktreeSettings.mockResolvedValue({
      deviceId: 'local-device',
      worktreeRoot: '',
      resolvedWorktreeRoot: '/Users/me/.wework/workspace/worktrees',
      autoCleanupEnabled: true,
      keepCount: 15,
    })
    updateWorktreeSettings.mockImplementation(async data => ({
      deviceId: 'local-device',
      worktreeRoot: '',
      resolvedWorktreeRoot: '/Users/me/.wework/workspace/worktrees',
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
          path: '/Users/me/.wework/workspace/worktrees/runtime-1/repo',
          repositoryName: 'repo',
          sourcePath: '/Users/me/repo',
          state: 'active',
          conversations: [
            {
              deviceId: 'local-device',
              taskId: 'runtime-1',
              workspacePath: '/Users/me/.wework/workspace/worktrees/runtime-1/repo',
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

  test('shows persisted worktree failures so leftover directories remain diagnosable', async () => {
    const response = await listWorktrees()
    listWorktrees.mockResolvedValue({
      ...response,
      items: response.items.map((item: object) => ({
        ...item,
        state: 'failed',
        lastError: 'Managed worktree repository identity is unavailable',
      })),
    })
    render(<WorktreesSettingsPage api={api} devices={devices} />)
    expect(await screen.findByTestId('worktree-error')).toHaveTextContent(
      'Managed worktree repository identity is unavailable'
    )
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
    expect(deleteWorktree).not.toHaveBeenCalled()
    expect(screen.getByTestId('confirm-recycle-worktree-button-cancel-button')).toHaveTextContent(
      '取消'
    )
    listWorktrees.mockResolvedValueOnce({ success: true, deviceId: 'local-device', items: [] })
    await userEvent.click(screen.getByTestId('confirm-recycle-worktree-button'))
    await waitFor(() =>
      expect(deleteWorktree).toHaveBeenCalledWith({
        deviceId: 'local-device',
        path: '/Users/me/.wework/workspace/worktrees/runtime-1/repo',
        preserveSnapshot: true,
      })
    )
    expect(screen.queryByRole('dialog', { name: '删除工作树？' })).not.toBeInTheDocument()
    await waitFor(() =>
      expect(screen.queryByTestId('delete-worktree-button-runtime-1')).not.toBeInTheDocument()
    )
    expect(listWorktrees).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('worktrees-auto-cleanup-switch')).toBeInTheDocument()
  })

  test('exposes recycle failures after closing the confirmation dialog', async () => {
    deleteWorktree.mockResolvedValueOnce({ success: false })
    render(<WorktreesSettingsPage api={api} devices={devices} />)
    await userEvent.click(await screen.findByTestId('delete-worktree-button-runtime-1'))
    await userEvent.click(screen.getByTestId('confirm-recycle-worktree-button'))
    await waitFor(() =>
      expect(screen.queryByTestId('confirm-recycle-worktree-button')).not.toBeInTheDocument()
    )
    expect(screen.getByText('删除工作树失败')).toBeInTheDocument()
    expect(screen.getByTestId('delete-worktree-button-runtime-1')).toBeInTheDocument()
  })

  test('ignores stale Worktree responses after switching devices', async () => {
    let resolveLocalSettings: ((value: unknown) => void) | undefined
    let resolveLocalWorktrees: ((value: unknown) => void) | undefined
    getWorktreeSettings.mockImplementation(({ deviceId }) => {
      if (deviceId === 'local-device') {
        return new Promise(resolve => {
          resolveLocalSettings = resolve
        })
      }
      return Promise.resolve({
        deviceId,
        worktreeRoot: '/cloud-root',
        resolvedWorktreeRoot: '/cloud-root',
        autoCleanupEnabled: true,
        keepCount: 7,
      })
    })
    listWorktrees.mockImplementation(({ deviceId }) => {
      if (deviceId === 'local-device') {
        return new Promise(resolve => {
          resolveLocalWorktrees = resolve
        })
      }
      return Promise.resolve({
        success: true,
        deviceId,
        items: [
          {
            deviceId,
            worktreeId: 'cloud-task',
            path: '/cloud-root/cloud-task/repo',
            repositoryName: 'cloud-repo',
            sourcePath: '/cloud/repo',
            state: 'active',
            conversations: [],
          },
        ],
      })
    })

    render(
      <WorktreesSettingsPage
        api={api}
        devices={[
          ...devices,
          {
            ...devices[0],
            id: 2,
            device_id: 'cloud-device',
            name: 'Cloud',
            device_type: 'cloud',
            is_default: false,
            runtime_features: {
              ...devices[0].runtime_features,
              worktrees: {
                ...devices[0].runtime_features?.worktrees,
                persistentStorageVerified: true,
              },
            },
          },
        ]}
      />
    )

    await userEvent.selectOptions(screen.getByTestId('worktrees-device-select'), 'cloud-device')
    expect(await screen.findByText('/cloud/repo')).toBeInTheDocument()
    expect(screen.getByTestId('worktrees-keep-count-input')).toHaveValue(7)

    resolveLocalSettings?.({
      deviceId: 'local-device',
      worktreeRoot: '/stale-local-root',
      resolvedWorktreeRoot: '/stale-local-root',
      autoCleanupEnabled: false,
      keepCount: 99,
    })
    resolveLocalWorktrees?.({
      success: true,
      deviceId: 'local-device',
      items: [],
    })

    await waitFor(() => {
      expect(screen.getByText('/cloud/repo')).toBeInTheDocument()
      expect(screen.getByTestId('worktrees-keep-count-input')).toHaveValue(7)
    })
  })
})
