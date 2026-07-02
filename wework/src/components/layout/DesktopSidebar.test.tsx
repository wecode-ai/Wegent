import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { DesktopSidebar } from './DesktopSidebar'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'
import type { CloudWorkStatus } from '@/types/workbench'
import {
  CloudConnectionContext,
  DISCONNECTED_STATE,
} from '@/features/cloud-connection/CloudConnectionContext'
import type { CloudConnectionContextValue } from '@/features/cloud-connection/CloudConnectionContext'

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

function cloudWorkStatus(
  overrides: Partial<CloudWorkStatus> & { checks?: Partial<CloudWorkStatus['checks']> } = {}
): CloudWorkStatus {
  const defaultStatus: CloudWorkStatus = {
    availability: 'available',
    checks: {
      teams: 'available',
      devices: 'available',
      runtimeWork: 'available',
    },
    error: null,
    updatedAt: '2026-06-26T00:00:00.000Z',
  }
  return {
    ...defaultStatus,
    ...overrides,
    checks: {
      ...defaultStatus.checks,
      ...overrides.checks,
    },
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

function renderSidebar(
  overrides: Partial<Parameters<typeof DesktopSidebar>[0]> = {},
  cloudConnection?: Partial<CloudConnectionContextValue>
) {
  const props: Parameters<typeof DesktopSidebar>[0] = {
    user: { id: 1, user_name: 'alice', email: 'alice@example.com' },
    projects: [project()],
    devices: [localDevice()],
    onNewChat: vi.fn(),
    onOpenSearch: vi.fn(),
    onSelectProject: vi.fn(),
    onStartNewProjectChat: vi.fn(),
    onOpenPlugins: vi.fn(),
    onUpdateProjectName: vi.fn(),
    onRemoveProject: vi.fn(),
    onGetDeviceHomeDirectory: vi.fn().mockResolvedValue('/Users/alice'),
    onListDeviceDirectories: vi.fn().mockResolvedValue([]),
    onCreateDeviceDirectory: vi.fn(),
    onOpenSettings: vi.fn(),
    onLogout: vi.fn(),
    ...overrides,
  }

  const tree = <DesktopSidebar {...props} />
  if (cloudConnection) {
    const value: CloudConnectionContextValue = {
      ...DISCONNECTED_STATE,
      isConnected: false,
      serviceKey: 'test-disconnected',
      connectWithPassword: vi.fn(),
      setupAdminPassword: vi.fn(),
      refreshUser: vi.fn(),
      disconnect: vi.fn(),
      ...cloudConnection,
    }
    return render(
      <CloudConnectionContext.Provider value={value}>{tree}</CloudConnectionContext.Provider>
    )
  }
  return render(tree)
}

function enableTauri() {
  Object.defineProperty(window, '__TAURI_INTERNALS__', {
    configurable: true,
    value: {},
  })
}

describe('DesktopSidebar', () => {
  beforeEach(() => {
    localStorage.clear()
    enableTauri()
    Element.prototype.scrollIntoView = vi.fn()
  })

  test('keeps section header actions out of the flex layout while hidden', () => {
    renderSidebar()

    const actions = screen.getByTestId('projects-section-toggle-actions')

    expect(actions).toHaveClass(
      'absolute',
      'right-2.5',
      'z-[70]',
      'pointer-events-none',
      'opacity-0'
    )
    expect(screen.getByTestId('projects-create-button')).toBeInTheDocument()
  })

  test('keeps the settings row notification bell inside the sidebar width', () => {
    renderSidebar()

    expect(screen.getByTestId('settings-button')).toHaveClass('min-w-0', 'flex-1')
    expect(screen.getByTestId('settings-button')).not.toHaveClass('w-full', 'shrink-0')
    expect(screen.getByTestId('sidebar-global-im-notification-button')).toHaveClass(
      'h-8',
      'w-8',
      'shrink-0'
    )
  })

  test('keeps the resize handle hit area on the sidebar edge', () => {
    renderSidebar()

    const handle = screen.getByTestId('sidebar-resize-handle')

    expect(handle).toHaveClass('right-[-14px]', 'w-[18px]')
    expect(handle).not.toHaveClass('w-10')
  })

  test('does not render non-chat runtime workspace groups', async () => {
    const onOpenRuntimeLocalTask = vi.fn()

    renderSidebar({
      projects: [],
      runtimeWork: {
        projects: [],
        chats: [
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

    expect(screen.queryByTestId('non-chat-runtime-section')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-workspace-row-/tmp/spike')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-local-task-row-claude-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-chat-section')).toHaveTextContent('对话')
    expect(screen.getByTestId('runtime-chat-section-toggle')).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByTestId('runtime-chat-empty')).toHaveTextContent('暂无会话')

    await userEvent.click(screen.getByTestId('runtime-chat-section-toggle'))

    expect(screen.getByTestId('runtime-chat-section-toggle')).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByTestId('runtime-chat-empty')).not.toBeInTheDocument()
    expect(onOpenRuntimeLocalTask).not.toHaveBeenCalled()
  })

  test('opens runtime search from the sidebar', async () => {
    const onOpenSearch = vi.fn()
    renderSidebar({ onOpenSearch })

    await userEvent.click(screen.getByTestId('runtime-search-button'))

    expect(onOpenSearch).toHaveBeenCalledTimes(1)
  })

  test('places the cloud connection entry next to the primary sidebar actions', () => {
    renderSidebar()

    const searchButton = screen.getByTestId('runtime-search-button')
    const cloudButton = screen.getByTestId('sidebar-cloud-connection-button')
    const projectsHeader = screen.getByTestId('projects-section-toggle')

    expect(searchButton.compareDocumentPosition(cloudButton)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(cloudButton.compareDocumentPosition(projectsHeader)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  test('selects the first available cloud device when cloud is connected', async () => {
    const onSelectStandaloneDevice = vi.fn()
    renderSidebar({
      devices: [
        localDevice(),
        localDevice({
          id: 2,
          device_id: 'cloud-device',
          name: 'Cloud Box',
          device_type: 'cloud',
        }),
      ],
      onSelectStandaloneDevice,
    })

    await userEvent.click(screen.getByTestId('sidebar-cloud-connection-button'))

    expect(onSelectStandaloneDevice).toHaveBeenCalledWith('cloud-device')
    expect(screen.queryByTestId('standalone-folder-project-dialog')).not.toBeInTheDocument()
    expect(screen.queryByTestId('cloud-connection-dialog')).not.toBeInTheDocument()
  })

  test('shows cloud work availability on the sidebar entry', () => {
    renderSidebar({
      devices: [
        localDevice(),
        localDevice({
          id: 2,
          device_id: 'cloud-device',
          name: 'Cloud Box',
          device_type: 'cloud',
        }),
      ],
      cloudWorkStatus: cloudWorkStatus({ availability: 'available' }),
    })

    const cloudButton = screen.getByTestId('sidebar-cloud-connection-button')

    expect(cloudButton).toHaveTextContent('云端工作')
    expect(cloudButton).toHaveTextContent('可用')
  })

  test('shows cloud work unavailable when background cloud reads fail', () => {
    renderSidebar({
      devices: [localDevice()],
      cloudWorkStatus: cloudWorkStatus({
        availability: 'unavailable',
        checks: { devices: 'unavailable' },
        error: '云端设备: request timed out',
      }),
    })

    const cloudButton = screen.getByTestId('sidebar-cloud-connection-button')

    expect(cloudButton).toHaveTextContent('云端工作')
    expect(cloudButton).toHaveTextContent('不可用')
    expect(cloudButton).toHaveAttribute('title', expect.stringContaining('request timed out'))
  })

  test('opens cloud work error details from the warning icon', async () => {
    renderSidebar({
      devices: [localDevice()],
      cloudWorkStatus: cloudWorkStatus({
        availability: 'unavailable',
        checks: { devices: 'unavailable', runtimeWork: 'available' },
        error: '云端设备: request timed out',
      }),
    })

    await userEvent.click(screen.getByTestId('sidebar-cloud-error-button'))

    const detail = screen.getByTestId('sidebar-cloud-error-popover')
    expect(detail).toHaveTextContent('云端工作不可用')
    expect(detail).toHaveTextContent('云端设备: request timed out')
    expect(detail).toHaveTextContent('云端设备')
    expect(detail).toHaveTextContent('不可用')
    expect(detail).toHaveTextContent('云端任务列表')
    expect(detail).toHaveTextContent('可用')
  })

  test('does not open add-device guidance while cloud work checks are failing', async () => {
    const onGetRemoteDeviceStartupCommand = vi.fn()
    renderSidebar({
      devices: [localDevice()],
      onGetRemoteDeviceStartupCommand,
      cloudWorkStatus: cloudWorkStatus({
        availability: 'unavailable',
        checks: { devices: 'unavailable' },
        error: '云端设备: request timed out',
      }),
    })

    await userEvent.click(screen.getByTestId('sidebar-cloud-connection-button'))

    expect(screen.getByTestId('sidebar-cloud-error-popover')).toHaveTextContent(
      '云端设备: request timed out'
    )
    expect(screen.queryByTestId('standalone-folder-project-dialog')).not.toBeInTheDocument()
    expect(onGetRemoteDeviceStartupCommand).not.toHaveBeenCalled()
  })

  test('treats an empty cloud device list as an add-device state instead of an error', async () => {
    const onGetRemoteDeviceStartupCommand = vi.fn().mockResolvedValue({
      device_id: 'remote-device',
      name: 'alice-remote-device',
      image: 'ghcr.io/wecode-ai/wegent-device:latest',
      env: {},
      command:
        'docker run -d -e DEVICE_TYPE=remote -e EXECUTOR_MODE=local ghcr.io/wecode-ai/wegent-device:latest',
      commands: [
        {
          kind: 'docker',
          label: 'Docker',
          description: 'Run in Docker.',
          command:
            'docker run -d -e DEVICE_TYPE=remote -e EXECUTOR_MODE=local ghcr.io/wecode-ai/wegent-device:latest',
        },
        {
          kind: 'process',
          label: '宿主机启动',
          description: 'Run as a local process.',
          command:
            'DEVICE_TYPE=remote EXECUTOR_MODE=local WEGENT_BACKEND_URL=http://backend wegent-executor',
        },
      ],
    })
    renderSidebar({
      devices: [localDevice()],
      onGetRemoteDeviceStartupCommand,
      cloudWorkStatus: cloudWorkStatus({
        availability: 'empty',
        checks: { devices: 'empty' },
      }),
    })

    expect(screen.queryByTestId('sidebar-cloud-error-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('sidebar-cloud-connection-button')).toHaveTextContent('无设备')

    await userEvent.click(screen.getByTestId('sidebar-cloud-connection-button'))

    expect(screen.getByTestId('standalone-folder-project-dialog')).toHaveTextContent('添加新设备')
    await waitFor(() => expect(onGetRemoteDeviceStartupCommand).toHaveBeenCalledTimes(1))
  })

  test('shows Docker and process startup scripts when no cloud device is available', async () => {
    const onGetRemoteDeviceStartupCommand = vi.fn().mockResolvedValue({
      device_id: 'remote-device',
      name: 'alice-remote-device',
      image: 'ghcr.io/wecode-ai/wegent-device:latest',
      env: {},
      command:
        'docker run -d -e DEVICE_TYPE=remote -e EXECUTOR_MODE=local ghcr.io/wecode-ai/wegent-device:latest',
      commands: [
        {
          kind: 'docker',
          label: 'Docker',
          description: 'Run in Docker.',
          command:
            'docker run -d -e DEVICE_TYPE=remote -e EXECUTOR_MODE=local ghcr.io/wecode-ai/wegent-device:latest',
        },
        {
          kind: 'process',
          label: '宿主机启动',
          description: 'Run as a local process.',
          command:
            'DEVICE_TYPE=remote EXECUTOR_MODE=local WEGENT_BACKEND_URL=http://backend wegent-executor',
        },
      ],
    })
    renderSidebar({ onGetRemoteDeviceStartupCommand })

    await userEvent.click(screen.getByTestId('sidebar-cloud-connection-button'))

    expect(screen.getByTestId('standalone-folder-project-dialog')).toHaveTextContent('添加新设备')
    await waitFor(() => expect(onGetRemoteDeviceStartupCommand).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('remote-device-startup-command')).toHaveTextContent(
      'docker run'
    )
    expect(screen.getByTestId('remote-device-startup-tab-docker')).toBeInTheDocument()
    expect(screen.getByTestId('remote-device-startup-tab-process')).toHaveTextContent('宿主机启动')

    await userEvent.click(screen.getByTestId('remote-device-startup-tab-process'))

    expect(screen.getByTestId('remote-device-startup-command')).toHaveTextContent('wegent-executor')
  })

  test('hides plugins navigation while the feature is not released', () => {
    const onOpenPlugins = vi.fn()
    renderSidebar({ onOpenPlugins })

    expect(screen.queryByTestId('plugins-button')).not.toBeInTheDocument()
    expect(onOpenPlugins).not.toHaveBeenCalled()
  })

  test('renders chat runtime tasks as conversations instead of workspace groups', async () => {
    const onOpenRuntimeLocalTask = vi.fn()
    const chatPath = '/Users/alice/.wecode/wegent-executor/workspace/chats/2026-06-20/hi-1'

    renderSidebar({
      projects: [],
      runtimeWork: {
        projects: [],
        chats: [
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
    expect(screen.getByTestId('runtime-chat-section-toggle')).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.queryByTestId(`runtime-workspace-row-${chatPath}`)).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-row-chat-1')).toHaveTextContent('hi')
    expect(screen.queryByTestId('runtime-local-task-device-marker-chat-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-local-task-device-icon-chat-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-workspace-row-/tmp/spike')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-local-task-row-workspace-1')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('runtime-chat-section-toggle'))

    expect(screen.queryByTestId('runtime-local-task-row-chat-1')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('runtime-chat-section-toggle'))
    await userEvent.click(screen.getByTestId('runtime-local-task-row-chat-1'))

    expect(onOpenRuntimeLocalTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      workspacePath: chatPath,
      localTaskId: 'chat-1',
    })
  })

  test('renames a runtime conversation from double click dialog', async () => {
    const user = userEvent.setup()
    const onOpenRuntimeLocalTask = vi.fn()
    const onRenameRuntimeLocalTask = vi.fn().mockResolvedValue(undefined)

    renderSidebar({
      projects: [],
      runtimeWork: {
        projects: [],
        chats: [
          {
            deviceId: 'local-device',
            deviceName: 'Local Mac',
            deviceStatus: 'online',
            available: true,
            workspacePath: '/workspace/chats/chat-rename',
            workspaceKind: 'chat',
            localTasks: [
              {
                localTaskId: 'codex-rename',
                workspacePath: '/workspace/chats/chat-rename',
                workspaceKind: 'chat',
                title: '对齐需求核心点',
                runtime: 'codex',
              },
            ],
          },
        ],
        totalLocalTasks: 1,
      },
      onOpenRuntimeLocalTask,
      onRenameRuntimeLocalTask,
    })

    await user.dblClick(screen.getByTestId('runtime-local-task-row-codex-rename'))

    expect(screen.getByTestId('rename-runtime-local-task-input-codex-rename')).toHaveValue(
      '对齐需求核心点'
    )
    expect(screen.getByText('保持简短且易于识别')).toBeInTheDocument()

    await user.clear(screen.getByTestId('rename-runtime-local-task-input-codex-rename'))
    await user.type(screen.getByTestId('rename-runtime-local-task-input-codex-rename'), '对齐方案')
    await user.click(screen.getByTestId('confirm-rename-runtime-local-task-codex-rename'))

    await waitFor(() => {
      expect(onRenameRuntimeLocalTask).toHaveBeenCalledWith(
        {
          deviceId: 'local-device',
          workspacePath: '/workspace/chats/chat-rename',
          localTaskId: 'codex-rename',
        },
        '对齐方案'
      )
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
        chats: [],
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
      workspacePath: '/repo/Wegent',
      localTaskId: 'codex-1',
    })
  })

  test('selects a project when expanding it from the desktop sidebar', async () => {
    const onSelectProject = vi.fn()

    renderSidebar({
      onSelectProject,
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
        chats: [],
        totalLocalTasks: 1,
      },
    })

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(onSelectProject).toHaveBeenCalledWith(7)
    expect(screen.getByTestId('runtime-local-task-row-codex-1')).toBeInTheDocument()
  })

  test('hides remote-only runtime projects from the project list', () => {
    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'remote-project-id', name: 'Remote Wegent' },
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'remote-device',
                deviceName: '10.201.3.200',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/home/ubuntu/workspace/Wegent',
                workspaceSource: 'remote',
                remoteHostId: 'remote-ssh-discovered:10.201.3.200',
                localTasks: [],
              },
            ],
          },
          {
            project: { id: 8, key: 'local-project-id', name: 'Local Wegent' },
            deviceWorkspaces: [
              {
                id: 92,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/Users/alice/Wegent',
                workspaceSource: 'local',
                localTasks: [],
              },
            ],
          },
        ],
        chats: [],
        totalLocalTasks: 0,
      },
    })

    expect(screen.queryByText('Remote Wegent')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-remote-folder-icon-7')).not.toBeInTheDocument()
    expect(screen.getByText('Local Wegent')).toBeInTheDocument()
    expect(screen.getByTestId('project-folder-icon-8')).toBeInTheDocument()
    expect(screen.getAllByTestId('project-item')).toHaveLength(1)
  })

  test('shows running status on running runtime tasks only', async () => {
    renderSidebar({
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
                    localTaskId: 'codex-running',
                    workspacePath: '/repo/Wegent',
                    title: 'Investigate stream',
                    runtime: 'codex',
                    running: true,
                    updatedAt: '2026-06-20T03:00:00Z',
                  },
                  {
                    localTaskId: 'codex-idle',
                    workspacePath: '/repo/Wegent',
                    title: 'Finished fix',
                    runtime: 'codex',
                    running: false,
                    updatedAt: '2026-06-20T02:00:00Z',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalLocalTasks: 2,
      },
    })

    await userEvent.click(screen.getByTestId('project-item-button'))

    const runningStatus = screen.getByTestId('runtime-local-task-running-codex-running')
    expect(runningStatus).toHaveAttribute('aria-label', '运行中')
    expect(runningStatus).not.toHaveTextContent('运行中')
    expect(runningStatus.querySelector('svg')).not.toBeNull()
    expect(screen.queryByTestId('runtime-local-task-running-codex-idle')).not.toBeInTheDocument()
  })

  test('persists unread dot when a runtime task finishes while the app is closed', async () => {
    const onOpenRuntimeLocalTask = vi.fn()
    const runningRuntimeWork = {
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
                  localTaskId: 'codex-background',
                  workspacePath: '/repo/Wegent',
                  title: 'Background task',
                  runtime: 'codex' as const,
                  running: true,
                  updatedAt: '2026-06-20T03:00:00Z',
                },
              ],
            },
          ],
        },
      ],
      chats: [],
      totalLocalTasks: 1,
    }
    const completedRuntimeWork = {
      ...runningRuntimeWork,
      projects: [
        {
          ...runningRuntimeWork.projects[0],
          deviceWorkspaces: [
            {
              ...runningRuntimeWork.projects[0].deviceWorkspaces[0],
              localTasks: [
                {
                  ...runningRuntimeWork.projects[0].deviceWorkspaces[0].localTasks[0],
                  running: false,
                  updatedAt: '2026-06-20T03:02:00Z',
                },
              ],
            },
          ],
        },
      ],
    }

    const firstRender = renderSidebar({
      runtimeWork: runningRuntimeWork,
      onOpenRuntimeLocalTask,
    })
    await waitFor(() => {
      expect(localStorage.getItem('wework.desktop.sidebar.runningRuntimeTaskKeys.1')).toContain(
        'codex-background'
      )
    })
    firstRender.unmount()

    renderSidebar({
      runtimeWork: completedRuntimeWork,
      onOpenRuntimeLocalTask,
    })

    await userEvent.click(screen.getByTestId('project-item-button'))

    const unreadDot = screen.getByTestId('runtime-local-task-unread-dot-codex-background')
    expect(unreadDot).toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-time-codex-background')).toContainElement(
      unreadDot
    )

    await userEvent.click(screen.getByTestId('runtime-local-task-row-codex-background'))

    expect(onOpenRuntimeLocalTask).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(
        screen.queryByTestId('runtime-local-task-unread-dot-codex-background')
      ).not.toBeInTheDocument()
    })
  })

  test('does not render online devices section and keeps all runtime tasks visible', async () => {
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
        chats: [],
        totalLocalTasks: 2,
      },
    })

    expect(screen.queryByTestId('sidebar-online-devices')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(screen.getByTestId('runtime-local-task-row-local-task')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-row-cloud-task')).toBeInTheDocument()
    expect(
      screen.queryByTestId('runtime-local-task-device-marker-local-task')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByTestId('runtime-local-task-device-marker-cloud-task')
    ).not.toBeInTheDocument()
  })

  test('shows hover actions and an undo notice before archiving project runtime tasks', async () => {
    const user = userEvent.setup()
    const onArchiveRuntimeLocalTask = vi.fn().mockResolvedValue(undefined)
    const originalSetTimeout = window.setTimeout
    const originalClearTimeout = window.clearTimeout
    const archiveTimerId = 2200
    let archiveTimerCallback: (() => void) | null = null
    const setTimeoutSpy = vi
      .spyOn(window, 'setTimeout')
      .mockImplementation((handler: TimerHandler, timeout?: number) => {
        if (timeout === archiveTimerId && typeof handler === 'function') {
          archiveTimerCallback = handler
          return archiveTimerId
        }
        return originalSetTimeout(handler, timeout)
      })
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout').mockImplementation((id?: number) => {
      if (id === archiveTimerId) {
        archiveTimerCallback = null
        return
      }
      originalClearTimeout(id)
    })

    try {
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
          chats: [],
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
      expect(screen.getByTestId('runtime-local-task-time-codex-1').parentElement).toBe(
        rowChildren[1]
      )
      expect(
        screen.queryByTestId('runtime-local-task-device-marker-codex-1')
      ).not.toBeInTheDocument()
      expect(screen.getByTestId('runtime-local-task-hover-actions-codex-1').parentElement).toBe(
        rowChildren[1]
      )
      expect(screen.getByTestId('runtime-local-task-pin-icon-codex-1')).toBeInTheDocument()
      expect(screen.getByTestId('runtime-local-task-archive-icon-codex-1')).toBeInTheDocument()
      expect(screen.getByTestId('runtime-local-task-hover-actions-codex-1')).toHaveClass(
        'z-[70]',
        'hover:pointer-events-auto',
        'focus-within:pointer-events-auto'
      )
      expect(screen.getByTestId('runtime-local-task-time-codex-1').className).not.toContain(
        'focus-within'
      )

      expect(taskRow).not.toHaveAttribute('data-marked')
      expect(taskRow.className).not.toContain('color-sidebar-marked')

      await user.click(screen.getByTestId('runtime-local-task-archive-codex-1'))

      expect(onArchiveRuntimeLocalTask).not.toHaveBeenCalled()
      expect(screen.getByTestId('runtime-local-task-archive-toast-codex-1')).toHaveTextContent(
        '撤销'
      )

      await user.click(screen.getByTestId('runtime-local-task-archive-undo-codex-1'))

      expect(onArchiveRuntimeLocalTask).not.toHaveBeenCalled()
      expect(archiveTimerCallback).toBeNull()
      expect(
        screen.queryByTestId('runtime-local-task-archive-toast-codex-1')
      ).not.toBeInTheDocument()

      await user.click(screen.getByTestId('runtime-local-task-archive-codex-1'))
      expect(screen.getByTestId('runtime-local-task-archive-toast-codex-1')).toBeInTheDocument()
      expect(archiveTimerCallback).toBeTypeOf('function')

      const runArchiveTimer = archiveTimerCallback
      await act(async () => {
        runArchiveTimer?.()
        await Promise.resolve()
      })

      await waitFor(() =>
        expect(onArchiveRuntimeLocalTask).toHaveBeenCalledWith({
          deviceId: 'local-device',
          workspacePath: '/repo/Wegent',
          localTaskId: 'codex-1',
        })
      )
      expect(
        screen.queryByTestId('runtime-local-task-archive-toast-codex-1')
      ).not.toBeInTheDocument()
    } finally {
      setTimeoutSpy.mockRestore()
      clearTimeoutSpy.mockRestore()
    }
  })

  test('offers force archive when a worktree task has uncommitted changes', async () => {
    const user = userEvent.setup()
    const onArchiveRuntimeLocalTask = vi
      .fn()
      .mockResolvedValueOnce({ status: 'dirty_worktree' })
      .mockResolvedValueOnce({ status: 'archived' })
    const originalSetTimeout = window.setTimeout
    const originalClearTimeout = window.clearTimeout
    const archiveTimerId = 2200
    let archiveTimerCallback: (() => void) | null = null
    const setTimeoutSpy = vi
      .spyOn(window, 'setTimeout')
      .mockImplementation((handler: TimerHandler, timeout?: number) => {
        if (timeout === archiveTimerId && typeof handler === 'function') {
          archiveTimerCallback = handler
          return archiveTimerId
        }
        return originalSetTimeout(handler, timeout)
      })
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout').mockImplementation((id?: number) => {
      if (id === archiveTimerId) {
        archiveTimerCallback = null
        return
      }
      originalClearTimeout(id)
    })

    try {
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
                  workspacePath: '/repo/worktrees/9/Wegent',
                  workspaceKind: 'worktree',
                  worktreeId: '9',
                  localTasks: [
                    {
                      localTaskId: 'codex-1',
                      workspacePath: '/repo/worktrees/9/Wegent',
                      workspaceKind: 'worktree',
                      worktreeId: '9',
                      title: 'Fix reconnect',
                      runtime: 'codex',
                      updatedAt: '2026-06-20T02:00:00Z',
                    },
                  ],
                },
              ],
            },
          ],
          chats: [],
          totalLocalTasks: 1,
        },
        onArchiveRuntimeLocalTask,
      })

      await user.click(screen.getByTestId('project-item-button'))
      await user.click(screen.getByTestId('runtime-local-task-archive-codex-1'))
      const runArchiveTimer = archiveTimerCallback

      await act(async () => {
        runArchiveTimer?.()
        await Promise.resolve()
      })

      const dialog = await screen.findByTestId('runtime-local-task-force-archive-dialog-codex-1')
      expect(dialog).toHaveTextContent('工作树有未提交代码')
      expect(dialog).toHaveTextContent('强制归档会删除这个工作树目录')
      expect(onArchiveRuntimeLocalTask).toHaveBeenCalledTimes(1)
      expect(onArchiveRuntimeLocalTask).toHaveBeenNthCalledWith(1, {
        deviceId: 'local-device',
        workspacePath: '/repo/worktrees/9/Wegent',
        localTaskId: 'codex-1',
      })

      await user.click(
        screen.getByTestId('runtime-local-task-force-archive-dialog-codex-1-confirm-button')
      )

      await waitFor(() => expect(onArchiveRuntimeLocalTask).toHaveBeenCalledTimes(2))
      expect(onArchiveRuntimeLocalTask).toHaveBeenNthCalledWith(
        2,
        {
          deviceId: 'local-device',
          workspacePath: '/repo/worktrees/9/Wegent',
          localTaskId: 'codex-1',
        },
        { force: true }
      )
      expect(
        screen.queryByTestId('runtime-local-task-force-archive-dialog-codex-1')
      ).not.toBeInTheDocument()
    } finally {
      setTimeoutSpy.mockRestore()
      clearTimeoutSpy.mockRestore()
    }
  })

  test('marks and unmarks runtime tasks without opening the task', async () => {
    const user = userEvent.setup()
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
        chats: [],
        totalLocalTasks: 1,
      },
      onOpenRuntimeLocalTask,
    })

    await user.click(screen.getByTestId('project-item-button'))

    const taskRow = screen.getByTestId('runtime-local-task-row-codex-1')
    const markButton = screen.getByTestId('runtime-local-task-mark-codex-1')
    const pinIcon = screen.getByTestId('runtime-local-task-pin-icon-codex-1')

    expect(taskRow).not.toHaveAttribute('data-marked')
    expect(taskRow.className).not.toContain('color-sidebar-marked')

    await user.click(markButton)

    expect(taskRow).toHaveAttribute('data-marked', 'true')
    expect(taskRow.className).toContain('color-sidebar-marked')
    expect(pinIcon).toHaveClass('fill-current')
    expect(markButton).toHaveAttribute('aria-label', '取消标记')
    expect(onOpenRuntimeLocalTask).not.toHaveBeenCalled()

    await user.click(markButton)

    expect(taskRow).not.toHaveAttribute('data-marked')
    expect(taskRow.className).not.toContain('color-sidebar-marked')
    expect(pinIcon).not.toHaveClass('fill-current')
    expect(markButton).toHaveAttribute('aria-label', '标记任务')
  })

  test('reserves runtime task hover actions without padding the truncated title', async () => {
    const user = userEvent.setup()
    const taskTitle = '修复进行中任务未显示 tool 调用'

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
                    title: taskTitle,
                    runtime: 'codex',
                    updatedAt: '2026-06-20T02:00:00Z',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalLocalTasks: 1,
      },
    })

    await user.click(screen.getByTestId('project-item-button'))

    const title = screen.getByText(taskTitle)
    const trailing = screen.getByTestId('runtime-local-task-trailing-codex-1')
    const hoverActions = screen.getByTestId('runtime-local-task-hover-actions-codex-1')

    expect(title).toHaveClass('min-w-0', 'flex-1', 'truncate')
    expect(title).not.toHaveClass('group-hover/task:pr-20')
    expect(trailing).toHaveClass('min-w-[32px]', 'group-hover/task:w-[104px]')
    expect(hoverActions).toHaveClass('absolute', 'right-0', 'w-[104px]')
  })

  test('moves pinned runtime tasks to the top of the project task list', async () => {
    const user = userEvent.setup()

    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            totalLocalTasks: 3,
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
                    localTaskId: 'new-task',
                    workspacePath: '/repo/Wegent',
                    title: 'New task',
                    runtime: 'codex',
                    updatedAt: '2026-06-22T00:00:00Z',
                  },
                  {
                    localTaskId: 'middle-task',
                    workspacePath: '/repo/Wegent',
                    title: 'Middle task',
                    runtime: 'codex',
                    updatedAt: '2026-06-21T00:00:00Z',
                  },
                  {
                    localTaskId: 'old-task',
                    workspacePath: '/repo/Wegent',
                    title: 'Old task',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T00:00:00Z',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalLocalTasks: 3,
      },
    })

    await user.click(screen.getByTestId('project-item-button'))

    const rowTestIds = () =>
      screen.getAllByTestId(/^runtime-local-task-row-/).map(row => row.getAttribute('data-testid'))

    expect(rowTestIds()).toEqual([
      'runtime-local-task-row-new-task',
      'runtime-local-task-row-middle-task',
      'runtime-local-task-row-old-task',
    ])

    await user.click(screen.getByTestId('runtime-local-task-mark-old-task'))

    expect(rowTestIds()).toEqual([
      'runtime-local-task-row-old-task',
      'runtime-local-task-row-new-task',
      'runtime-local-task-row-middle-task',
    ])

    await user.click(screen.getByTestId('runtime-local-task-mark-old-task'))

    expect(rowTestIds()).toEqual([
      'runtime-local-task-row-new-task',
      'runtime-local-task-row-middle-task',
      'runtime-local-task-row-old-task',
    ])
  })

  test('excludes pinned runtime tasks from the collapsed project task count', async () => {
    const user = userEvent.setup()

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
                localTasks: Array.from({ length: 6 }, (_, index) => ({
                  localTaskId: `task-${index + 1}`,
                  workspacePath: '/repo/Wegent',
                  title: `Task ${index + 1}`,
                  runtime: 'codex',
                  updatedAt: `2026-06-2${6 - index}T00:00:00Z`,
                })),
              },
            ],
          },
        ],
        chats: [],
        totalLocalTasks: 6,
      },
    })

    await user.click(screen.getByTestId('project-item-button'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(5)
    expect(screen.getByTestId('project-runtime-tasks-expand-7')).toBeInTheDocument()

    await user.click(screen.getByTestId('runtime-local-task-mark-task-1'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(6)
    expect(screen.queryByTestId('project-runtime-tasks-expand-7')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-runtime-tasks-collapse-7')).not.toBeInTheDocument()
  })

  test('restores pinned runtime task ordering after remount', async () => {
    const user = userEvent.setup()
    const runtimeWork = {
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          totalLocalTasks: 3,
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
                  localTaskId: 'old-task',
                  workspacePath: '/repo/Wegent',
                  title: 'Old task',
                  runtime: 'codex',
                  updatedAt: '2026-06-20T00:00:00Z',
                },
                {
                  localTaskId: 'new-task',
                  workspacePath: '/repo/Wegent',
                  title: 'New task',
                  runtime: 'codex',
                  updatedAt: '2026-06-22T00:00:00Z',
                },
                {
                  localTaskId: 'middle-task',
                  workspacePath: '/repo/Wegent',
                  title: 'Middle task',
                  runtime: 'codex',
                  updatedAt: '2026-06-21T00:00:00Z',
                },
              ],
            },
          ],
        },
      ],
      chats: [],
      totalLocalTasks: 3,
    }
    const rowTestIds = () =>
      screen.getAllByTestId(/^runtime-local-task-row-/).map(row => row.getAttribute('data-testid'))

    const view = renderSidebar({ runtimeWork })

    await user.click(screen.getByTestId('project-item-button'))
    await user.click(screen.getByTestId('runtime-local-task-mark-old-task'))

    await waitFor(() => {
      expect(localStorage.getItem('wework.desktop.sidebar.pinnedRuntimeTaskKeys.7.1')).toContain(
        'old-task'
      )
    })

    view.unmount()

    renderSidebar({ runtimeWork })

    if (!screen.queryByTestId('runtime-local-task-row-old-task')) {
      await user.click(screen.getByTestId('project-item-button'))
    }

    expect(rowTestIds()).toEqual([
      'runtime-local-task-row-old-task',
      'runtime-local-task-row-new-task',
      'runtime-local-task-row-middle-task',
    ])
    expect(screen.getByTestId('runtime-local-task-mark-old-task')).toHaveAttribute(
      'aria-label',
      '取消标记'
    )
  })

  test('opens centered archive confirmation dialog for project archive', async () => {
    const user = userEvent.setup()
    const confirmSpy = vi.spyOn(window, 'confirm')
    const onArchiveProjectConversations = vi.fn().mockResolvedValue(undefined)

    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'project:7', name: 'Wegent' },
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
                    localTaskId: 'codex-1',
                    workspacePath: '/repo/Wegent',
                    title: 'Fix reconnect',
                    runtime: 'codex',
                  },
                  {
                    localTaskId: 'codex-2',
                    workspacePath: '/repo/Wegent',
                    title: 'Follow up',
                    runtime: 'codex',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalLocalTasks: 2,
      },
      onArchiveProjectConversations,
    })

    await user.click(screen.getByTestId('project-menu-7'))
    await user.click(screen.getByTestId('archive-project-conversations-7'))

    const dialog = screen.getByTestId('archive-project-conversations-dialog-7')
    expect(dialog).toHaveTextContent('归档 2 个对话?')
    expect(dialog).toHaveTextContent('这会将 Wegent 中的对话归档')
    expect(confirmSpy).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('archive-project-conversations-dialog-7-confirm-button'))

    await waitFor(() => {
      expect(onArchiveProjectConversations).toHaveBeenCalledWith('project:7', undefined)
    })
    expect(confirmSpy).not.toHaveBeenCalled()

    confirmSpy.mockRestore()
  })

  test('renames a project from the project row menu', async () => {
    const user = userEvent.setup()
    const onUpdateProjectName = vi.fn().mockResolvedValue(undefined)

    renderSidebar({ onUpdateProjectName })

    await user.click(screen.getByTestId('project-menu-7'))
    await user.click(screen.getByTestId('rename-project-7'))
    await user.clear(screen.getByTestId('rename-project-input'))
    await user.type(screen.getByTestId('rename-project-input'), 'weekly-mail')
    await user.click(screen.getByTestId('confirm-rename-project-button'))

    await waitFor(() => {
      expect(onUpdateProjectName).toHaveBeenCalledWith(7, 'weekly-mail')
    })
  })

  test('keeps runtime project rename and remove actions enabled without move project action', async () => {
    const user = userEvent.setup()
    const onUpdateProjectName = vi.fn().mockResolvedValue(undefined)
    const onRemoveProject = vi.fn().mockResolvedValue(undefined)
    const confirmSpy = vi.spyOn(window, 'confirm')

    renderSidebar({
      projects: [],
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'project:7', name: 'Wegent' },
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
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalLocalTasks: 1,
      },
      onUpdateProjectName,
      onRemoveProject,
    })

    await user.click(screen.getByTestId('project-menu-7'))

    expect(screen.getByTestId('rename-project-7')).not.toBeDisabled()
    expect(screen.getByTestId('remove-project-7')).not.toBeDisabled()
    expect(screen.queryByTestId('move-project-7')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('rename-project-7'))
    await user.clear(screen.getByTestId('rename-project-input'))
    await user.type(screen.getByTestId('rename-project-input'), 'weekly-mail')
    await user.click(screen.getByTestId('confirm-rename-project-button'))

    await waitFor(() => {
      expect(onUpdateProjectName).toHaveBeenCalledWith(7, 'weekly-mail')
    })

    await user.click(screen.getByTestId('project-menu-7'))
    await user.click(screen.getByTestId('remove-project-7'))

    expect(confirmSpy).not.toHaveBeenCalled()
    const dialog = screen.getByTestId('remove-project-dialog-7')
    expect(dialog).toHaveTextContent('移除 Wegent?')
    expect(dialog).toHaveTextContent('这将从 Wework 中移除该项目。磁盘上的文件不会被删除。')
    expect(onRemoveProject).not.toHaveBeenCalled()

    await user.click(screen.getByTestId('remove-project-dialog-7-confirm-button'))

    await waitFor(() => {
      expect(onRemoveProject).toHaveBeenCalledWith(7)
    })

    confirmSpy.mockRestore()
  })

  test('opens away reminder controls from the account notification bell', async () => {
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

    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('sidebar-global-im-notification-muted-icon')).toBeInTheDocument()
    expect(toggle).toHaveAttribute('title', expect.stringContaining('Telegram'))

    await user.click(toggle)
    expect(screen.getByTestId('sidebar-global-im-notification-menu')).toHaveTextContent(
      '离开电脑提醒'
    )
    expect(screen.getByTestId('sidebar-global-im-notification-menu')).toHaveTextContent(
      'Telegram / Alice'
    )
    await user.click(screen.getByTestId('sidebar-global-im-notification-primary-button'))

    expect(onToggleGlobalImNotification).toHaveBeenCalledTimes(1)
  })

  test('opens away reminder channel settings from the bell menu', async () => {
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

    await user.click(screen.getByTestId('sidebar-global-im-notification-button'))
    expect(screen.getByTestId('sidebar-global-im-notification-on-icon')).toBeInTheDocument()
    await user.click(screen.getByTestId('sidebar-global-im-notification-settings-button'))

    expect(onOpenGlobalImNotificationSettings).toHaveBeenCalledTimes(1)
    expect(onToggleGlobalImNotification).not.toHaveBeenCalled()
  })

  test('keeps the away reminder bell neutral when cloud is disconnected', async () => {
    const user = userEvent.setup()

    renderSidebar(
      {
        imNotificationSettings: {
          global: {
            enabled: false,
            sessionKey: null,
            session: null,
          },
          runtimeTaskSubscriptions: [],
        },
        onToggleGlobalImNotification: vi.fn(),
      },
      {
        status: 'disconnected',
        isConnected: false,
        token: null,
        user: null,
        error: null,
      }
    )

    const bell = screen.getByTestId('sidebar-global-im-notification-button')
    expect(bell).toHaveAttribute('title', '登录云端后可开启离开电脑提醒')
    expect(bell).not.toHaveClass('text-red-500')
    expect(screen.getByTestId('sidebar-global-im-notification-muted-icon')).toBeInTheDocument()

    await user.click(bell)

    expect(screen.getByTestId('sidebar-global-im-notification-menu')).toHaveTextContent(
      '登录云端后可开启离开电脑提醒'
    )
  })

  test('shows the away reminder bell even when notification handlers are unavailable', async () => {
    const user = userEvent.setup()

    renderSidebar(
      {
        onToggleGlobalImNotification: undefined,
        onOpenGlobalImNotificationSettings: undefined,
      },
      {
        status: 'disconnected',
        isConnected: false,
        token: null,
        user: null,
        error: null,
      }
    )

    const bell = screen.getByTestId('sidebar-global-im-notification-button')
    expect(bell).toBeInTheDocument()
    expect(bell).toHaveAttribute('title', '登录云端后可开启离开电脑提醒')
    expect(bell).not.toHaveClass('text-red-500')
    expect(screen.getByTestId('sidebar-global-im-notification-muted-icon')).toBeInTheDocument()

    await user.click(bell)

    expect(screen.getByTestId('sidebar-global-im-notification-menu')).toHaveTextContent(
      '登录云端后可开启离开电脑提醒'
    )
  })

  test('wraps cloud connection errors without turning the away reminder bell red', async () => {
    const user = userEvent.setup()
    const error = '读取云端用户失败 (http://localhost:8000/api/users/me): Cloud connection failed'

    renderSidebar(
      {
        imNotificationSettings: {
          global: {
            enabled: false,
            sessionKey: null,
            session: null,
          },
          runtimeTaskSubscriptions: [],
        },
      },
      {
        status: 'error',
        isConnected: false,
        token: null,
        user: null,
        error,
      }
    )

    const bell = screen.getByTestId('sidebar-global-im-notification-button')
    expect(bell).toHaveAttribute('title', '登录云端后可开启离开电脑提醒')
    expect(bell).not.toHaveClass('text-red-500')
    expect(screen.getByTestId('sidebar-global-im-notification-muted-icon')).toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-global-im-notification-indicator')).not.toBeInTheDocument()

    await user.click(bell)

    const errorMessage = screen.getByTestId('sidebar-global-im-notification-error')
    expect(errorMessage).toHaveTextContent(error)
    expect(errorMessage).toHaveClass('break-words', '[overflow-wrap:anywhere]')
  })

  test('shows archive all menus on project and chat headers with chat create action', async () => {
    const user = userEvent.setup()
    const onArchiveProjectsConversations = vi.fn().mockResolvedValue(undefined)
    const onArchiveChatConversations = vi.fn().mockResolvedValue(undefined)
    const onNewChat = vi.fn()

    renderSidebar({
      onNewChat,
      onArchiveProjectsConversations,
      onArchiveChatConversations,
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'project:7', name: 'Wegent' },
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
                  },
                ],
              },
            ],
          },
        ],
        chats: [
          {
            id: null,
            deviceId: 'local-device',
            deviceName: 'Local Mac',
            deviceStatus: 'online',
            available: true,
            workspacePath: '/workspace/chats/chat-1',
            workspaceKind: 'chat',
            localTasks: [
              {
                localTaskId: 'chat-1',
                workspacePath: '/workspace/chats/chat-1',
                workspaceKind: 'chat',
                title: 'Hello',
                runtime: 'codex',
              },
            ],
          },
        ],
        totalLocalTasks: 2,
      },
    })

    await user.click(screen.getByTestId('projects-section-menu'))
    expect(screen.getByTestId('projects-section-archive-all-chats')).toHaveTextContent(
      '归档所有聊天'
    )
    await user.click(screen.getByTestId('projects-section-archive-all-chats'))

    expect(screen.getByTestId('projects-section-archive-conversations-dialog')).toHaveTextContent(
      '归档 1 个对话?'
    )
    expect(screen.getByTestId('projects-section-archive-conversations-dialog')).toHaveTextContent(
      '项目中的对话'
    )
    await user.click(
      screen.getByTestId('projects-section-archive-conversations-dialog-confirm-button')
    )
    await waitFor(() => {
      expect(onArchiveProjectsConversations).toHaveBeenCalledWith(['project:7'], undefined)
    })

    await user.click(screen.getByTestId('runtime-chat-section-new-chat-button'))
    expect(onNewChat).toHaveBeenCalledTimes(1)

    await user.click(screen.getByTestId('runtime-chat-section-menu'))
    expect(screen.getByTestId('runtime-chat-section-archive-all-chats')).toHaveTextContent(
      '归档所有聊天'
    )
    await user.click(screen.getByTestId('runtime-chat-section-archive-all-chats'))
    expect(
      screen.getByTestId('runtime-chat-section-archive-conversations-dialog')
    ).toHaveTextContent('归档 1 个对话?')
    expect(
      screen.getByTestId('runtime-chat-section-archive-conversations-dialog')
    ).toHaveTextContent('对话列表中的对话')
    await user.click(
      screen.getByTestId('runtime-chat-section-archive-conversations-dialog-confirm-button')
    )

    await waitFor(() => {
      expect(onArchiveChatConversations).toHaveBeenCalledWith(
        [
          {
            deviceId: 'local-device',
            workspacePath: '/workspace/chats/chat-1',
            localTaskId: 'chat-1',
          },
        ],
        undefined
      )
    })
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
        chats: [],
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
              workspacePath: '/repo/Wegent',
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
        workspacePath: '/repo/Wegent',
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
        chats: [],
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
        chats: [],
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
      workspacePath: '/workspace/worktrees/42/Wegent',
      localTaskId: 'codex-worktree',
    })
  })

  test('limits project runtime tasks to five newest rows', async () => {
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
        chats: [],
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
    expect(screen.getByText('Fourth task')).toBeInTheDocument()
    expect(screen.getByTestId('project-runtime-tasks-collapse-7')).toHaveTextContent('折叠显示')

    await userEvent.click(screen.getByTestId('project-runtime-tasks-collapse-7'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(5)
    expect(screen.queryByText('Oldest hidden task')).not.toBeInTheDocument()
  })

  test('expands project runtime tasks by ten and collapses back to five', async () => {
    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            totalLocalTasks: 26,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                localTasks: Array.from({ length: 26 }, (_, index) => ({
                  localTaskId: `task-${index + 1}`,
                  workspacePath: '/repo/Wegent',
                  title: `Task ${index + 1}`,
                  runtime: 'codex',
                  updatedAt: '2026-06-20T06:00:00Z',
                })),
              },
            ],
          },
        ],
        chats: [],
        totalLocalTasks: 26,
      },
    })

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(5)

    await userEvent.click(screen.getByTestId('project-runtime-tasks-expand-7'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(15)
    expect(screen.getByTestId('project-runtime-tasks-expand-7')).toHaveTextContent('展开显示')
    expect(screen.getByTestId('project-runtime-tasks-collapse-7')).toHaveTextContent('折叠显示')

    await userEvent.click(screen.getByTestId('project-runtime-tasks-expand-7'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(25)
    expect(screen.getByTestId('project-runtime-tasks-expand-7')).toBeInTheDocument()
    expect(screen.getByTestId('project-runtime-tasks-collapse-7')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('project-runtime-tasks-expand-7'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(26)
    expect(screen.queryByTestId('project-runtime-tasks-expand-7')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-runtime-tasks-collapse-7')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('project-runtime-tasks-collapse-7'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(5)
    expect(screen.getByTestId('project-runtime-tasks-expand-7')).toBeInTheDocument()
    expect(screen.queryByTestId('project-runtime-tasks-collapse-7')).not.toBeInTheDocument()
  })

  test('toggles a project when its sidebar row is clicked', async () => {
    const user = userEvent.setup()

    renderSidebar()

    const button = screen.getByTestId('project-item-button')
    const panel = screen.getByTestId('project-local-tasks-panel-7')

    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(panel).toHaveAttribute('aria-hidden', 'true')
    expect(panel).toHaveClass(
      'grid',
      'overflow-hidden',
      'transition-[grid-template-rows,opacity]',
      'grid-rows-[0fr]',
      'opacity-0'
    )

    await user.click(button)

    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(panel).toHaveAttribute('aria-hidden', 'false')
    expect(panel).toHaveClass('grid-rows-[1fr]', 'opacity-100')

    await user.click(button)

    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(panel).toHaveAttribute('aria-hidden', 'true')
    expect(panel).toHaveClass('grid-rows-[0fr]', 'opacity-0')
  })

  test('switches project hover affordance based on expanded state', async () => {
    const user = userEvent.setup()

    renderSidebar()

    const button = screen.getByTestId('project-item-button')
    const title = screen.getByTestId('project-title-7')
    const collapsedIndicator = screen.getByTestId('project-collapsed-hover-indicator-7')
    const expandedIndicator = screen.getByTestId('project-expanded-hover-indicator-7')

    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(title).toHaveTextContent('Wegent')
    expect(title).not.toHaveClass('group-hover/project:hidden')
    expect(title.parentElement).toHaveClass('gap-1.5')
    expect(collapsedIndicator).toHaveClass(
      'hidden',
      'group-hover/project:block',
      'group-hover/project:opacity-100',
      'group-focus-within/project:block',
      'group-focus-within/project:opacity-100'
    )
    expect(expandedIndicator).toHaveClass('hidden')

    await user.click(button)

    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('project-title-7')).not.toHaveClass('group-hover/project:hidden')
    expect(screen.getByTestId('project-collapsed-hover-indicator-7')).toHaveClass('hidden')
    expect(screen.getByTestId('project-expanded-hover-indicator-7')).toHaveClass(
      'group-hover/project:block',
      'group-focus-within/project:block'
    )
  })

  test('allows collapsing a project while one of its runtime tasks is active', async () => {
    const user = userEvent.setup()

    renderSidebar({
      currentRuntimeTask: {
        deviceId: 'local-device',
        workspacePath: '/repo/Wegent',
        localTaskId: 'codex-active',
      },
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
                    localTaskId: 'codex-active',
                    workspacePath: '/repo/Wegent',
                    title: 'Active fix',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T02:00:00Z',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalLocalTasks: 1,
      },
    })

    const button = screen.getByTestId('project-item-button')
    const panel = screen.getByTestId('project-local-tasks-panel-7')

    await waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'true'))

    expect(screen.getByTestId('runtime-local-task-row-codex-active')).toHaveClass(
      'bg-[rgb(var(--color-sidebar-active))]'
    )

    await user.click(button)

    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(panel).toHaveAttribute('aria-hidden', 'true')
    expect(panel).toHaveClass('grid-rows-[0fr]', 'opacity-0')
  })

  test('auto-expands the opened standalone runtime project', () => {
    renderSidebar({
      projects: [],
      devices: [localDevice({ device_id: 'device-1', name: 'Local Mac' })],
      standaloneDeviceId: 'device-1',
      standaloneWorkspacePath: '/Users/alice/hello 20',
      runtimeWork: {
        projects: [
          {
            project: {
              key: 'local:/Users/alice/hello 20',
              name: 'hello 20',
            },
            totalLocalTasks: 0,
            deviceWorkspaces: [
              {
                id: null,
                projectId: null,
                deviceId: 'device-1',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/Users/alice/hello 20',
                workspaceKind: 'workspace',
                mapped: true,
                localTasks: [],
              },
            ],
          },
        ],
        chats: [],
        totalLocalTasks: 0,
      },
    })

    const button = screen.getByTestId('project-item-button')
    expect(button).toHaveTextContent('hello 20')
    expect(button).toHaveAttribute('aria-expanded', 'true')
  })
})
