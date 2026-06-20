import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { LocalCodexThreadImportDialog } from './LocalCodexThreadImportDialog'
import type { DeviceInfo, LocalCodexThreadSummary } from '@/types/api'

function localDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 1,
    device_id: 'local-device',
    name: 'Local Mac',
    status: 'online',
    is_default: true,
    device_type: 'local',
    bind_shell: 'claudecode',
    ...overrides,
  }
}

function renderDialog({
  devices = [localDevice()],
  threads = [],
  onListLocalCodexThreads = vi.fn().mockResolvedValue(threads),
  onBindLocalCodexThread = vi.fn().mockResolvedValue({
    taskId: 9,
    task: {
      id: 9,
      title: 'Imported',
      status: 'COMPLETED',
      created_at: '2026-06-20T00:00:00Z',
    },
    created: true,
  }),
}: {
  devices?: DeviceInfo[]
  threads?: LocalCodexThreadSummary[]
  onListLocalCodexThreads?: (deviceId: string) => Promise<LocalCodexThreadSummary[]>
  onBindLocalCodexThread?: Parameters<typeof LocalCodexThreadImportDialog>[0]['onBindLocalCodexThread']
} = {}) {
  render(
    <LocalCodexThreadImportDialog
      open
      devices={devices}
      onClose={vi.fn()}
      onListLocalCodexThreads={onListLocalCodexThreads}
      onBindLocalCodexThread={onBindLocalCodexThread}
    />,
  )

  return {
    onListLocalCodexThreads,
    onBindLocalCodexThread,
  }
}

describe('LocalCodexThreadImportDialog', () => {
  test('shows offline empty state when no online local device exists', () => {
    renderDialog({
      devices: [
        localDevice({ device_id: 'offline-local', status: 'offline' }),
        localDevice({ device_id: 'cloud-device', device_type: 'cloud' }),
      ],
    })

    expect(screen.getByTestId('local-codex-import-dialog')).toHaveTextContent(
      '需要在线的本地设备',
    )
    expect(screen.queryByTestId('local-codex-device-select')).not.toBeInTheDocument()
  })

  test('loads thread summaries after selecting a device', async () => {
    const onListLocalCodexThreads = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          threadId: 'thread-2',
          title: 'Second thread',
          cwd: '/workspace/second',
          updatedAt: '2026-06-20T10:00:00Z',
        },
      ])

    renderDialog({
      devices: [
        localDevice({ device_id: 'local-a', name: 'Local A' }),
        localDevice({ device_id: 'local-b', name: 'Local B' }),
      ],
      onListLocalCodexThreads,
    })

    expect(onListLocalCodexThreads).toHaveBeenCalledWith('local-a')

    fireEvent.change(screen.getByTestId('local-codex-device-select'), {
      target: { value: 'local-b' },
    })

    await waitFor(() => expect(onListLocalCodexThreads).toHaveBeenCalledWith('local-b'))
    expect(await screen.findByText('Second thread')).toBeInTheDocument()
    expect(screen.getByText('/workspace/second')).toBeInTheDocument()
  })

  test('calls bind action with the selected thread summary', async () => {
    const onBindLocalCodexThread = vi.fn().mockResolvedValue({
      taskId: 9,
      task: {
        id: 9,
        title: 'Imported',
        status: 'COMPLETED',
        created_at: '2026-06-20T00:00:00Z',
      },
      created: true,
    })

    renderDialog({
      threads: [
        {
          threadId: 'thread-1',
          title: 'Implement import',
          cwd: '/workspace/import',
        },
      ],
      onBindLocalCodexThread,
    })

    await userEvent.click(await screen.findByTestId('local-codex-bind-button'))

    expect(onBindLocalCodexThread).toHaveBeenCalledWith({
      deviceId: 'local-device',
      threadId: 'thread-1',
      title: 'Implement import',
      cwd: '/workspace/import',
    })
  })

  test('disables bind button for archived and running threads', async () => {
    renderDialog({
      threads: [
        {
          threadId: 'archived-thread',
          title: 'Archived thread',
          archived: true,
        },
        {
          threadId: 'running-thread',
          title: 'Running thread',
          running: true,
        },
      ],
    })

    const buttons = await screen.findAllByTestId('local-codex-bind-button')

    expect(buttons).toHaveLength(2)
    expect(buttons[0]).toBeDisabled()
    expect(buttons[1]).toBeDisabled()
  })
})
