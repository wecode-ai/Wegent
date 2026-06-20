import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { LocalCodexThreadImportDialog } from './LocalCodexThreadImportDialog'
import type { DeviceInfo, LocalCodexThreadSummary, ProjectWithTasks } from '@/types/api'

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
  projects = [],
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
  projects?: ProjectWithTasks[]
  threads?: LocalCodexThreadSummary[]
  onListLocalCodexThreads?: (deviceId: string) => Promise<LocalCodexThreadSummary[]>
  onBindLocalCodexThread?: Parameters<typeof LocalCodexThreadImportDialog>[0]['onBindLocalCodexThread']
} = {}) {
  render(
    <LocalCodexThreadImportDialog
      open
      devices={devices}
      projects={projects}
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

  test('shows device-first sessions and switches project groups by device', async () => {
    const onListLocalCodexThreads = vi.fn((deviceId: string) => {
      if (deviceId === 'local-b') {
        return Promise.resolve([
          {
            threadId: 'thread-b-1',
            title: 'B Docs task',
            cwd: '/workspace/Docs',
            updatedAt: '2026-06-20T11:00:00Z',
          },
          {
            threadId: 'thread-b-2',
            title: 'B unmatched task',
            cwd: '/tmp/b',
          },
        ])
      }

      return Promise.resolve([
        {
          threadId: 'thread-a-1',
          title: 'A Wegent task',
          cwd: '/workspace/Wegent',
          updatedAt: '2026-06-20T10:00:00Z',
        },
      ])
    })

    renderDialog({
      devices: [
        localDevice({ device_id: 'local-a', name: 'Local A' }),
        localDevice({ device_id: 'local-b', name: 'Local B' }),
      ],
      projects: [
        {
          id: 7,
          name: 'Wegent',
          config: {
            mode: 'workspace',
            workspace: { source: 'local_path', localPath: '/workspace/Wegent' },
          },
          tasks: [],
        },
        {
          id: 8,
          name: 'Docs',
          config: {
            mode: 'workspace',
            workspace: { source: 'local_path', localPath: '/workspace/Docs' },
          },
          tasks: [],
        },
      ],
      onListLocalCodexThreads,
    })

    expect(onListLocalCodexThreads).toHaveBeenCalledWith('local-a')
    await waitFor(() => expect(onListLocalCodexThreads).toHaveBeenCalledWith('local-b'))

    expect(screen.getByTestId('local-codex-device-card-local-a')).toHaveTextContent(
      '1',
    )
    expect(screen.getByTestId('local-codex-device-card-local-b')).toHaveTextContent(
      '2',
    )
    expect(await screen.findByTestId('local-codex-project-group-7')).toHaveTextContent(
      'A Wegent task',
    )
    expect(screen.queryByText('B Docs task')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('local-codex-device-card-local-b'))

    expect(await screen.findByTestId('local-codex-project-group-8')).toHaveTextContent(
      'B Docs task',
    )
    expect(screen.getByTestId('local-codex-project-group-unmatched')).toHaveTextContent(
      'B unmatched task',
    )
    expect(screen.queryByText('A Wegent task')).not.toBeInTheDocument()
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

  test('groups local Codex threads by matching project', async () => {
    renderDialog({
      projects: [
        {
          id: 7,
          name: 'Wegent',
          config: {
            mode: 'workspace',
            execution: { targetType: 'local', deviceId: 'local-device' },
            workspace: {
              source: 'local_path',
              localPath: '/Users/alice/dev/Wegent',
            },
          },
          tasks: [],
        },
      ],
      threads: [
        {
          threadId: 'thread-1',
          title: 'Source checkout task',
          cwd: '/Users/alice/dev/Wegent',
        },
        {
          threadId: 'thread-2',
          title: 'Worktree task',
          cwd: '/Users/alice/.codex/worktrees/2381/Wegent',
        },
        {
          threadId: 'thread-3',
          title: 'Unknown task',
          cwd: '/tmp/unknown',
        },
      ],
    })

    expect(await screen.findByTestId('local-codex-project-group-7')).toHaveTextContent('Wegent')
    const wegentGroup = screen.getByTestId('local-codex-project-group-7')
    expect(wegentGroup).toHaveTextContent('Source checkout task')
    expect(wegentGroup).toHaveTextContent('Worktree task')
    expect(screen.getByTestId('local-codex-project-group-unmatched')).toHaveTextContent(
      'Unknown task',
    )
  })
})
