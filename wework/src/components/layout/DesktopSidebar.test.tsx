import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { DesktopSidebar } from './DesktopSidebar'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'

function localDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    id: 1,
    device_id: 'local-device',
    name: 'Local Mac',
    status: 'online',
    is_default: true,
    device_type: 'local',
    bind_shell: 'claudecode',
    executor_version: '1.8.5',
    ...overrides,
  }
}

function project(overrides: Partial<ProjectWithTasks> = {}): ProjectWithTasks {
  return {
    id: 7,
    name: 'Wegent',
    tasks: [],
    ...overrides,
  }
}

function renderSidebar(overrides: Partial<Parameters<typeof DesktopSidebar>[0]> = {}) {
  const props: Parameters<typeof DesktopSidebar>[0] = {
    user: { id: 1, user_name: 'alice', email: 'alice@example.com' },
    projects: [project()],
    devices: [localDevice()],
    onCollapse: vi.fn(),
    onNewChat: vi.fn(),
    onSelectProject: vi.fn(),
    onStartNewProjectChat: vi.fn(),
    onOpenPlugins: vi.fn(),
    onCreateProject: vi.fn(),
    onCreateGitWorkspaceProject: vi.fn(),
    onListGitRepositories: vi.fn().mockResolvedValue([]),
    onListGitBranches: vi.fn().mockResolvedValue([]),
    onUpdateProjectName: vi.fn(),
    onRemoveProject: vi.fn(),
    onGetDeviceHomeDirectory: vi.fn().mockResolvedValue('/Users/alice'),
    onGetProjectWorkspaceRoot: vi.fn().mockResolvedValue('/Users/alice/dev'),
    onListDeviceDirectories: vi.fn().mockResolvedValue([]),
    onCreateDeviceDirectory: vi.fn(),
    onOpenSettings: vi.fn(),
    onLogout: vi.fn(),
    ...overrides,
  }

  render(<DesktopSidebar {...props} />)
  return props
}

describe('DesktopSidebar', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test('renders unmapped device runtime tasks without local Codex import UI', async () => {
    const onOpenRuntimeLocalTask = vi.fn()

    renderSidebar({
      projects: [],
      runtimeWork: {
        projects: [],
        unmappedDeviceWorkspaces: [
          {
            deviceId: 'local-device',
            deviceName: 'Local Mac',
            deviceStatus: 'online',
            available: true,
            workspacePath: '/tmp/spike',
            localTasks: [
              {
                localTaskId: 'claude-1',
                workspacePath: '/tmp/spike',
                title: 'Spike runtime task',
                runtime: 'claude_code',
              },
            ],
          },
        ],
        totalLocalTasks: 1,
      },
      onOpenRuntimeLocalTask,
    })

    expect(screen.getByTestId('runtime-workspace-row-/tmp/spike')).toHaveTextContent('spike')
    expect(screen.getByTestId('runtime-local-task-row-claude-1')).toHaveTextContent(
      'Spike runtime task'
    )

    await userEvent.click(screen.getByTestId('runtime-local-task-row-claude-1'))

    expect(onOpenRuntimeLocalTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      workspacePath: '/tmp/spike',
      localTaskId: 'claude-1',
    })
  })

  test('renders runtime workspaces under projects and opens local tasks by address', async () => {
    const onOpenRuntimeLocalTask = vi.fn()

    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            totalLocalTasks: 1,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                label: 'Wegent local',
                localTasks: [
                  {
                    localTaskId: 'codex-1',
                    workspacePath: '/repo/Wegent',
                    title: 'Fix reconnect',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T02:00:00Z',
                  },
                ],
              },
            ],
          },
        ],
        unmappedDeviceWorkspaces: [],
        totalLocalTasks: 1,
      },
      onOpenRuntimeLocalTask,
    })

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(screen.getByTestId('runtime-workspace-row-91')).toHaveTextContent('Wegent local')
    expect(screen.getByTestId('runtime-local-task-row-codex-1')).toHaveTextContent('Fix reconnect')

    await userEvent.click(screen.getByTestId('runtime-local-task-row-codex-1'))

    expect(onOpenRuntimeLocalTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      workspacePath: '/repo/Wegent',
      localTaskId: 'codex-1',
    })
  })
})
