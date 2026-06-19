import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { TaskForkDialog } from './TaskForkDialog'
import type { DeviceInfo, Task } from '@/types/api'

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 42,
    title: 'Source task',
    status: 'RUNNING',
    task_type: 'code',
    device_id: 'local-1',
    execution_workspace_source: 'git',
    created_at: '2026-06-04T00:00:00.000Z',
    ...overrides,
  }
}

function device(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 1,
    device_id: 'local-1',
    name: 'This Mac',
    status: 'online',
    is_default: false,
    device_type: 'local',
    bind_shell: 'claudecode',
    executor_version: '1.8.5',
    ...overrides,
  }
}

describe('TaskForkDialog', () => {
  test('stops the current response before forking a running task', async () => {
    const onStopCurrentResponse = vi.fn().mockResolvedValue(undefined)
    const onFork = vi.fn().mockResolvedValue(undefined)

    render(
      <TaskForkDialog
        open
        task={task()}
        devices={[device()]}
        activeDeviceId="local-1"
        requiresStop
        onOpenChange={vi.fn()}
        onStopCurrentResponse={onStopCurrentResponse}
        onFork={onFork}
      />
    )

    await userEvent.click(screen.getByTestId('task-fork-confirm-button'))

    await waitFor(() => expect(onStopCurrentResponse).toHaveBeenCalled())
    expect(onFork).toHaveBeenCalledWith({ target: { type: 'managed' } })
  })

  test('uses an available local device when cloud is unavailable for local path tasks', async () => {
    const onFork = vi.fn().mockResolvedValue(undefined)

    render(
      <TaskForkDialog
        open
        task={task({ execution_workspace_source: 'local_path' })}
        devices={[
          device(),
          device({
            id: 2,
            device_id: 'local-2',
            name: 'Office Mac',
          }),
        ]}
        activeDeviceId="local-1"
        requiresStop={false}
        onOpenChange={vi.fn()}
        onStopCurrentResponse={vi.fn()}
        onFork={onFork}
      />
    )

    expect(screen.getByTestId('task-fork-target-managed')).toBeDisabled()

    await userEvent.click(screen.getByTestId('task-fork-confirm-button'))

    await waitFor(() =>
      expect(onFork).toHaveBeenCalledWith({
        target: { type: 'device', device_id: 'local-2' },
      })
    )
  })
})
