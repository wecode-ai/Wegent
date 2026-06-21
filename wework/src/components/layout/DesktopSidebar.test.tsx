import { render, screen, waitFor } from '@testing-library/react'
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
    onPrepareDeviceWorkspace: vi.fn().mockResolvedValue({
      preparedAction: 'selected',
      mapping: {
        id: 19,
        userId: 1,
        projectId: 7,
        deviceId: 'local-device',
        workspacePath: '/Users/alice',
        repoUrl: null,
        repoRootFingerprint: null,
        label: null,
        createdAt: '2026-06-21T00:00:00',
        updatedAt: '2026-06-21T00:00:00',
        lastSeenAt: null,
      },
    }),
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

  test('opens add device settings from the sidebar device section', async () => {
    const props = renderSidebar()

    await userEvent.click(screen.getByTestId('sidebar-add-device-button'))

    expect(props.onOpenSettings).toHaveBeenCalledWith({
      autoOpenAddCloudDeviceDialog: true,
    })
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
    expect(screen.queryByTestId('runtime-local-task-device-marker-chat-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-local-task-device-icon-chat-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-workspace-row-/tmp/spike')).toHaveTextContent(
      'Local Mac /tmp/spike'
    )

    await userEvent.click(screen.getByTestId('runtime-local-task-row-chat-1'))

    expect(onOpenRuntimeLocalTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
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
    expect(screen.queryByTestId('runtime-local-task-device-marker-codex-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-local-task-device-icon-codex-1')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('runtime-local-task-row-codex-1'))

    expect(onOpenRuntimeLocalTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      localTaskId: 'codex-1',
    })
  })

  test('shows online device colors and marks runtime tasks by device', async () => {
    renderSidebar({
      devices: [
        localDevice(),
        localDevice({
          id: 2,
          device_id: 'cloud-device',
          name: 'Cloud Box',
          device_type: 'cloud',
        }),
        localDevice({
          id: 3,
          device_id: 'offline-device',
          name: 'Offline Box',
          status: 'offline',
        }),
      ],
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            totalLocalTasks: 2,
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
                    localTaskId: 'local-task',
                    workspacePath: '/repo/Wegent',
                    title: 'Local task',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T02:00:00Z',
                  },
                ],
              },
              {
                id: 92,
                deviceId: 'cloud-device',
                deviceName: 'Cloud Box',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                localTasks: [
                  {
                    localTaskId: 'cloud-task',
                    workspacePath: '/repo/Wegent',
                    title: 'Cloud task',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T03:00:00Z',
                  },
                ],
              },
            ],
          },
        ],
        unmappedDeviceWorkspaces: [],
        totalLocalTasks: 2,
      },
    })

    expect(screen.getByTestId('sidebar-online-devices')).toHaveTextContent('在线设备')
    expect(screen.getByTestId('sidebar-devices-section-toggle')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.getByTestId('sidebar-offline-devices-toggle').parentElement).toBe(
      screen.getByTestId('sidebar-devices-header')
    )
    expect(screen.getByTestId('sidebar-offline-devices-toggle')).toHaveTextContent('离线 1')
    expect(screen.queryByTestId('sidebar-online-device-local-device')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-online-device-offline-device')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(screen.queryByTestId('runtime-local-task-device-marker-local-task')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-local-task-device-marker-cloud-task')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('sidebar-devices-section-toggle'))

    expect(screen.getByTestId('sidebar-devices-section-toggle')).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByTestId('sidebar-online-device-local-device')).toHaveTextContent('Local Mac')
    expect(screen.getByTestId('sidebar-online-device-cloud-device')).toHaveTextContent('Cloud Box')

    const localLegendColor = screen.getByTestId('sidebar-online-device-color-local-device')
    const cloudLegendColor = screen.getByTestId('sidebar-online-device-color-cloud-device')
    const localTaskMarker = screen.getByTestId('runtime-local-task-device-marker-local-task')
    const cloudTaskMarker = screen.getByTestId('runtime-local-task-device-marker-cloud-task')

    expect(localTaskMarker).toHaveAttribute('title', 'Local Mac /repo/Wegent')
    expect(cloudTaskMarker).toHaveAttribute('title', 'Cloud Box /repo/Wegent')
    expect(localTaskMarker.style.backgroundColor).toBe(localLegendColor.style.backgroundColor)
    expect(cloudTaskMarker.style.backgroundColor).toBe(cloudLegendColor.style.backgroundColor)

    await userEvent.click(screen.getByTestId('sidebar-online-device-local-device'))

    expect(screen.getByTestId('sidebar-online-device-local-device')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('runtime-local-task-row-local-task')).toBeInTheDocument()
    expect(screen.queryByTestId('runtime-local-task-row-cloud-task')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('sidebar-online-device-local-device'))

    expect(screen.getByTestId('runtime-local-task-row-cloud-task')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('sidebar-offline-devices-toggle'))

    expect(screen.getByTestId('sidebar-online-device-offline-device')).toHaveTextContent(
      'Offline Box'
    )
    expect(screen.getByTestId('sidebar-offline-devices-toggle')).toHaveTextContent('收起离线')

    await userEvent.click(screen.getByTestId('sidebar-devices-section-toggle'))

    expect(screen.getByTestId('sidebar-devices-section-toggle')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByTestId('sidebar-online-device-local-device')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-local-task-device-marker-local-task')).not.toBeInTheDocument()
    expect(screen.getByTestId('sidebar-offline-devices-toggle')).toBeInTheDocument()
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
    expect(screen.queryByTestId('runtime-local-task-device-marker-codex-1')).not.toBeInTheDocument()
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
    expect(taskRow.className).toContain('color-sidebar-marked')
    expect(taskRow.className).toContain('color-sidebar-marked-hover')

    await user.click(screen.getByTestId('runtime-local-task-archive-codex-1'))

    expect(onArchiveRuntimeLocalTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      localTaskId: 'codex-1',
    })
  })

  test('shows a global IM notification quick toggle near settings', async () => {
    const user = userEvent.setup()
    const onToggleGlobalImNotification = vi.fn()

    renderSidebar({
      imNotificationSettings: {
        global: {
          enabled: false,
          sessionKey: 'session-telegram',
          session: {
            sessionKey: 'session-telegram',
            channelType: 'telegram',
            channelLabel: 'Telegram',
            channelId: 9,
            conversationId: 'telegram-1',
            senderId: '100200300',
            displayName: 'Alice',
          },
        },
        runtimeTaskSubscriptions: [],
      },
      onToggleGlobalImNotification,
    })

    const toggle = screen.getByTestId('sidebar-global-im-notification-button')

    expect(toggle).toHaveTextContent('IM通知')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(toggle).toHaveAttribute('title', expect.stringContaining('Telegram'))

    await user.click(toggle)

    expect(onToggleGlobalImNotification).toHaveBeenCalledTimes(1)
  })

  test('opens global IM notification channel settings separately from the quick toggle', async () => {
    const user = userEvent.setup()
    const onToggleGlobalImNotification = vi.fn()
    const onOpenGlobalImNotificationSettings = vi.fn()

    renderSidebar({
      imNotificationSettings: {
        global: {
          enabled: true,
          sessionKey: 'session-telegram',
          session: {
            sessionKey: 'session-telegram',
            channelType: 'telegram',
            channelLabel: 'Telegram',
            channelId: 9,
            conversationId: 'telegram-1',
            senderId: '100200300',
            displayName: 'Alice',
          },
        },
        runtimeTaskSubscriptions: [],
      },
      onToggleGlobalImNotification,
      onOpenGlobalImNotificationSettings,
    })

    await user.click(screen.getByTestId('sidebar-global-im-notification-settings-button'))

    expect(onOpenGlobalImNotificationSettings).toHaveBeenCalledTimes(1)
    expect(onToggleGlobalImNotification).not.toHaveBeenCalled()
  })

  test('edits an existing project by associating another device workspace', async () => {
    const user = userEvent.setup()
    const onCreateProject = vi.fn()
    const onPrepareDeviceWorkspace = vi.fn().mockResolvedValue({
      preparedAction: 'selected',
      mapping: {
        id: 20,
        userId: 1,
        projectId: 7,
        deviceId: 'second-device',
        workspacePath: '/Users/alice',
        repoUrl: null,
        repoRootFingerprint: null,
        label: null,
        createdAt: '2026-06-21T00:00:00',
        updatedAt: '2026-06-21T00:00:00',
        lastSeenAt: null,
      },
    })

    renderSidebar({
      devices: [
        localDevice(),
        localDevice({
          id: 2,
          device_id: 'second-device',
          name: 'Second Mac',
          is_default: false,
        }),
      ],
      onCreateProject,
      onPrepareDeviceWorkspace,
      onGetDeviceHomeDirectory: vi.fn().mockResolvedValue('/Users/alice'),
    })

    await user.click(screen.getByTestId('project-menu-7'))
    await user.click(screen.getByTestId('edit-project-7'))

    const deviceSelect = await screen.findByTestId('project-device-select')
    await user.selectOptions(deviceSelect, 'second-device')
    await user.click(screen.getByTestId('create-project-button'))

    await waitFor(() =>
      expect(onPrepareDeviceWorkspace).toHaveBeenCalledWith({
        projectId: 7,
        deviceId: 'second-device',
        workspacePath: '/Users/alice',
        action: 'select',
      })
    )
    expect(onCreateProject).not.toHaveBeenCalled()
  })

  test('shows a subscribed runtime task notification toggle outside hover actions', async () => {
    const user = userEvent.setup()
    const onToggleRuntimeTaskNotification = vi.fn()
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
      imNotificationSettings: {
        global: {
          enabled: true,
          sessionKey: 'session-telegram',
          session: null,
        },
        runtimeTaskSubscriptions: [
          {
            address: {
              deviceId: 'local-device',
              localTaskId: 'codex-1',
            },
            sessionKeys: ['session-telegram'],
          },
        ],
      },
      onOpenRuntimeLocalTask,
      onToggleRuntimeTaskNotification,
    })

    await user.click(screen.getByTestId('project-item-button'))

    const toggle = screen.getByTestId('runtime-local-task-notify-codex-1')
    const hoverActions = screen.getByTestId('runtime-local-task-hover-actions-codex-1')

    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(hoverActions).not.toContainElement(toggle)
    expect(screen.getByTestId('runtime-local-task-notify-icon-codex-1')).toHaveClass('fill-current')

    await user.click(toggle)

    expect(onToggleRuntimeTaskNotification).toHaveBeenCalledWith(
      {
        deviceId: 'local-device',
        localTaskId: 'codex-1',
      },
      true
    )
    expect(onOpenRuntimeLocalTask).not.toHaveBeenCalled()
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

  test('shows managed worktree tasks directly under the source project with device marker', async () => {
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
    expect(
      screen.queryByTestId('runtime-local-task-device-marker-codex-worktree')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('runtime-local-task-device-icon-codex-worktree')
    ).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('runtime-local-task-row-codex-worktree'))

    expect(onOpenRuntimeLocalTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
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
