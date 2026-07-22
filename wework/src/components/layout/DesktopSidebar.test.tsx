import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { DesktopSidebar } from './DesktopSidebar'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'
import type { CloudWorkStatus } from '@/types/workbench'
import {
  CloudConnectionContext,
  DISCONNECTED_STATE,
} from '@/features/cloud-connection/CloudConnectionContext'
import type { CloudConnectionContextValue } from '@/features/cloud-connection/CloudConnectionContext'
import {
  AppUpdateContext,
  type AppUpdateContextValue,
} from '@/features/app-update/app-update-context'
import { openLocalWorkspace } from '@/lib/local-terminal'

const experimentalFeatures = vi.hoisted(() => ({ enabled: true }))

vi.mock('@/features/experimental-features/useExperimentalFeaturesEnabled', () => ({
  useExperimentalFeaturesEnabled: () => experimentalFeatures.enabled,
}))

vi.mock('@/lib/local-terminal', () => ({
  openLocalWorkspace: vi.fn(),
}))

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

function createSidebarProps(overrides: Partial<Parameters<typeof DesktopSidebar>[0]> = {}) {
  return {
    user: { id: 1, user_name: 'alice', email: 'alice@example.com' },
    projects: [project()],
    devices: [localDevice()],
    onNewChat: vi.fn(),
    onStartStandaloneChat: vi.fn(),
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
}

function renderSidebar(
  overrides: Partial<Parameters<typeof DesktopSidebar>[0]> = {},
  cloudConnection?: Partial<CloudConnectionContextValue>,
  appUpdate?: Partial<AppUpdateContextValue>
) {
  const props: Parameters<typeof DesktopSidebar>[0] = createSidebarProps(overrides)

  let tree = <DesktopSidebar {...props} />
  if (appUpdate) {
    const value: AppUpdateContextValue = {
      availableUpdate: null,
      status: 'idle',
      downloadProgress: null,
      message: null,
      error: null,
      checkNow: vi.fn().mockResolvedValue(null),
      installUpdate: vi.fn().mockResolvedValue(undefined),
      ...appUpdate,
    }
    tree = <AppUpdateContext.Provider value={value}>{tree}</AppUpdateContext.Provider>
  }
  if (cloudConnection) {
    const value: CloudConnectionContextValue = {
      ...DISCONNECTED_STATE,
      isConnected: false,
      serviceKey: 'test-disconnected',
      connectWithAuthorization: vi.fn(),
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
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  })
}

describe('DesktopSidebar', () => {
  beforeEach(() => {
    experimentalFeatures.enabled = true
    localStorage.clear()
    enableTauri()
    Element.prototype.scrollIntoView = vi.fn()
    vi.mocked(openLocalWorkspace).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
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

  test('switches sidebar focus tokens with browser focus events', () => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
    renderSidebar()
    const sidebar = screen.getByTestId('desktop-sidebar')

    act(() => window.dispatchEvent(new Event('focus')))
    expect(sidebar).toHaveAttribute('data-window-focused', 'true')
    expect(sidebar).toHaveClass('bg-[rgb(var(--color-sidebar))]')

    act(() => window.dispatchEvent(new Event('blur')))
    expect(sidebar).toHaveAttribute('data-window-focused', 'false')
    expect(sidebar).toHaveClass('bg-[rgb(var(--color-sidebar-unfocused))]')
  })

  test('removes right border on Windows', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.0',
    })
    renderSidebar()
    const sidebar = screen.getByTestId('desktop-sidebar')
    expect(sidebar).not.toHaveClass('border-r')
  })

  test('uses the project action model for right click and global-state pinning', async () => {
    const onSetRuntimeProjectPinned = vi.fn().mockResolvedValue(undefined)
    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: {
              id: 7,
              key: 'project-7',
              name: 'Wegent',
              stateDeviceId: 'local-device',
              pinned: false,
            },
            totalTasks: 0,
            deviceWorkspaces: [],
          },
        ],
        chats: [],
        totalTasks: 0,
      },
      onSetRuntimeProjectPinned,
    })

    fireEvent.contextMenu(screen.getByTestId('project-row-7'), {
      clientX: 120,
      clientY: 80,
    })

    expect(await screen.findByTestId('project-menu-7-menu')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('pin-project-7'))
    expect(onSetRuntimeProjectPinned).toHaveBeenCalledWith({
      deviceId: 'local-device',
      projectKey: 'project-7',
      pinned: true,
    })
  })

  test('exposes a remote project as sortable through its local Codex state identity', () => {
    const onReorderRuntimeProjects = vi.fn().mockResolvedValue(undefined)
    renderSidebar({
      devices: [
        localDevice(),
        localDevice({
          id: 2,
          device_id: 'remote-device',
          name: 'Remote Host',
          is_default: false,
          device_type: 'remote',
        }),
      ],
      runtimeWork: {
        projects: [
          {
            project: {
              id: 7,
              key: '/repo/local',
              name: 'Local',
              stateDeviceId: 'local-device',
            },
            totalTasks: 0,
            deviceWorkspaces: [
              {
                deviceId: 'local-device',
                workspacePath: '/repo/local',
                available: true,
                tasks: [],
              },
            ],
          },
          {
            project: {
              id: 8,
              key: '/srv/remote',
              sidebarStateKey: 'remote-project-id',
              name: 'Remote',
              kind: 'remote',
              source: 'remote_project',
              stateDeviceId: 'local-device',
            },
            totalTasks: 0,
            deviceWorkspaces: [
              {
                deviceId: 'remote-device',
                remoteHostId: 'remote-device',
                workspacePath: '/srv/remote',
                workspaceSource: 'remote',
                available: true,
                tasks: [
                  {
                    taskId: 'remote-task',
                    workspacePath: '/srv/remote',
                    title: 'Remote task',
                    runtime: 'codex',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 0,
      },
      onReorderRuntimeProjects,
    })

    const remoteSortable = document.querySelector(
      '[data-sidebar-sortable-id="local-device:remote-project-id"]'
    ) as HTMLElement
    expect(remoteSortable).toHaveAttribute('tabindex', '0')
    expect(remoteSortable).toHaveAttribute('role', 'button')
    expect(remoteSortable).toHaveClass('touch-none')
  })

  test('shows an interactive Codex-style project hover card', async () => {
    vi.useFakeTimers()
    const onSetRuntimeProjectPinned = vi.fn().mockResolvedValue(undefined)
    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: {
              id: 7,
              key: 'project-7',
              name: 'Wegent',
              stateDeviceId: 'local-device',
              roots: [{ kind: 'local', path: '/Users/alice/repo/Wegent' }],
            },
            totalTasks: 3,
            deviceWorkspaces: [
              {
                deviceId: 'local-device',
                available: true,
                workspacePath: '/Users/alice/repo/Wegent',
                repoUrl: 'git@github.com:wecode-ai/Wegent.git',
                tasks: [
                  {
                    taskId: 'running-task',
                    workspacePath: '/Users/alice/repo/Wegent',
                    title: 'Running task',
                    runtime: 'codex',
                    running: true,
                  },
                  {
                    taskId: 'waiting-task',
                    workspacePath: '/Users/alice/repo/Wegent',
                    title: 'Waiting task',
                    runtime: 'codex',
                    status: 'waiting_for_user_input',
                  },
                  {
                    taskId: 'unread-task',
                    workspacePath: '/Users/alice/repo/Wegent',
                    title: 'Unread task',
                    runtime: 'codex',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 3,
      },
      unreadRuntimeTaskKeys: new Set(['local-device\0unread-task']),
      onSetRuntimeProjectPinned,
    })

    const projectRow = screen.getByTestId('project-row-7')
    expect(screen.getByTestId('project-title-7')).not.toHaveAttribute('title')
    fireEvent.mouseEnter(projectRow)
    await act(async () => vi.advanceTimersByTime(450))

    const hoverCard = screen.getByTestId('project-hover-card-7')
    expect(hoverCard).toHaveAttribute('role', 'dialog')
    expect(hoverCard).toHaveClass('pointer-events-auto')
    expect(hoverCard).toHaveTextContent('Wegent')
    expect(hoverCard).toHaveTextContent('3 个任务')
    expect(hoverCard).toHaveTextContent('1 个等待中')
    expect(hoverCard).toHaveTextContent('1 个未读')
    expect(hoverCard).toHaveTextContent('1 个运行中')
    expect(hoverCard).not.toHaveTextContent('wecode-ai/Wegent')
    expect(screen.queryByTestId('project-hover-source-7-repository')).not.toBeInTheDocument()
    expect(hoverCard).toHaveTextContent('~/repo/Wegent')

    fireEvent.mouseLeave(projectRow)
    fireEvent.mouseEnter(hoverCard)
    await act(async () => vi.advanceTimersByTime(120))
    expect(screen.getByTestId('project-hover-card-7')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('project-hover-pin-7'))
    expect(onSetRuntimeProjectPinned).toHaveBeenCalledWith({
      deviceId: 'local-device',
      projectKey: 'project-7',
      pinned: true,
    })
    fireEvent.click(screen.getByTestId('project-hover-rename-7'))
    expect(screen.getByTestId('rename-project-input')).toHaveValue('Wegent')
    fireEvent.click(screen.getByTestId('rename-project-input-close-button'))

    const menuTrigger = screen.getByTestId('project-menu-7')
    fireEvent.pointerDown(menuTrigger)
    fireEvent.click(menuTrigger)

    expect(screen.queryByTestId('project-hover-card-7')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-menu-7-menu')).toBeInTheDocument()
  })

  test('shows project, repository, path, timestamps, and status in task hover cards', async () => {
    vi.useFakeTimers()
    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'project-7', name: 'Wegent' },
            deviceWorkspaces: [
              {
                deviceId: 'local-device',
                available: true,
                workspacePath: '/Users/alice/repo/Wegent',
                repoUrl: 'https://github.com/wecode-ai/Wegent.git',
                tasks: [
                  {
                    taskId: 'hover-task',
                    workspacePath: '/Users/alice/repo/Wegent',
                    title: 'Hover details',
                    runtime: 'codex',
                    createdAt: '2026-07-12T00:00:00Z',
                    updatedAt: '2026-07-12T00:30:00Z',
                    status: 'waiting_for_user_input',
                    gitInfo: {
                      branch: 'codex/hover-details',
                      currentBranch: 'main',
                    },
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 1,
      },
    })

    fireEvent.click(screen.getByTestId('project-item-button'))
    const taskRow = screen.getByTestId('runtime-local-task-row-hover-task')
    expect(taskRow.querySelector('span')).not.toHaveAttribute('title')
    fireEvent.mouseEnter(taskRow)
    await act(async () => vi.advanceTimersByTime(450))

    const content = screen.getByTestId('runtime-local-task-hover-content-hover-task')
    expect(content).toHaveTextContent('Hover details')
    expect(content).toHaveTextContent('Wegent')
    expect(content).toHaveTextContent('wecode-ai/Wegent')
    expect(content).toHaveTextContent('codex/hover-details')
    expect(content).toHaveTextContent('任务分支会反映上次使用时的活动分支；发送消息会更新任务分支')
    expect(content).not.toHaveTextContent('~/repo/Wegent')
    expect(content).not.toHaveTextContent('创建时间')
    expect(content).not.toHaveTextContent('done')
    expect(content).not.toHaveTextContent('local-device /Users/alice/repo/Wegent')

    fireEvent.mouseLeave(taskRow)
    fireEvent.pointerMove(content)
    await act(async () => vi.advanceTimersByTime(120))
    expect(content).toBeInTheDocument()

    fireEvent.pointerMove(document.body)
    await act(async () => vi.advanceTimersByTime(60))
    fireEvent.pointerMove(document.body)
    await act(async () => vi.advanceTimersByTime(60))
    expect(
      screen.queryByTestId('runtime-local-task-hover-content-hover-task')
    ).not.toBeInTheDocument()
  })

  test('keeps the account settings trigger and notification bell inside the sidebar width', () => {
    renderSidebar()

    expect(screen.getByTestId('settings-button')).toHaveClass('h-[60px]', 'min-w-0', 'flex-1')
    expect(screen.getByTestId('settings-button')).toHaveClass('pr-10')
    expect(screen.getByTestId('settings-button')).not.toHaveClass('w-full', 'shrink-0')
    expect(screen.getByTestId('settings-button')).toHaveTextContent('alice')
    expect(screen.getByTestId('settings-button')).toHaveTextContent('alice@example.com')
    expect(screen.getByTestId('sidebar-account-avatar').querySelector('svg')).toHaveClass(
      'lucide-user-round'
    )
    expect(screen.getByTestId('sidebar-account-avatar')).not.toHaveTextContent('AL')
    expect(screen.getByTestId('sidebar-global-im-notification-button')).toHaveClass(
      'h-8',
      'w-8',
      'shrink-0'
    )
  })

  test('keeps the account menu available before cloud login', async () => {
    vi.stubEnv('VITE_WEGENT_BACKEND_URL', 'http://localhost:8000')
    renderSidebar({}, { status: 'disconnected', isConnected: false, user: null })

    const accountButton = screen.getByTestId('settings-button')
    expect(accountButton).toHaveAccessibleName('账户与设置')
    expect(accountButton).toHaveTextContent('Wegent 账户')
    expect(accountButton).toHaveTextContent('未登录')
    expect(accountButton).not.toHaveTextContent('http://localhost:8000')
    expect(accountButton).not.toHaveTextContent('alice@example.com')

    await userEvent.click(accountButton)

    expect(screen.getByTestId('settings-menu')).toBeInTheDocument()
    expect(screen.getByTestId('settings-menu-button')).toHaveTextContent('设置')
    expect(screen.getByTestId('login-menu-button')).toHaveTextContent('登录 Wegent')
    expect(screen.queryByTestId('cloud-connection-dialog')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('login-menu-button'))

    expect(screen.getByTestId('cloud-connection-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('cloud-backend-url-input')).toHaveValue('http://localhost:8000')
    expect(screen.queryByTestId('settings-menu')).not.toBeInTheDocument()
  })

  test('shows the cloud username and email after login', async () => {
    vi.stubEnv('VITE_WEGENT_BACKEND_URL', 'http://localhost:8000')
    const disconnect = vi.fn()
    renderSidebar(
      {},
      {
        status: 'connected',
        isConnected: true,
        backendUrl: 'http://localhost:8000',
        user: { id: 7, user_name: 'cloud-user', email: 'cloud@example.com' },
        disconnect,
      }
    )

    const accountButton = screen.getByTestId('settings-button')
    expect(accountButton).toHaveTextContent('cloud-user')
    expect(accountButton).toHaveTextContent('cloud@example.com')
    expect(accountButton).not.toHaveTextContent('alice@example.com')

    await userEvent.click(accountButton)

    expect(screen.getByTestId('settings-menu')).toBeInTheDocument()
    expect(screen.getByTestId('logout-menu-button')).toHaveTextContent('退出登录')
    expect(screen.queryByTestId('cloud-connection-dialog')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('logout-menu-button'))

    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('settings-menu')).not.toBeInTheDocument()
  })

  test('shows an exposed update button in the account row when an app update is available', async () => {
    const installUpdate = vi.fn().mockResolvedValue(undefined)
    renderSidebar({}, undefined, {
      availableUpdate: { currentVersion: '0.1.0', version: '0.1.1' },
      status: 'available',
      installUpdate,
    })

    const button = screen.getByTestId('sidebar-app-update-button')
    const action = screen.getByTestId('sidebar-app-update-action')
    expect(button).toHaveClass('h-8', 'w-8')
    expect(button).toHaveAttribute('title', '更新到 0.1.1')
    expect(action).not.toHaveClass('max-w-0', 'opacity-0', 'overflow-hidden')
    expect(screen.getByTestId('settings-button')).toHaveClass('pr-[72px]')

    await userEvent.click(button)

    expect(installUpdate).toHaveBeenCalledTimes(1)
  })

  test('does not show an update icon without an available update', () => {
    renderSidebar({}, undefined, {
      availableUpdate: null,
      status: 'error',
      error: 'updater does not have any endpoints set',
    })

    expect(screen.queryByTestId('sidebar-app-update-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-app-update-action')).not.toBeInTheDocument()
    expect(screen.getByTestId('settings-button')).toHaveClass('pr-10')
  })

  test('shows download progress in the account-row update icon', () => {
    renderSidebar({}, undefined, {
      availableUpdate: { currentVersion: '0.1.0', version: '0.1.1' },
      status: 'installing',
      downloadProgress: { downloadedBytes: 40, totalBytes: 100 },
    })

    const progress = screen.getByTestId('sidebar-app-update-download-progress')
    expect(progress).toHaveAttribute('aria-valuenow', '40')
    expect(screen.getByTestId('sidebar-app-update-button')).toHaveAttribute(
      'title',
      '正在下载更新 40%'
    )
  })

  test('keeps the resize handle hit area on the sidebar edge', () => {
    renderSidebar()

    const handle = screen.getByTestId('sidebar-resize-handle')

    expect(handle).toHaveClass('right-[-14px]', 'w-[18px]')
    expect(handle).not.toHaveClass('w-10')
  })

  test('does not render non-chat runtime workspace groups', async () => {
    const onOpenRuntimeTask = vi.fn()

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
            tasks: [
              {
                taskId: 'claude-1',
                workspacePath: '/tmp/spike',
                title: 'Spike runtime task',
                runtime: 'claude_code',
              },
            ],
          },
        ],
        totalTasks: 1,
      },
      onOpenRuntimeTask,
    })

    expect(screen.queryByTestId('non-chat-runtime-section')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-workspace-row-/tmp/spike')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-local-task-row-claude-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-chat-section')).toHaveTextContent('任务')
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
    expect(onOpenRuntimeTask).not.toHaveBeenCalled()
  })

  test('opens runtime search from the product header', async () => {
    const onOpenSearch = vi.fn()
    renderSidebar({ onOpenSearch })

    await userEvent.click(screen.getByTestId('runtime-search-button'))

    expect(onOpenSearch).toHaveBeenCalledTimes(1)
  })

  test('keeps search in the product header and orders primary sidebar actions', () => {
    renderSidebar()

    const newChatButton = screen.getByTestId('new-chat-button')
    const searchButton = screen.getByTestId('runtime-search-button')
    const pluginsButton = screen.getByTestId('plugins-button')
    const cloudButton = screen.getByTestId('sidebar-cloud-connection-button')
    const projectsHeader = screen.getByTestId('projects-section-toggle')

    expect(searchButton.compareDocumentPosition(newChatButton)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(newChatButton.compareDocumentPosition(pluginsButton)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(pluginsButton.compareDocumentPosition(cloudButton)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(cloudButton.compareDocumentPosition(projectsHeader)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )

    const scrollContainer = screen.getByTestId('sidebar-worklists-scroll')
    expect(scrollContainer).toHaveClass('mt-0.5', 'mb-2')
    expect(scrollContainer).not.toHaveClass('my-2', 'pt-1')
    expect(searchButton.parentElement).toHaveClass('h-9', 'justify-between')
    expect(pluginsButton.parentElement).toHaveClass('space-y-0.5')
    expect(pluginsButton.parentElement).not.toHaveClass('pt-2')
  })

  test('matches Codex sidebar text emphasis levels', () => {
    renderSidebar({}, { status: 'disconnected', isConnected: false })

    const newTaskButton = screen.getByTestId('new-chat-button')
    const searchButton = screen.getByTestId('runtime-search-button')
    const pluginsButton = screen.getByTestId('plugins-button')
    const cloudButton = screen.getByTestId('sidebar-cloud-connection-button')
    const newTaskIcon = newTaskButton.querySelector('svg')
    const cloudIcon = cloudButton.parentElement?.querySelector('svg')
    const projectsToggle = screen.getByTestId('projects-section-toggle')
    const projectsTitle = projectsToggle.querySelector('span')

    for (const button of [newTaskButton, pluginsButton, cloudButton]) {
      expect(button).toHaveClass('font-normal', 'text-[rgb(var(--color-sidebar-text-primary))]')
    }
    expect(searchButton).toHaveClass('text-[rgb(var(--color-sidebar-text-primary))]')
    expect(newTaskButton).toHaveClass('h-[30px]', 'rounded-[10px]', 'text-base')
    expect(pluginsButton).toHaveClass('h-[30px]', 'rounded-[10px]', 'text-base')
    expect(cloudButton).toHaveClass('h-[30px]', 'rounded-[10px]', 'text-base')
    expect(newTaskIcon).toHaveClass('text-current')
    expect(cloudIcon).toHaveClass('text-[rgb(var(--color-sidebar-text-primary))]')
    expect(projectsTitle).toHaveClass(
      'font-medium',
      'text-[rgb(var(--color-sidebar-text-muted))]',
      'opacity-75'
    )
    expect(screen.getByTestId('project-row-7')).toHaveClass(
      'text-[rgb(var(--color-sidebar-text-primary))]'
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

  test('shows cloud work availability and opens connection settings from the sidebar entry', async () => {
    const onOpenSettings = vi.fn()
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
      onOpenSettings,
    })

    const cloudButton = screen.getByTestId('sidebar-cloud-connection-button')
    const statusLabel = screen.getByTestId('sidebar-cloud-status-label')
    const settingsButton = screen.getByTestId('sidebar-cloud-management-button')

    expect(cloudButton).toHaveTextContent('云端工作')
    expect(cloudButton).toHaveTextContent('可用')
    expect(cloudButton).toHaveClass('pr-2')
    expect(cloudButton).not.toHaveClass('pr-8')
    expect(statusLabel).toHaveClass(
      'ml-auto',
      'group-hover/cloud:invisible',
      'group-focus-within/cloud:invisible'
    )
    expect(settingsButton).toHaveClass(
      'pointer-events-none',
      'group-hover/cloud:pointer-events-auto',
      'group-hover/cloud:opacity-100',
      'group-focus-within/cloud:pointer-events-auto',
      'group-focus-within/cloud:opacity-100'
    )

    await userEvent.click(cloudButton)

    expect(onOpenSettings).toHaveBeenCalledWith({ settingsPage: 'connections' })
  })

  test('opens cloud connection settings from the sidebar cloud management button', async () => {
    const onOpenSettings = vi.fn()
    renderSidebar({
      devices: [localDevice()],
      cloudWorkStatus: cloudWorkStatus({ availability: 'available' }),
      onOpenSettings,
    })

    await userEvent.click(screen.getByTestId('sidebar-cloud-management-button'))

    expect(onOpenSettings).toHaveBeenCalledWith({ settingsPage: 'connections' })
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
    expect(detail.parentElement).toBe(document.body)
    expect(detail).toHaveClass('fixed', 'z-system-popover', 'rounded-xl')
    expect(detail).toHaveTextContent('云端工作不可用')
    expect(detail).toHaveTextContent('云端设备: request timed out')
    expect(detail).toHaveTextContent('云端设备')
    expect(detail).toHaveTextContent('不可用')
    expect(detail).toHaveTextContent('云端任务列表')
    expect(detail).toHaveTextContent('可用')

    await userEvent.click(document.body)
    expect(screen.queryByTestId('sidebar-cloud-error-popover')).not.toBeInTheDocument()
  })

  test('closes cloud work error details with Escape', async () => {
    renderSidebar({
      devices: [localDevice()],
      cloudWorkStatus: cloudWorkStatus({
        availability: 'unavailable',
        checks: { devices: 'unavailable' },
        error: '云端设备: request timed out',
      }),
    })

    await userEvent.click(screen.getByTestId('sidebar-cloud-error-button'))
    expect(screen.getByTestId('sidebar-cloud-error-popover')).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByTestId('sidebar-cloud-error-popover')).not.toBeInTheDocument()
  })

  test('closes cloud work error details when clicking outside', async () => {
    renderSidebar({
      devices: [localDevice()],
      cloudWorkStatus: cloudWorkStatus({
        availability: 'unavailable',
        checks: { devices: 'unavailable', runtimeWork: 'available' },
        error: '云端设备: request timed out',
      }),
    })

    await userEvent.click(screen.getByTestId('sidebar-cloud-error-button'))
    expect(screen.getByTestId('sidebar-cloud-error-popover')).toBeInTheDocument()

    await userEvent.click(document.body)
    expect(screen.queryByTestId('sidebar-cloud-error-popover')).not.toBeInTheDocument()
  })

  test('does not close cloud work error details when clicking inside', async () => {
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

    await userEvent.click(detail)
    expect(screen.getByTestId('sidebar-cloud-error-popover')).toBeInTheDocument()
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

  test('opens plugins navigation from the desktop sidebar', async () => {
    const onOpenPlugins = vi.fn()
    renderSidebar({ onOpenPlugins })

    await userEvent.click(screen.getByTestId('plugins-button'))

    expect(onOpenPlugins).toHaveBeenCalledTimes(1)
  })

  test('opens Sites navigation from the desktop sidebar', async () => {
    const onOpenSites = vi.fn()
    renderSidebar({ onOpenSites, activeItem: 'sites' })

    expect(screen.getByTestId('sites-button')).toHaveAttribute('aria-current', 'page')
    await userEvent.click(screen.getByTestId('sites-button'))

    expect(onOpenSites).toHaveBeenCalledTimes(1)
  })

  test('shows Sites only while experimental features are enabled', async () => {
    experimentalFeatures.enabled = false
    const { unmount } = renderSidebar()

    expect(screen.queryByTestId('sites-button')).not.toBeInTheDocument()

    unmount()
    experimentalFeatures.enabled = true
    renderSidebar()

    expect(screen.getByTestId('sites-button')).toBeInTheDocument()
  })

  test('renders chat runtime tasks as conversations instead of workspace groups', async () => {
    const onOpenRuntimeTask = vi.fn()
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
            tasks: [
              {
                taskId: 'chat-1',
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
            tasks: [
              {
                taskId: 'workspace-1',
                workspacePath: '/tmp/spike',
                title: 'Spike runtime task',
                runtime: 'claude_code',
              },
            ],
          },
        ],
        totalTasks: 2,
      },
      onOpenRuntimeTask,
    })

    expect(screen.getByTestId('runtime-chat-section')).toHaveTextContent('任务')
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

    expect(onOpenRuntimeTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      workspacePath: chatPath,
      taskId: 'chat-1',
    })
  })

  test('removes pinned chat tasks from the task section without highlighted styling', () => {
    const chatPath = '/Users/alice/Documents/Codex/2026-07-12/pinned'
    renderSidebar({
      runtimeWork: {
        projects: [],
        chats: [
          {
            deviceId: 'local-device',
            available: true,
            workspacePath: chatPath,
            workspaceKind: 'chat',
            tasks: [
              {
                taskId: 'pinned-chat',
                threadId: 'pinned-thread',
                workspacePath: chatPath,
                workspaceKind: 'chat',
                title: 'Pinned chat task',
                runtime: 'codex',
                pinned: true,
                pinnedOrder: 0,
              },
            ],
          },
        ],
        totalTasks: 1,
      },
    })

    const pinnedRow = screen.getByTestId('runtime-local-task-row-pinned-chat')
    expect(screen.getByTestId('sidebar-pinned-section')).toContainElement(pinnedRow)
    expect(screen.getByTestId('runtime-chat-section')).not.toContainElement(pinnedRow)
    expect(screen.getByTestId('runtime-chat-empty')).toBeInTheDocument()
    expect(pinnedRow.className).not.toContain('color-sidebar-marked')
  })

  test('moves a chat task to the pinned section before the pin request finishes', async () => {
    let resolvePinRequest: (() => void) | undefined
    const onSetRuntimeTaskPinned = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolvePinRequest = resolve
        })
    )
    const chatPath = '/Users/alice/Documents/Codex/2026-07-12/optimistic-pin'
    renderSidebar({
      runtimeWork: {
        projects: [],
        chats: [
          {
            deviceId: 'local-device',
            available: true,
            workspacePath: chatPath,
            workspaceKind: 'chat',
            tasks: [
              {
                taskId: 'optimistic-chat',
                threadId: 'optimistic-thread',
                workspacePath: chatPath,
                workspaceKind: 'chat',
                title: 'Optimistic pinned task',
                runtime: 'codex',
              },
            ],
          },
        ],
        totalTasks: 1,
      },
      onSetRuntimeTaskPinned,
    })

    await userEvent.click(screen.getByTestId('runtime-local-task-mark-optimistic-chat'))

    await waitFor(() => {
      const pinnedRow = screen.getByTestId('runtime-local-task-row-optimistic-chat')
      expect(screen.getByTestId('sidebar-pinned-section')).toContainElement(pinnedRow)
      expect(screen.getByTestId('runtime-chat-section')).not.toContainElement(pinnedRow)
      expect(pinnedRow.className).not.toContain('color-sidebar-marked')
    })
    expect(onSetRuntimeTaskPinned).toHaveBeenCalledWith({
      deviceId: 'local-device',
      threadId: 'optimistic-thread',
      pinned: true,
    })

    await act(async () => resolvePinRequest?.())
  })

  test('returns a chat task to the task section when pinning fails', async () => {
    const onSetRuntimeTaskPinned = vi.fn().mockRejectedValue(new Error('pin failed'))
    const chatPath = '/Users/alice/Documents/Codex/2026-07-12/pin-failure'
    renderSidebar({
      runtimeWork: {
        projects: [],
        chats: [
          {
            deviceId: 'local-device',
            available: true,
            workspacePath: chatPath,
            workspaceKind: 'chat',
            tasks: [
              {
                taskId: 'failed-pin-chat',
                threadId: 'failed-pin-thread',
                workspacePath: chatPath,
                workspaceKind: 'chat',
                title: 'Failed pinned task',
                runtime: 'codex',
              },
            ],
          },
        ],
        totalTasks: 1,
      },
      onSetRuntimeTaskPinned,
    })

    await userEvent.click(screen.getByTestId('runtime-local-task-mark-failed-pin-chat'))

    await waitFor(() => {
      const taskRow = screen.getByTestId('runtime-local-task-row-failed-pin-chat')
      expect(screen.getByTestId('runtime-chat-section')).toContainElement(taskRow)
      expect(screen.queryByTestId('sidebar-pinned-section')).not.toBeInTheDocument()
    })
  })

  test('exposes pointer and keyboard sorting affordances in the task section', () => {
    const onReorderRuntimeProjectTasks = vi.fn().mockResolvedValue(undefined)
    const chatPath = '/Users/alice/Documents/Codex/2026-07-12/manual'
    renderSidebar({
      runtimeWork: {
        projects: [],
        chats: [
          {
            deviceId: 'local-device',
            available: true,
            workspacePath: chatPath,
            workspaceKind: 'chat',
            tasks: [
              {
                taskId: 'chat-1',
                threadId: 'thread-1',
                workspacePath: chatPath,
                workspaceKind: 'chat',
                title: 'First chat',
                runtime: 'codex',
              },
              {
                taskId: 'chat-2',
                threadId: 'thread-2',
                workspacePath: chatPath,
                workspaceKind: 'chat',
                title: 'Second chat',
                runtime: 'codex',
              },
            ],
          },
        ],
        totalTasks: 2,
      },
      onReorderRuntimeProjectTasks,
    })

    const firstSortable = document.querySelector(
      '[data-sidebar-sortable-id="local-device:thread-1"]'
    ) as HTMLElement
    const secondSortable = document.querySelector(
      '[data-sidebar-sortable-id="local-device:thread-2"]'
    ) as HTMLElement
    expect(screen.getByTestId('runtime-chat-task-sortable-list')).toContainElement(firstSortable)
    expect(firstSortable).toHaveAttribute('tabindex', '0')
    expect(firstSortable).toHaveAttribute('role', 'button')
    expect(firstSortable).toHaveClass('touch-none')
    expect(secondSortable).toHaveAttribute('tabindex', '0')
  })

  test('refreshes relative runtime task time while the sidebar stays mounted', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-03T12:01:00.000Z'))

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
            workspacePath: '/workspace/chats/chat-time',
            workspaceKind: 'chat',
            tasks: [
              {
                taskId: 'chat-time',
                workspacePath: '/workspace/chats/chat-time',
                workspaceKind: 'chat',
                title: 'Time sensitive chat',
                runtime: 'codex',
                updatedAt: '2026-07-03T12:00:00.000Z',
              },
            ],
          },
        ],
        totalTasks: 1,
      },
    })

    expect(screen.getByTestId('runtime-local-task-time-chat-time')).toHaveTextContent('1m')

    act(() => {
      vi.advanceTimersByTime(60_000)
    })

    expect(screen.getByTestId('runtime-local-task-time-chat-time')).toHaveTextContent('2m')
  })

  test('renames a runtime conversation from double click dialog', async () => {
    const user = userEvent.setup()
    const onOpenRuntimeTask = vi.fn()
    const onRenameRuntimeTask = vi.fn().mockResolvedValue(undefined)

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
            tasks: [
              {
                taskId: 'codex-rename',
                workspacePath: '/workspace/chats/chat-rename',
                workspaceKind: 'chat',
                title: '对齐需求核心点',
                runtime: 'codex',
              },
            ],
          },
        ],
        totalTasks: 1,
      },
      onOpenRuntimeTask,
      onRenameRuntimeTask,
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
      expect(onRenameRuntimeTask).toHaveBeenCalledWith(
        {
          deviceId: 'local-device',
          workspacePath: '/workspace/chats/chat-rename',
          taskId: 'codex-rename',
        },
        '对齐方案'
      )
    })
  })

  test('renders project runtime tasks directly under projects and opens by address', async () => {
    const onOpenRuntimeTask = vi.fn()

    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            totalTasks: 1,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                label: 'Wegent local',
                tasks: [
                  {
                    taskId: 'codex-1',
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
        totalTasks: 1,
      },
      onOpenRuntimeTask,
    })

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(screen.queryByTestId('runtime-workspace-row-91')).not.toBeInTheDocument()
    const taskRow = screen.getByTestId('runtime-local-task-row-codex-1')
    expect(taskRow).toHaveTextContent('Fix reconnect')
    expect(taskRow).not.toHaveTextContent('Codex')
    expect(screen.queryByTestId('runtime-local-task-device-marker-codex-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-local-task-device-icon-codex-1')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('runtime-local-task-row-codex-1'))

    expect(onOpenRuntimeTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      workspacePath: '/repo/Wegent',
      taskId: 'codex-1',
    })
  })

  test('expands a project without changing the center selection', async () => {
    const onSelectProject = vi.fn()

    renderSidebar({
      onSelectProject,
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            totalTasks: 1,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: [
                  {
                    taskId: 'codex-1',
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
        totalTasks: 1,
      },
    })

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(onSelectProject).not.toHaveBeenCalled()
    expect(screen.getByTestId('runtime-local-task-row-codex-1')).toBeInTheDocument()
  })

  test('keeps an unavailable remote-only project visible with its IP and gray status', () => {
    renderSidebar({
      devices: [localDevice()],
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'remote-project-id', name: 'Remote Wegent' },
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'remote-device',
                deviceName: '10.201.3.200',
                deviceStatus: 'offline',
                available: false,
                workspacePath: '/home/ubuntu/workspace/Wegent',
                workspaceSource: 'remote',
                remoteHostId: 'remote-ssh-discovered:10.201.3.200',
                tasks: [],
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
                tasks: [],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 0,
      },
    })

    expect(screen.getByText('Remote Wegent')).toBeInTheDocument()
    expect(screen.getByTestId('project-remote-folder-icon-7')).toBeInTheDocument()
    expect(screen.getByTestId('project-device-status-7')).toHaveTextContent('10.201.3.200')
    expect(screen.getByTestId('project-device-status-7-dot')).toHaveClass(
      'bg-[rgb(var(--color-sidebar-text-muted))]',
      'opacity-55'
    )
    expect(screen.getByTestId('project-device-status-7-dot')).not.toHaveAttribute('style')
    expect(screen.getByText('Local Wegent')).toBeInTheDocument()
    expect(screen.getByTestId('project-folder-icon-8')).toBeInTheDocument()
    expect(screen.getAllByTestId('project-item')).toHaveLength(2)
  })

  test('shows cached tasks for an offline remote project without allowing them to open', async () => {
    const onOpenRuntimeTask = vi.fn()
    const onSetRuntimeTaskPinned = vi.fn()
    const onRenameRuntimeTask = vi.fn()
    const onArchiveRuntimeTask = vi.fn()
    renderSidebar({
      devices: [
        localDevice(),
        localDevice({
          id: 2,
          device_id: 'remote-device',
          name: 'Remote Host',
          status: 'offline',
          is_default: false,
          device_type: 'remote',
          client_ip: '10.201.3.200',
        }),
      ],
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'remote-project-id', name: 'Remote Wegent' },
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'remote-device',
                deviceName: '10.201.3.200',
                deviceStatus: 'offline',
                available: false,
                workspacePath: '/home/ubuntu/workspace/Wegent',
                workspaceSource: 'remote',
                remoteHostId: 'remote-ssh-discovered:10.201.3.200',
                tasks: [
                  {
                    taskId: 'cached-remote-task',
                    workspacePath: '/home/ubuntu/workspace/Wegent',
                    title: 'Cached remote task',
                    runtime: 'codex',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 1,
      },
      onOpenRuntimeTask,
      onSetRuntimeTaskPinned,
      onRenameRuntimeTask,
      onArchiveRuntimeTask,
    })

    await userEvent.click(screen.getByTestId('project-item-button'))

    const taskRow = screen.getByTestId('runtime-local-task-row-cached-remote-task')
    expect(taskRow).toHaveAttribute('aria-disabled', 'true')
    expect(taskRow).toHaveAttribute('tabindex', '-1')
    expect(screen.getByTestId('runtime-local-task-mark-cached-remote-task')).toBeDisabled()
    expect(screen.getByTestId('runtime-local-task-archive-cached-remote-task')).toBeDisabled()
    fireEvent.click(taskRow)
    fireEvent.click(screen.getByTestId('runtime-local-task-mark-cached-remote-task'))
    fireEvent.doubleClick(taskRow)
    expect(onOpenRuntimeTask).not.toHaveBeenCalled()
    expect(onSetRuntimeTaskPinned).not.toHaveBeenCalled()
    expect(onRenameRuntimeTask).not.toHaveBeenCalled()
    expect(onArchiveRuntimeTask).not.toHaveBeenCalled()
  })

  test('shows an available remote project IP with green status', () => {
    renderSidebar({
      devices: [
        localDevice(),
        localDevice({
          id: 2,
          device_id: 'remote-device',
          name: 'Remote Host',
          is_default: false,
          device_type: 'remote',
          client_ip: '10.201.3.200',
        }),
      ],
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
                tasks: [],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 0,
      },
    })

    expect(screen.getByTestId('project-device-status-7')).toHaveTextContent('10.201.3.200')
    expect(screen.getByTestId('project-device-status-7-dot')).toHaveStyle({
      backgroundColor: '#1FD660',
    })
    expect(screen.getByTestId('project-device-status-7-dot')).not.toHaveClass(
      'bg-[rgb(var(--color-sidebar-text-muted))]'
    )
  })

  test('shows running status on running runtime tasks only', async () => {
    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            totalTasks: 2,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: [
                  {
                    taskId: 'codex-running',
                    workspacePath: '/repo/Wegent',
                    title: 'Investigate stream',
                    runtime: 'codex',
                    running: true,
                    updatedAt: '2026-06-20T03:00:00Z',
                  },
                  {
                    taskId: 'codex-idle',
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
        totalTasks: 2,
      },
    })

    await userEvent.click(screen.getByTestId('project-item-button'))

    const runningStatus = screen.getByTestId('runtime-local-task-running-codex-running')
    expect(runningStatus).toHaveAttribute('aria-label', '运行中')
    expect(runningStatus).not.toHaveTextContent('运行中')
    expect(runningStatus.querySelector('svg')).not.toBeNull()
    expect(screen.queryByTestId('runtime-local-task-running-codex-idle')).not.toBeInTheDocument()
  })

  test('shows unread dot from shared runtime task reminder state', async () => {
    const onOpenRuntimeTask = vi.fn()
    const onMarkRuntimeTaskRead = vi.fn()
    const completedRuntimeWork = {
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          totalTasks: 1,
          deviceWorkspaces: [
            {
              id: 91,
              deviceId: 'local-device',
              deviceName: 'Local Mac',
              deviceStatus: 'online',
              available: true,
              workspacePath: '/repo/Wegent',
              tasks: [
                {
                  taskId: 'codex-background',
                  workspacePath: '/repo/Wegent',
                  title: 'Background task',
                  runtime: 'codex' as const,
                  running: false,
                  updatedAt: '2026-06-20T03:00:00Z',
                },
              ],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 1,
    }

    renderSidebar({
      runtimeWork: completedRuntimeWork,
      onOpenRuntimeTask,
      onMarkRuntimeTaskRead,
      unreadRuntimeTaskKeys: new Set(['local-device\0codex-background']),
    })

    await userEvent.click(screen.getByTestId('project-item-button'))

    const unreadDot = screen.getByTestId('runtime-local-task-unread-dot-codex-background')
    expect(unreadDot).toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-time-codex-background')).toContainElement(
      unreadDot
    )

    await userEvent.click(screen.getByTestId('runtime-local-task-row-codex-background'))

    expect(onOpenRuntimeTask).toHaveBeenCalledTimes(1)
    expect(onMarkRuntimeTaskRead).toHaveBeenCalledTimes(1)
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
            totalTasks: 2,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: [
                  {
                    taskId: 'local-task',
                    workspacePath: '/repo/Wegent',
                    title: 'Runtime task',
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
                tasks: [
                  {
                    taskId: 'cloud-task',
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
        totalTasks: 2,
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

  test('optimistically archives project runtime tasks with an undo notice', async () => {
    const user = userEvent.setup()
    const onArchiveRuntimeTask = vi.fn().mockResolvedValue(undefined)
    const originalSetTimeout = window.setTimeout
    const originalClearTimeout = window.clearTimeout
    const archiveTimerId = 3000
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
              totalTasks: 1,
              deviceWorkspaces: [
                {
                  id: 91,
                  deviceId: 'local-device',
                  deviceName: 'Local Mac',
                  deviceStatus: 'online',
                  available: true,
                  workspacePath: '/repo/Wegent',
                  tasks: [
                    {
                      taskId: 'codex-1',
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
          totalTasks: 1,
        },
        onArchiveRuntimeTask,
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

      expect(onArchiveRuntimeTask).not.toHaveBeenCalled()
      expect(taskRow).toHaveClass('hidden')
      expect(screen.getByTestId('runtime-local-task-archive-toast-codex-1')).toHaveTextContent(
        '撤销'
      )

      await user.click(screen.getByTestId('runtime-local-task-archive-undo-codex-1'))

      expect(onArchiveRuntimeTask).not.toHaveBeenCalled()
      expect(taskRow).not.toHaveClass('hidden')
      expect(archiveTimerCallback).toBeNull()

      await user.click(screen.getByTestId('runtime-local-task-archive-codex-1'))
      const runArchiveTimer = archiveTimerCallback
      await act(async () => {
        runArchiveTimer?.()
        await Promise.resolve()
      })

      await waitFor(() =>
        expect(onArchiveRuntimeTask).toHaveBeenCalledWith({
          deviceId: 'local-device',
          workspacePath: '/repo/Wegent',
          taskId: 'codex-1',
        })
      )
    } finally {
      setTimeoutSpy.mockRestore()
      clearTimeoutSpy.mockRestore()
    }
  })

  test('offers force archive when a worktree task has uncommitted changes', async () => {
    const user = userEvent.setup()
    const onArchiveRuntimeTask = vi
      .fn()
      .mockResolvedValueOnce({ status: 'dirty_worktree' })
      .mockResolvedValueOnce({ status: 'archived' })
    const originalSetTimeout = window.setTimeout
    const archiveTimerId = 3000
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

    try {
      renderSidebar({
        runtimeWork: {
          projects: [
            {
              project: { id: 7, name: 'Wegent' },
              totalTasks: 1,
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
                  tasks: [
                    {
                      taskId: 'codex-1',
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
          totalTasks: 1,
        },
        onArchiveRuntimeTask,
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
      expect(onArchiveRuntimeTask).toHaveBeenCalledTimes(1)
      expect(onArchiveRuntimeTask).toHaveBeenNthCalledWith(1, {
        deviceId: 'local-device',
        workspacePath: '/repo/worktrees/9/Wegent',
        taskId: 'codex-1',
      })

      await user.click(
        screen.getByTestId('runtime-local-task-force-archive-dialog-codex-1-confirm-button')
      )

      await waitFor(() => expect(onArchiveRuntimeTask).toHaveBeenCalledTimes(2))
      expect(onArchiveRuntimeTask).toHaveBeenNthCalledWith(
        2,
        {
          deviceId: 'local-device',
          workspacePath: '/repo/worktrees/9/Wegent',
          taskId: 'codex-1',
        },
        { force: true }
      )
      expect(
        screen.queryByTestId('runtime-local-task-force-archive-dialog-codex-1')
      ).not.toBeInTheDocument()
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })

  test('pins and unpins runtime tasks without opening the task', async () => {
    const user = userEvent.setup()
    const onOpenRuntimeTask = vi.fn()
    const onSetRuntimeTaskPinned = vi.fn().mockResolvedValue(undefined)

    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'project-7', name: 'Wegent', stateDeviceId: 'local-device' },
            totalTasks: 1,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: [
                  {
                    taskId: 'codex-1',
                    threadId: 'thread-1',
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
        totalTasks: 1,
      },
      onOpenRuntimeTask,
      onSetRuntimeTaskPinned,
    })

    await user.click(screen.getByTestId('project-item-button'))

    const taskRow = screen.getByTestId('runtime-local-task-row-codex-1')
    const markButton = screen.getByTestId('runtime-local-task-mark-codex-1')
    const pinIcon = screen.getByTestId('runtime-local-task-pin-icon-codex-1')

    expect(taskRow).not.toHaveAttribute('data-marked')
    expect(taskRow.className).not.toContain('color-sidebar-marked')

    await user.click(markButton)

    expect(taskRow).toHaveAttribute('data-marked', 'true')
    expect(taskRow.className).not.toContain('color-sidebar-marked')
    expect(pinIcon).toHaveClass('fill-current')
    expect(markButton).toHaveAttribute('aria-label', '取消置顶')
    expect(onOpenRuntimeTask).not.toHaveBeenCalled()
    expect(onSetRuntimeTaskPinned).toHaveBeenLastCalledWith({
      deviceId: 'local-device',
      threadId: 'thread-1',
      pinned: true,
    })

    await user.click(markButton)

    expect(taskRow).not.toHaveAttribute('data-marked')
    expect(taskRow.className).not.toContain('color-sidebar-marked')
    expect(pinIcon).not.toHaveClass('fill-current')
    expect(markButton).toHaveAttribute('aria-label', '置顶任务')
    expect(onSetRuntimeTaskPinned).toHaveBeenLastCalledWith({
      deviceId: 'local-device',
      threadId: 'thread-1',
      pinned: false,
    })
  })

  test('pins Codex tasks that only expose the thread id as taskId', async () => {
    const onSetRuntimeTaskPinned = vi.fn().mockResolvedValue(undefined)
    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'project-7', name: 'Wegent' },
            totalTasks: 1,
            deviceWorkspaces: [
              {
                deviceId: 'local-device',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: [
                  {
                    taskId: 'legacy-thread-id',
                    workspacePath: '/repo/Wegent',
                    title: 'Legacy Codex task',
                    runtime: 'codex',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 1,
      },
      onSetRuntimeTaskPinned,
    })

    await userEvent.click(screen.getByTestId('project-item-button'))
    const pinButton = screen.getByTestId('runtime-local-task-mark-legacy-thread-id')
    expect(pinButton).not.toBeDisabled()

    await userEvent.click(pinButton)

    expect(onSetRuntimeTaskPinned).toHaveBeenCalledWith({
      deviceId: 'local-device',
      threadId: 'legacy-thread-id',
      pinned: true,
    })
    expect(pinButton).toHaveAttribute('aria-label', '取消置顶')
  })

  test('reserves runtime task hover actions without padding the truncated title', async () => {
    const user = userEvent.setup()
    const taskTitle = '修复进行中任务未显示 tool 调用'

    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            totalTasks: 1,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: [
                  {
                    taskId: 'codex-1',
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
        totalTasks: 1,
      },
    })

    await user.click(screen.getByTestId('project-item-button'))

    const title = screen.getByText(taskTitle)
    const trailing = screen.getByTestId('runtime-local-task-trailing-codex-1')
    const hoverActions = screen.getByTestId('runtime-local-task-hover-actions-codex-1')

    expect(title).toHaveClass('min-w-0', 'flex-1', 'truncate')
    expect(title).not.toHaveClass('group-hover/task:pr-20')
    expect(trailing).toHaveClass('min-w-[30px]', 'group-hover/task:w-[68px]')
    expect(hoverActions).toHaveClass('absolute', 'right-0', 'w-[72px]')
  })

  test('renders Codex-pinned runtime tasks in the pinned section', async () => {
    const user = userEvent.setup()

    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            totalTasks: 3,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: [
                  {
                    taskId: 'new-task',
                    workspacePath: '/repo/Wegent',
                    title: 'New task',
                    runtime: 'codex',
                    updatedAt: '2026-06-22T00:00:00Z',
                  },
                  {
                    taskId: 'middle-task',
                    workspacePath: '/repo/Wegent',
                    title: 'Middle task',
                    runtime: 'codex',
                    updatedAt: '2026-06-21T00:00:00Z',
                  },
                  {
                    taskId: 'old-task',
                    threadId: 'old-thread',
                    pinned: true,
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
        totalTasks: 3,
      },
    })

    await user.click(screen.getByTestId('project-item-button'))

    const rowTestIds = () =>
      screen.getAllByTestId(/^runtime-local-task-row-/).map(row => row.getAttribute('data-testid'))

    expect(rowTestIds()).toEqual([
      'runtime-local-task-row-old-task',
      'runtime-local-task-row-new-task',
      'runtime-local-task-row-middle-task',
    ])
    expect(screen.getByTestId('sidebar-pinned-section')).toContainElement(
      screen.getByTestId('runtime-local-task-row-old-task')
    )
  })

  test('excludes pinned runtime tasks from the collapsed project task count', async () => {
    const user = userEvent.setup()

    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            totalTasks: 6,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: Array.from({ length: 6 }, (_, index) => ({
                  taskId: `task-${index + 1}`,
                  threadId: `thread-${index + 1}`,
                  pinned: index === 0,
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
        totalTasks: 6,
      },
    })

    await user.click(screen.getByTestId('project-item-button'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(6)
    expect(screen.queryByTestId('project-runtime-tasks-expand-7')).not.toBeInTheDocument()
    expect(screen.queryByTestId('project-runtime-tasks-collapse-7')).not.toBeInTheDocument()
  })

  test('stores runtime task pinning in Codex global state instead of localStorage', async () => {
    const user = userEvent.setup()
    const onSetRuntimeTaskPinned = vi.fn().mockResolvedValue(undefined)
    const runtimeWork = {
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          totalTasks: 3,
          deviceWorkspaces: [
            {
              id: 91,
              deviceId: 'local-device',
              deviceName: 'Local Mac',
              deviceStatus: 'online',
              available: true,
              workspacePath: '/repo/Wegent',
              tasks: [
                {
                  taskId: 'old-task',
                  threadId: 'old-thread',
                  workspacePath: '/repo/Wegent',
                  title: 'Old task',
                  runtime: 'codex',
                  updatedAt: '2026-06-20T00:00:00Z',
                },
                {
                  taskId: 'new-task',
                  workspacePath: '/repo/Wegent',
                  title: 'New task',
                  runtime: 'codex',
                  updatedAt: '2026-06-22T00:00:00Z',
                },
                {
                  taskId: 'middle-task',
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
      totalTasks: 3,
    }
    renderSidebar({ runtimeWork, onSetRuntimeTaskPinned })

    await user.click(screen.getByTestId('project-item-button'))
    await user.click(screen.getByTestId('runtime-local-task-mark-old-task'))

    expect(onSetRuntimeTaskPinned).toHaveBeenCalledWith({
      deviceId: 'local-device',
      threadId: 'old-thread',
      pinned: true,
    })
    expect(localStorage.getItem('wework.desktop.sidebar.pinnedRuntimeTaskKeys.7.1')).toBeNull()
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
            totalTasks: 2,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: [
                  {
                    taskId: 'codex-1',
                    workspacePath: '/repo/Wegent',
                    title: 'Fix reconnect',
                    runtime: 'codex',
                  },
                  {
                    taskId: 'codex-2',
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
        totalTasks: 2,
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
            totalTasks: 1,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: [
                  {
                    taskId: 'codex-1',
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
        totalTasks: 1,
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

  test('opens a local runtime project folder in Finder from the project row menu', async () => {
    const user = userEvent.setup()

    renderSidebar({
      projects: [],
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'project:7', name: 'Wegent' },
            totalTasks: 0,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/Users/alice/dev/Wegent',
                workspaceKind: 'workspace',
                workspaceSource: 'local',
                tasks: [],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 0,
      },
    })

    await user.click(screen.getByTestId('project-menu-7'))
    await user.click(screen.getByTestId('show-project-in-finder-7'))

    expect(openLocalWorkspace).toHaveBeenCalledWith({
      opener: 'finder',
      path: '/Users/alice/dev/Wegent',
    })
  })

  test('creates a permanent worktree from a runtime project', async () => {
    const user = userEvent.setup()
    const onCreatePermanentWorktree = vi.fn().mockResolvedValue(undefined)

    renderSidebar({
      projects: [],
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'project:7', name: 'Wegent' },
            totalTasks: 0,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/Users/alice/dev/Wegent',
                workspaceKind: 'workspace',
                workspaceSource: 'local',
                tasks: [],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 0,
      },
      onCreatePermanentWorktree,
    })

    await user.click(screen.getByTestId('project-menu-7'))
    await user.click(screen.getByTestId('create-permanent-worktree-7'))

    expect(screen.getByTestId('permanent-worktree-name-7')).toHaveValue('Wegent_2')
    await user.clear(screen.getByTestId('permanent-worktree-name-7'))
    await user.type(screen.getByTestId('permanent-worktree-name-7'), 'Wegent docs')
    await user.click(screen.getByTestId('confirm-create-permanent-worktree-7'))

    await waitFor(() => {
      expect(onCreatePermanentWorktree).toHaveBeenCalledWith({
        deviceId: 'local-device',
        sourcePath: '/Users/alice/dev/Wegent',
        name: 'Wegent docs',
      })
    })
  })

  test('hides the Finder action for remote runtime project folders', async () => {
    const user = userEvent.setup()

    renderSidebar({
      projects: [],
      devices: [
        localDevice({
          id: 2,
          device_id: 'remote-device',
          name: 'Remote Box',
          device_type: 'remote',
        }),
      ],
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'project:7', name: 'Wegent' },
            totalTasks: 1,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'remote-device',
                deviceName: 'Remote Box',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/home/alice/Wegent',
                workspaceKind: 'workspace',
                workspaceSource: 'remote',
                tasks: [
                  {
                    taskId: 'codex-1',
                    workspacePath: '/home/alice/Wegent',
                    title: 'Remote work',
                    runtime: 'codex',
                  },
                ],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 1,
      },
    })

    await user.click(screen.getByTestId('project-menu-7'))

    expect(screen.queryByTestId('show-project-in-finder-7')).not.toBeInTheDocument()
    expect(openLocalWorkspace).not.toHaveBeenCalled()
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

  test('hides global IM notifications while experimental features are disabled', () => {
    experimentalFeatures.enabled = false

    renderSidebar({ onToggleGlobalImNotification: vi.fn() })

    expect(screen.queryByTestId('sidebar-global-im-notification-button')).not.toBeInTheDocument()
  })

  test('anchors the away reminder menu to the full-width account area', async () => {
    // Regression guard (POPOVER-CONTAINING-BLOCK-MISMATCH): the menu must portal
    // into the full-width account/settings container (group/account), not remain
    // a child of the narrow 32px icon-action group, otherwise `left-4 right-4`
    // resolves against the icon group and the panel collapses to a sliver.
    const user = userEvent.setup()

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
      onToggleGlobalImNotification: vi.fn(),
    })

    await user.click(screen.getByTestId('sidebar-global-im-notification-button'))

    const menu = screen.getByTestId('sidebar-global-im-notification-menu')

    // The menu DOM owner must be the account area, reachable through the
    // group/account container — never the icon-action group wrapper.
    const accountArea = menu.closest('.group\\/account')
    expect(accountArea, 'menu must be portalled into the account area').not.toBeNull()

    const iconGroup = screen.getByTestId('sidebar-global-im-notification-button').parentElement
    expect(
      iconGroup?.contains(menu),
      'menu must NOT stay inside the narrow icon-action group'
    ).toBe(false)

    // jsdom does not compute CSS layout, so a numeric width floor is not
    // enforceable here; the DOM-ownership assertions above are the durable
    // guard against the containing-block regression.
    expect(menu).toBeInTheDocument()
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
    const onStartStandaloneChat = vi.fn()

    renderSidebar({
      onNewChat,
      onStartStandaloneChat,
      onArchiveProjectsConversations,
      onArchiveChatConversations,
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'project:7', name: 'Wegent' },
            totalTasks: 1,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: [
                  {
                    taskId: 'codex-1',
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
            tasks: [
              {
                taskId: 'chat-1',
                workspacePath: '/workspace/chats/chat-1',
                workspaceKind: 'chat',
                title: 'Hello',
                runtime: 'codex',
              },
            ],
          },
        ],
        totalTasks: 2,
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
    expect(onStartStandaloneChat).toHaveBeenCalledTimes(1)
    expect(onNewChat).not.toHaveBeenCalled()

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
            taskId: 'chat-1',
          },
        ],
        undefined
      )
    })
  })

  test('shows a subscribed runtime task notification toggle outside hover actions', async () => {
    const user = userEvent.setup()
    const onToggleRuntimeTaskNotification = vi.fn()
    const onOpenRuntimeTask = vi.fn()

    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            totalTasks: 1,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: [
                  {
                    taskId: 'codex-1',
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
        totalTasks: 1,
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
              taskId: 'codex-1',
            },
            sessionKeys: ['session-telegram'],
          },
        ],
      },
      onOpenRuntimeTask,
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
        taskId: 'codex-1',
      },
      true
    )
    expect(onOpenRuntimeTask).not.toHaveBeenCalled()
  })

  test('shows an empty task state when a project has no runtime tasks', async () => {
    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            totalTasks: 0,
            deviceWorkspaces: [
              {
                id: 92,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                label: 'Duplicated project label should not hide the path',
                tasks: [],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 0,
      },
    })

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(screen.queryByTestId('runtime-workspace-row-92')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-local-tasks-empty-7')).toHaveTextContent('暂无会话')
  })

  test('shows managed worktree tasks directly under the source project with device marker', async () => {
    const onOpenRuntimeTask = vi.fn()

    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            totalTasks: 1,
            deviceWorkspaces: [
              {
                id: null,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/workspace/Wegent',
                tasks: [
                  {
                    taskId: 'codex-worktree',
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
        totalTasks: 1,
      },
      onOpenRuntimeTask,
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

    expect(onOpenRuntimeTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      workspacePath: '/workspace/worktrees/42/Wegent',
      taskId: 'codex-worktree',
    })
  })

  test('limits project runtime tasks to five newest rows', async () => {
    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            totalTasks: 6,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: [
                  {
                    taskId: 'task-oldest',
                    workspacePath: '/repo/Wegent',
                    title: 'Oldest hidden task',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T01:00:00Z',
                  },
                  {
                    taskId: 'task-third',
                    workspacePath: '/repo/Wegent',
                    title: 'Third task',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T04:00:00Z',
                  },
                  {
                    taskId: 'task-newest',
                    workspacePath: '/repo/Wegent',
                    title: 'Newest task',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T06:00:00Z',
                  },
                  {
                    taskId: 'task-fifth',
                    workspacePath: '/repo/Wegent',
                    title: 'Fifth task',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T02:00:00Z',
                  },
                  {
                    taskId: 'task-second',
                    workspacePath: '/repo/Wegent',
                    title: 'Second task',
                    runtime: 'codex',
                    updatedAt: '2026-06-20T05:00:00Z',
                  },
                  {
                    taskId: 'task-fourth',
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
        totalTasks: 6,
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
            totalTasks: 26,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: Array.from({ length: 26 }, (_, index) => ({
                  taskId: `task-${index + 1}`,
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
        totalTasks: 26,
      },
    })

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(5)

    await userEvent.click(screen.getByTestId('project-runtime-tasks-expand-7'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(15)
    expect(screen.getByTestId('project-runtime-tasks-expand-7')).toHaveTextContent('展开显示')
    expect(screen.queryByTestId('project-runtime-tasks-collapse-7')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('project-runtime-tasks-expand-7'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(25)
    expect(screen.getByTestId('project-runtime-tasks-expand-7')).toBeInTheDocument()
    expect(screen.queryByTestId('project-runtime-tasks-collapse-7')).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('project-runtime-tasks-expand-7'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(26)
    expect(screen.queryByTestId('project-runtime-tasks-expand-7')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-runtime-tasks-collapse-7')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('project-runtime-tasks-collapse-7'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(5)
    expect(screen.getByTestId('project-runtime-tasks-expand-7')).toBeInTheDocument()
    expect(screen.queryByTestId('project-runtime-tasks-collapse-7')).not.toBeInTheDocument()
  })

  test('shows one project runtime task action after the task list grows past the current limit', async () => {
    const runtimeWorkWithTaskCount = (count: number) => ({
      projects: [
        {
          project: { id: 7, name: 'Wegent' },
          totalTasks: count,
          deviceWorkspaces: [
            {
              id: 91,
              deviceId: 'local-device',
              deviceName: 'Local Mac',
              deviceStatus: 'online',
              available: true,
              workspacePath: '/repo/Wegent',
              tasks: Array.from({ length: count }, (_, index) => ({
                taskId: `task-${index + 1}`,
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
      totalTasks: count,
    })

    const view = renderSidebar({ runtimeWork: runtimeWorkWithTaskCount(6) })

    await userEvent.click(screen.getByTestId('project-item-button'))
    await userEvent.click(screen.getByTestId('project-runtime-tasks-expand-7'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(6)
    expect(screen.queryByTestId('project-runtime-tasks-expand-7')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-runtime-tasks-collapse-7')).toBeInTheDocument()

    view.rerender(
      <DesktopSidebar {...createSidebarProps({ runtimeWork: runtimeWorkWithTaskCount(16) })} />
    )

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(6)
    expect(screen.getByTestId('project-runtime-tasks-expand-7')).toHaveTextContent('展开显示')
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
        taskId: 'codex-active',
      },
      runtimeWork: {
        projects: [
          {
            project: { id: 7, name: 'Wegent' },
            totalTasks: 1,
            deviceWorkspaces: [
              {
                id: 91,
                deviceId: 'local-device',
                deviceName: 'Local Mac',
                deviceStatus: 'online',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: [
                  {
                    taskId: 'codex-active',
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
        totalTasks: 1,
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
            totalTasks: 0,
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
                tasks: [],
              },
            ],
          },
        ],
        chats: [],
        totalTasks: 0,
      },
    })

    const button = screen.getByTestId('project-item-button')
    expect(button).toHaveTextContent('hello 20')
    expect(button).toHaveAttribute('aria-expanded', 'true')
  })
})
