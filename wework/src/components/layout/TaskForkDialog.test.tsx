import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import { TaskForkDialog } from './TaskForkDialog'
import type {
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
} from '@/types/api'

function source(overrides: Partial<RuntimeTaskAddress> = {}): RuntimeTaskAddress {
  return {
    deviceId: 'local-1',
    workspacePath: '/workspace/current',
    localTaskId: 'runtime-current',
    ...overrides,
  }
}

function workspace(overrides: Partial<RuntimeDeviceWorkspace> = {}): RuntimeDeviceWorkspace {
  return {
    deviceId: 'local-1',
    deviceName: 'This Mac',
    deviceStatus: 'online',
    available: true,
    workspacePath: '/workspace/current',
    localTasks: [],
    ...overrides,
  }
}

function runtimeWork(workspaces: RuntimeDeviceWorkspace[]): RuntimeWorkListResponse {
  return {
    projects: [
      {
        project: { id: 7, name: 'Project' },
        deviceWorkspaces: workspaces,
        totalLocalTasks: workspaces.reduce(
          (total, deviceWorkspace) => total + deviceWorkspace.localTasks.length,
          0
        ),
      },
    ],
    unmappedDeviceWorkspaces: [],
    totalLocalTasks: 0,
  }
}

describe('TaskForkDialog', () => {
  test('stops the current response before forking a running runtime task', async () => {
    const onStopCurrentResponse = vi.fn().mockResolvedValue(undefined)
    const onFork = vi.fn().mockResolvedValue(undefined)

    render(
      <TaskForkDialog
        open
        source={source()}
        runtimeWork={runtimeWork([
          workspace(),
          workspace({
            deviceId: 'local-2',
            deviceName: 'Office Mac',
            workspacePath: '/workspace/current',
          }),
        ])}
        requiresStop
        onOpenChange={vi.fn()}
        onStopCurrentResponse={onStopCurrentResponse}
        onFork={onFork}
      />
    )

    await userEvent.click(screen.getByTestId('task-fork-confirm-button'))

    await waitFor(() => expect(onStopCurrentResponse).toHaveBeenCalled())
    expect(onFork).toHaveBeenCalledWith({
      deviceId: 'local-2',
      workspacePath: '/workspace/current',
    })
  })

  test('disables the current runtime workspace and uses an available target', async () => {
    const onFork = vi.fn().mockResolvedValue(undefined)

    render(
      <TaskForkDialog
        open
        source={source()}
        runtimeWork={runtimeWork([
          workspace(),
          workspace({
            deviceId: 'local-2',
            deviceName: 'Office Mac',
            workspacePath: '/workspace/target',
          }),
        ])}
        requiresStop={false}
        onOpenChange={vi.fn()}
        onStopCurrentResponse={vi.fn()}
        onFork={onFork}
      />
    )

    expect(screen.getByTestId('task-fork-target-local-1')).toBeDisabled()

    await userEvent.click(screen.getByTestId('task-fork-confirm-button'))

    await waitFor(() =>
      expect(onFork).toHaveBeenCalledWith({
        deviceId: 'local-2',
        workspacePath: '/workspace/target',
      })
    )
  })
})
