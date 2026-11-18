import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import i18n from '@/i18n'
import type { DeviceInfo } from '@/types/api'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
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

  test('a pending worktree list does not block settings', async () => {
    listWorktrees.mockReturnValueOnce(new Promise(() => {}))
    render(<WorktreesSettingsPage api={api} devices={devices} />)
    await waitFor(() => expect(getWorktreeSettings).toHaveBeenCalledOnce())
    await act(async () => {
      await getWorktreeSettings.mock.results[0].value
    })
    expect(screen.getByTestId('worktrees-keep-count-input')).toHaveValue(15)
  })

  test('pending settings do not block the worktree list', async () => {
    getWorktreeSettings.mockReturnValueOnce(new Promise(() => {}))
    render(<WorktreesSettingsPage api={api} devices={devices} />)
    await waitFor(() => expect(listWorktrees).toHaveBeenCalledOnce())
    await act(async () => {
      await listWorktrees.mock.results[0].value
    })
    expect(screen.getByText('Fix settings')).toBeInTheDocument()
  })

  test('language changes preserve an unsaved root without repeating device requests', async () => {
    const previousLanguage = i18n.language
    const view = render(<WorktreesSettingsPage api={api} devices={devices} />)
    try {
      await screen.findByText('Fix settings')
      fireEvent.change(screen.getByTestId('worktrees-root-input'), {
        target: { value: '/unsaved' },
      })
      await act(async () => {
        await i18n.changeLanguage(previousLanguage.startsWith('en') ? 'zh-CN' : 'en')
      })
      await act(() => new Promise<void>(resolve => window.setTimeout(resolve, 0)))
      expect(getWorktreeSettings).toHaveBeenCalledOnce()
      expect(listWorktrees).toHaveBeenCalledOnce()
      expect(screen.getByTestId('worktrees-root-input')).toHaveValue('/unsaved')
    } finally {
      view.unmount()
      await act(async () => {
        await i18n.changeLanguage(previousLanguage)
      })
    }
  })

  test('a save receipt from the previous API cannot change the current API settings or modal', async () => {
    let finish!: (settings: unknown) => void
    updateWorktreeSettings.mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve
      })
    )
    const view = render(<WorktreesSettingsPage api={api} devices={devices} />)
    await screen.findByText('Fix settings')
    fireEvent.change(screen.getByTestId('worktrees-root-input'), { target: { value: '/old' } })
    fireEvent.blur(screen.getByTestId('worktrees-root-input'))
    const nextApi = {
      ...api,
      getWorktreeSettings: vi.fn().mockResolvedValue({
        deviceId: 'local-device',
        worktreeRoot: '/current',
        resolvedWorktreeRoot: '/current',
        autoCleanupEnabled: true,
        keepCount: 5,
      }),
    }
    view.rerender(<WorktreesSettingsPage api={nextApi} devices={devices} />)
    await waitFor(() => expect(screen.getByTestId('worktrees-root-input')).toHaveValue('/current'))
    await userEvent.click(screen.getByTestId('worktrees-auto-cleanup-switch'))
    await act(async () =>
      finish({
        deviceId: 'local-device',
        worktreeRoot: '/old',
        autoCleanupEnabled: false,
        keepCount: 99,
      })
    )
    expect(screen.getByTestId('worktrees-root-input')).toHaveValue('/current')
    expect(screen.getByTestId('worktrees-keep-count-input')).toHaveValue(5)
    expect(screen.getByTestId('disable-worktree-cleanup-dialog')).toBeInTheDocument()
    expect(screen.queryByTestId('worktrees-saved-notice')).not.toBeInTheDocument()
  })

  afterEach(() => vi.useRealTimers())

  test('repeated saves of the same notice each receive a full expiration interval', async () => {
    vi.useFakeTimers()
    const view = render(<WorktreesSettingsPage api={api} devices={devices} />)
    try {
      await act(() => vi.advanceTimersByTimeAsync(0))
      const input = screen.getByTestId('worktrees-keep-count-input')
      fireEvent.change(input, { target: { value: '16' } })
      await act(async () => {
        fireEvent.blur(input)
      })
      expect(screen.getByTestId('worktrees-saved-notice')).toBeInTheDocument()
      await act(() => vi.advanceTimersByTimeAsync(1000))
      fireEvent.change(input, { target: { value: '17' } })
      await act(async () => {
        fireEvent.blur(input)
      })
      await act(() => vi.advanceTimersByTimeAsync(1001))
      expect(screen.getByTestId('worktrees-saved-notice')).toBeInTheDocument()
      await act(() => vi.advanceTimersByTimeAsync(999))
      expect(screen.queryByTestId('worktrees-saved-notice')).not.toBeInTheDocument()
      expect(updateWorktreeSettings).toHaveBeenCalledTimes(2)
    } finally {
      view.unmount()
    }
  })

  test('refresh keeps unsaved fields and updates only fields that were clean', async () => {
    render(<WorktreesSettingsPage api={api} devices={devices} />)
    await screen.findByText('Fix settings')
    fireEvent.change(screen.getByTestId('worktrees-root-input'), { target: { value: '/unsaved' } })
    getWorktreeSettings.mockResolvedValueOnce({
      deviceId: 'local-device',
      worktreeRoot: '/server',
      autoCleanupEnabled: true,
      keepCount: 23,
    })
    await userEvent.click(screen.getByTestId('worktrees-refresh-button'))
    await waitFor(() => expect(screen.getByTestId('worktrees-keep-count-input')).toHaveValue(23))
    expect(screen.getByTestId('worktrees-root-input')).toHaveValue('/unsaved')
    expect(updateWorktreeSettings).not.toHaveBeenCalled()
  })

  test('list failures do not hide settings or appear as an empty list and refresh can recover', async () => {
    listWorktrees.mockRejectedValueOnce(new Error('list offline'))
    render(<WorktreesSettingsPage api={api} devices={devices} />)
    await screen.findByText('list offline')
    expect(screen.getByTestId('worktrees-keep-count-input')).toHaveValue(15)
    expect(
      screen.queryByText(i18n.t('workbench.worktrees_empty_description'))
    ).not.toBeInTheDocument()
    await userEvent.click(screen.getByTestId('worktrees-refresh-button'))
    await screen.findByText('Fix settings')
    expect(screen.queryByText('list offline')).not.toBeInTheDocument()
  })

  test('a failed list response is treated as a failure instead of an empty success', async () => {
    listWorktrees.mockResolvedValueOnce({ success: false, deviceId: 'local-device', items: [] })
    render(<WorktreesSettingsPage api={api} devices={devices} />)
    await waitFor(() => expect(screen.getByTestId('worktrees-root-input')).toBeInTheDocument())
    expect(screen.getByText(i18n.t('workbench.worktrees_load_failed'))).toBeInTheDocument()
    expect(
      screen.queryByText(i18n.t('workbench.worktrees_empty_description'))
    ).not.toBeInTheDocument()
  })

  test('a failed sidebar refresh after deletion does not close another worktree confirmation', async () => {
    const response = await listWorktrees()
    const second = {
      ...response.items[0],
      worktreeId: 'runtime-2',
      path: '/worktrees/runtime-2/repo',
    }
    listWorktrees
      .mockResolvedValueOnce({ ...response, items: [...response.items, second] })
      .mockResolvedValue({ ...response, items: [second] })
    let failRefresh!: (reason: unknown) => void
    const refresh = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          failRefresh = reject
        })
    )
    render(<WorktreesSettingsPage api={api} devices={devices} onRefreshWorkLists={refresh} />)
    await userEvent.click(await screen.findByTestId('delete-worktree-button-runtime-1'))
    await userEvent.click(screen.getByTestId('confirm-recycle-worktree-button'))
    await waitFor(() =>
      expect(screen.queryByTestId('confirm-recycle-worktree-button')).not.toBeInTheDocument()
    )
    await userEvent.click(screen.getByTestId('delete-worktree-button-runtime-2'))
    await act(async () => failRefresh(new Error('sidebar refresh failed')))
    expect(screen.getByTestId('confirm-recycle-worktree-button')).toBeInTheDocument()
    expect(deleteWorktree).toHaveBeenCalledOnce()
  })

  test('an unavailable device performs no reads and is not reported as an empty list', () => {
    render(<WorktreesSettingsPage api={api} devices={[]} />)
    expect(getWorktreeSettings).not.toHaveBeenCalled()
    expect(listWorktrees).not.toHaveBeenCalled()
    expect(screen.getByText(i18n.t('workbench.worktrees_device_unavailable'))).toBeInTheDocument()
    expect(
      screen.queryByText(i18n.t('workbench.worktrees_empty_description'))
    ).not.toBeInTheDocument()
  })
})
