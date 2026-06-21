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

    expect(screen.getByTestId('runtime-workspace-row-/tmp/spike')).toHaveTextContent(
      'Local Mac /tmp/spike'
    )
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

  test('renders unmapped chat runtime tasks as conversations instead of workspace groups', async () => {
    const onOpenRuntimeLocalTask = vi.fn()
    const chatPath = '/Users/alice/.wecode/wegent-executor/workspace/chats/2026-06-20/hi-1'

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
            workspacePath: chatPath,
            workspaceKind: 'chat',
            localTasks: [
              {
                localTaskId: 'chat-1',
                workspacePath: chatPath,
                workspaceKind: 'chat',
                title: 'hi',
                runtime: 'codex',
              },
            ],
          },
          {
            deviceId: 'local-device',
            deviceName: 'Local Mac',
            deviceStatus: 'online',
            available: true,
            workspacePath: '/tmp/spike',
            localTasks: [
              {
                localTaskId: 'workspace-1',
                workspacePath: '/tmp/spike',
                title: 'Spike runtime task',
                runtime: 'claude_code',
              },
            ],
          },
        ],
        totalLocalTasks: 2,
      },
      onOpenRuntimeLocalTask,
    })

    expect(screen.getByTestId('runtime-chat-section')).toHaveTextContent('对话')
    expect(screen.queryByTestId(`runtime-workspace-row-${chatPath}`)).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-row-chat-1')).toHaveTextContent('hi')
    expect(screen.getByTestId('runtime-local-task-device-icon-chat-1')).toHaveAttribute(
      'title',
      `Local Mac ${chatPath}`
    )
    expect(screen.getByTestId('runtime-workspace-row-/tmp/spike')).toHaveTextContent(
      'Local Mac /tmp/spike'
    )

    await userEvent.click(screen.getByTestId('runtime-local-task-row-chat-1'))

    expect(onOpenRuntimeLocalTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      workspacePath: chatPath,
      localTaskId: 'chat-1',
    })
  })

  test('renders project runtime tasks directly under projects and opens by address', async () => {
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

    expect(screen.queryByTestId('runtime-workspace-row-91')).not.toBeInTheDocument()
    const taskRow = screen.getByTestId('runtime-local-task-row-codex-1')
    expect(taskRow).toHaveTextContent('Fix reconnect')
    expect(taskRow).not.toHaveTextContent('Codex')
    expect(screen.getByTestId('runtime-local-task-device-icon-codex-1')).toHaveAttribute(
      'title',
      'Local Mac /repo/Wegent'
    )

    await userEvent.click(screen.getByTestId('runtime-local-task-row-codex-1'))

    expect(onOpenRuntimeLocalTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      workspacePath: '/repo/Wegent',
      localTaskId: 'codex-1',
    })
  })

  test('shows hover actions to mark and archive project runtime tasks', async () => {
    const user = userEvent.setup()
    const onArchiveRuntimeLocalTask = vi.fn().mockResolvedValue(undefined)

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
      onArchiveRuntimeLocalTask,
    })

    await user.click(screen.getByTestId('project-item-button'))
    const taskRow = screen.getByTestId('runtime-local-task-row-codex-1')
    const rowChildren = Array.from(taskRow.children)

    expect(screen.getByTestId('runtime-local-task-mark-codex-1')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-archive-codex-1')).toBeInTheDocument()
    expect(rowChildren).toHaveLength(2)
    expect(rowChildren[1]).toHaveAttribute('data-testid', 'runtime-local-task-trailing-codex-1')
    expect(screen.getByTestId('runtime-local-task-time-codex-1').parentElement).toBe(rowChildren[1])
    expect(screen.getByTestId('runtime-local-task-hover-actions-codex-1').parentElement).toBe(
      rowChildren[1]
    )
    expect(screen.getByTestId('runtime-local-task-pin-icon-codex-1')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-archive-icon-codex-1')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-hover-actions-codex-1').className).not.toContain(
      'focus-within'
    )
    expect(screen.getByTestId('runtime-local-task-time-codex-1').className).not.toContain(
      'focus-within'
    )

    await user.click(screen.getByTestId('runtime-local-task-mark-codex-1'))

    expect(taskRow).toHaveAttribute('data-marked', 'true')
    expect(taskRow.className).toContain('FFF4D6')
    expect(taskRow.className).toContain('FFE8A3')

    await user.click(screen.getByTestId('runtime-local-task-archive-codex-1'))

    expect(onArchiveRuntimeLocalTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      workspacePath: '/repo/Wegent',
      localTaskId: 'codex-1',
    })
  })

  test('shows an empty task state when a project has no local tasks', async () => {
    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            totalLocalTasks: 0,
            deviceWorkspaces: [
              {
                id: 92,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                label: 'Duplicated project label should not hide the path',
                localTasks: [],
              },
            ],
          },
        ],
        unmappedDeviceWorkspaces: [],
        totalLocalTasks: 0,
      },
    })

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(screen.queryByTestId('runtime-workspace-row-92')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-local-tasks-empty-7')).toHaveTextContent('暂无会话')
  })

  test('shows managed worktree tasks directly under the source project with icons', async () => {
    const onOpenRuntimeLocalTask = vi.fn()

    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            totalLocalTasks: 1,
            deviceWorkspaces: [
              {
                id: null,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/workspace/Wegent',
                localTasks: [
                  {
                    localTaskId: 'codex-worktree',
                    workspacePath: '/workspace/worktrees/42/Wegent',
                    workspaceKind: 'worktree',
                    worktreeId: '42',
                    title: 'Fix worktree sidebar',
                    runtime: 'codex',
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

    expect(screen.queryByTestId('runtime-workspace-row-/workspace/Wegent')).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-row-codex-worktree')).toHaveTextContent(
      'Fix worktree sidebar'
    )
    expect(screen.getByTestId('runtime-local-task-row-codex-worktree')).not.toHaveTextContent(
      'Codex'
    )
    expect(
      screen.getByTestId('runtime-local-task-worktree-icon-codex-worktree')
    ).toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-device-icon-codex-worktree')).toHaveAttribute(
      'title',
      'Local Mac /workspace/Wegent'
    )

    await userEvent.click(screen.getByTestId('runtime-local-task-row-codex-worktree'))

    expect(onOpenRuntimeLocalTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      workspacePath: '/workspace/worktrees/42/Wegent',
      localTaskId: 'codex-worktree',
    })
  })

  test('limits project runtime tasks to five rows and toggles the rest by updated time', async () => {
    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            totalLocalTasks: 6,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                localTasks: [
                  {
                    localTaskId: 'task-oldest',
                    workspacePath: '/repo/Wegent',
                    title: 'Oldest hidden task',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T01:00:00Z',
                  },
                  {
                    localTaskId: 'task-third',
                    workspacePath: '/repo/Wegent',
                    title: 'Third task',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T04:00:00Z',
                  },
                  {
                    localTaskId: 'task-newest',
                    workspacePath: '/repo/Wegent',
                    title: 'Newest task',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T06:00:00Z',
                  },
                  {
                    localTaskId: 'task-fifth',
                    workspacePath: '/repo/Wegent',
                    title: 'Fifth task',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T02:00:00Z',
                  },
                  {
                    localTaskId: 'task-second',
                    workspacePath: '/repo/Wegent',
                    title: 'Second task',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T05:00:00Z',
                  },
                  {
                    localTaskId: 'task-fourth',
                    workspacePath: '/repo/Wegent',
                    title: 'Fourth task',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T03:00:00Z',
                  },
                ],
              },
            ],
          },
        ],
        unmappedDeviceWorkspaces: [],
        totalLocalTasks: 6,
      },
    })

    await userEvent.click(screen.getByTestId('project-item-button'))

    const collapsedRows = screen.getAllByTestId(/^runtime-local-task-row-/)
    expect(collapsedRows).toHaveLength(5)
    expect(collapsedRows.map(row => row.textContent)).toEqual([
      expect.stringContaining('Newest task'),
      expect.stringContaining('Second task'),
      expect.stringContaining('Third task'),
      expect.stringContaining('Fourth task'),
      expect.stringContaining('Fifth task'),
    ])
    expect(screen.queryByText('Oldest hidden task')).not.toBeInTheDocument()

    expect(screen.getByTestId('project-runtime-tasks-expand-7')).toHaveTextContent('展开显示')

    await userEvent.click(screen.getByTestId('project-runtime-tasks-expand-7'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(6)
    expect(screen.getByText('Oldest hidden task')).toBeInTheDocument()
    expect(screen.getByTestId('project-runtime-tasks-collapse-7')).toHaveTextContent('折叠显示')

    await userEvent.click(screen.getByTestId('project-runtime-tasks-collapse-7'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(5)
    expect(screen.queryByText('Oldest hidden task')).not.toBeInTheDocument()
  })

  test('selects a project when its sidebar row is clicked', async () => {
    const onSelectProject = vi.fn()

    renderSidebar({ onSelectProject })

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(onSelectProject).toHaveBeenCalledWith(7)
  })
})
