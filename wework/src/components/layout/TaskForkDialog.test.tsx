import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { TaskForkDialog } from './TaskForkDialog'
import type {
  DeviceInfo,
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

  test('only lists target workspaces from the source project', () => {
    render(
      <TaskForkDialog
        open
        source={source()}
        runtimeWork={{
          projects: [
            {
              project: { id: 7, name: 'Project' },
              deviceWorkspaces: [
                workspace({
                  localTasks: [
                    {
                      localTaskId: 'runtime-current',
                      workspacePath: '/workspace/current',
                      title: 'Current task',
                      runtime: 'codex',
                    },
                  ],
                }),
                workspace({
                  deviceId: 'local-2',
                  deviceName: 'Office Mac',
                  workspacePath: '/workspace/project-worktree',
                  workspaceKind: 'worktree',
                }),
              ],
              totalLocalTasks: 1,
            },
            {
              project: { id: 8, name: 'Other Project' },
              deviceWorkspaces: [
                workspace({
                  deviceId: 'other-device',
                  deviceName: 'Other Device',
                  workspacePath: '/workspace/unrelated',
                }),
              ],
              totalLocalTasks: 0,
            },
          ],
          unmappedDeviceWorkspaces: [
            workspace({
              deviceId: 'unmapped-device',
              deviceName: 'Unmapped Device',
              workspacePath: '/workspace/unmapped-history',
            }),
          ],
          totalLocalTasks: 1,
        }}
        currentProject={{ id: 7, name: 'Project', tasks: [] }}
        requiresStop={false}
        onOpenChange={vi.fn()}
        onStopCurrentResponse={vi.fn()}
        onFork={vi.fn()}
      />
    )

    expect(screen.getByTestId('task-fork-target-local-2')).toHaveTextContent(
      '/workspace/project-worktree'
    )
    expect(screen.getByTestId('task-fork-target-local-2')).toHaveTextContent('Worktree')
    expect(screen.queryByTestId('task-fork-target-other-device')).not.toBeInTheDocument()
    expect(screen.queryByTestId('task-fork-target-unmapped-device')).not.toBeInTheDocument()
  })

  test('binds an unbound device path to the current project before forking', async () => {
    const onPrepareDeviceWorkspace = vi.fn().mockResolvedValue({
      preparedAction: 'selected',
      mapping: {
        id: 99,
        userId: 1,
        projectId: 7,
        deviceId: 'local-3',
        workspacePath: '/home/alice/office-project',
        repoUrl: null,
        repoRootFingerprint: null,
        label: null,
        createdAt: '2026-06-22T00:00:00',
        updatedAt: '2026-06-22T00:00:00',
        lastSeenAt: null,
      },
    })
    const onFork = vi.fn().mockResolvedValue(undefined)

    render(
      <TaskForkDialog
        open
        source={source()}
        runtimeWork={runtimeWork([
          workspace({
            localTasks: [
              {
                localTaskId: 'runtime-current',
                workspacePath: '/workspace/current',
                title: 'Current task',
                runtime: 'codex',
              },
            ],
          }),
        ])}
        currentProject={{ id: 7, name: 'Project', tasks: [] }}
        devices={[
          device(),
          device({
            id: 3,
            device_id: 'local-3',
            name: 'Office Mac',
          }),
        ]}
        requiresStop={false}
        onOpenChange={vi.fn()}
        onStopCurrentResponse={vi.fn()}
        onFork={onFork}
        onPrepareDeviceWorkspace={onPrepareDeviceWorkspace}
        onGetDeviceHomeDirectory={vi.fn().mockResolvedValue('/home/alice')}
        onGetProjectWorkspaceRoot={vi.fn().mockResolvedValue('/workspace/projects')}
        onListDeviceDirectories={vi.fn().mockResolvedValue(['office-project'])}
        onCreateDeviceDirectory={vi.fn().mockResolvedValue(undefined)}
      />
    )

    await userEvent.click(screen.getByTestId('task-fork-bind-device-local-3'))
    expect(await screen.findByTestId('project-create-dialog')).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId('project-directory-path-input')).toHaveValue('/home/alice')
    )
    await userEvent.click(screen.getByTestId('project-workspace-kind-worktree'))
    await userEvent.click(await screen.findByText('office-project'))
    await userEvent.click(screen.getByTestId('create-project-button'))

    await waitFor(() =>
      expect(onPrepareDeviceWorkspace).toHaveBeenCalledWith({
        projectId: 7,
        deviceId: 'local-3',
        workspacePath: '/home/alice/office-project',
        action: 'select',
        label: 'worktree',
      })
    )
    expect(onFork).toHaveBeenCalledWith({
      deviceId: 'local-3',
      workspacePath: '/home/alice/office-project',
    })
  })
})
