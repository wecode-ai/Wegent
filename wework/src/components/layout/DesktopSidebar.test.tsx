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
import { setActiveKeybindings, TOGGLE_PRIORITY_FILTER_COMMAND } from '@/lib/keybindings'
import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import type { ProjectSpaceApi } from '@/features/todo/projectSpaceSelection'
import {
  dispatchWorkbenchSidebarPaneDragCancel,
  dispatchWorkbenchSidebarPaneDragStart,
} from './workbenchPaneDrag'
import {
  cacheRuntimeConversationQueuePaused,
  clearRuntimeConversationCacheForTests,
} from '@/features/workbench/runtimeConversationCache'
import type { TaskChangeRequestSnapshot } from '@/api/changeRequests'
import * as changeRequestMonitor from '@/features/workbench/changeRequestMonitor'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { preloadDefaultDshUiTestModules } from '@/test/setup'
import { installGitUiTestContributions } from '../../../dsh/ui-git/test-support'

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
  appUpdate?: Partial<AppUpdateContextValue>,
  workbench?: Partial<WorkbenchContextValue>
) {
  const props: Parameters<typeof DesktopSidebar>[0] = createSidebarProps(overrides)
  const lifecycleStore = new RuntimeTaskLifecycleStore('desktop-sidebar-test')
  lifecycleStore.syncRuntimeWork(props.runtimeWork)

  let tree = (
    <RuntimeTaskLifecycleProvider store={lifecycleStore}>
      <DesktopSidebar {...props} />
    </RuntimeTaskLifecycleProvider>
  )
  if (workbench) {
    tree = (
      <WorkbenchContext.Provider value={workbench as WorkbenchContextValue}>
        {tree}
      </WorkbenchContext.Provider>
    )
  }
  if (appUpdate) {
    const value: AppUpdateContextValue = {
      updateChannel: 'stable',
      autoUpdateEnabled: true,
      availableUpdate: null,
      installedReleaseNotes: null,
      status: 'idle',
      downloadProgress: null,
      error: null,
      checkNow: vi.fn().mockResolvedValue(null),
      installUpdate: vi.fn().mockResolvedValue(undefined),
      dismissInstalledReleaseNotes: vi.fn(),
      setAutoUpdateEnabled: vi.fn(),
      setUpdateChannel: vi.fn().mockResolvedValue(undefined),
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

function enableElectron() {
  window.__WEWORK_RUNTIME_CONFIG__ = {
    ...window.__WEWORK_RUNTIME_CONFIG__,
    desktopHost: 'electron',
  }
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
  })
}

function mockSidebarSortableRect(element: HTMLElement, top: number) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: top,
    top,
    left: 0,
    right: 240,
    bottom: top + 30,
    width: 240,
    height: 30,
    toJSON: () => ({}),
  } as DOMRect)
}

async function waitForSidebarPointerSensorCleanup() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 60))
  })
}

// Compile the injected DSH modules outside the per-test hook timeout. The setup hook
// still clears and restores the module cache before every test to preserve isolation.
await preloadDefaultDshUiTestModules()

describe('DesktopSidebar', () => {
  beforeEach(async () => {
    await preloadDefaultDshUiTestModules()
    await installGitUiTestContributions()
    experimentalFeatures.enabled = true
    window.history.replaceState({}, '', '/')
    localStorage.clear()
    enableElectron()
    setActiveKeybindings([])
    Element.prototype.scrollIntoView = vi.fn()
    vi.mocked(openLocalWorkspace).mockReset()
    clearRuntimeConversationCacheForTests()
  }, 60_000)

  afterEach(() => {
    clearRuntimeConversationCacheForTests()
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  test('keeps project and task section header actions visible outside the flex layout', () => {
    renderSidebar()

    const projectActions = screen.getByTestId('projects-section-toggle-actions')
    const taskActions = screen.getByTestId('runtime-chat-section-toggle-actions')

    expect(projectActions).toHaveClass('absolute', 'right-1', 'z-[70]')
    expect(projectActions).not.toHaveClass('pointer-events-none', 'opacity-0')
    expect(taskActions).toHaveClass('absolute', 'right-1', 'z-[70]')
    expect(taskActions).not.toHaveClass('pointer-events-none', 'opacity-0')
    expect(screen.getByTestId('projects-create-button')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-chat-section-new-chat-button')).toBeInTheDocument()
  })

  test('shows a discoverable project creation action when the project list is empty', async () => {
    renderSidebar({
      projects: [],
      runtimeWork: { projects: [], chats: [], totalTasks: 0 },
      cloudWorkStatus: cloudWorkStatus({
        availability: 'empty',
        checks: { runtimeWork: 'empty' },
      }),
    })

    const createButton = screen.getByTestId('projects-empty-create-button')
    expect(createButton).toHaveTextContent('新建项目')

    await userEvent.click(createButton)

    expect(screen.getByTestId('projects-create-button-menu')).toBeInTheDocument()
  })

  test('does not show the empty project creation action while projects are syncing', () => {
    renderSidebar({
      projects: [],
      runtimeWork: { projects: [], chats: [], totalTasks: 0 },
      cloudWorkStatus: cloudWorkStatus({
        availability: 'syncing',
        checks: { runtimeWork: 'syncing' },
      }),
    })

    expect(screen.queryByTestId('projects-empty-create-button')).not.toBeInTheDocument()
  })

  test('does not show the empty project creation action before runtime work loads', () => {
    renderSidebar({
      projects: [],
      runtimeWork: null,
      cloudWorkStatus: cloudWorkStatus({
        availability: 'idle',
        checks: { runtimeWork: 'idle' },
      }),
    })

    expect(screen.queryByTestId('projects-empty-create-button')).not.toBeInTheDocument()
  })

  test('keeps the sidebar color stable across browser focus changes', () => {
    renderSidebar()
    const sidebar = screen.getByTestId('desktop-sidebar')

    act(() => window.dispatchEvent(new Event('focus')))
    expect(sidebar).toHaveClass('bg-[rgb(var(--color-sidebar))]')

    act(() => window.dispatchEvent(new Event('blur')))
    expect(sidebar).toHaveClass('bg-[rgb(var(--color-sidebar))]')
  })

  test('keeps the shared right border and forces an opaque sidebar on Windows', () => {
    enableElectron()
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.0',
    })
    renderSidebar()
    const sidebar = screen.getByTestId('desktop-sidebar')
    expect(sidebar).toHaveClass('border-r')
    // Windows WebView2 cannot render a translucent window, so the sidebar opts
    // out of the translucent background. The dark-theme CSS in globals.css must
    // keep this opaque background dark instead of falling back to light.
    expect(sidebar).toHaveAttribute('data-sidebar-translucent', 'false')
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

  test('starts project pointer sorting only from its content-sized activator', async () => {
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
    const localSortable = document.querySelector(
      '[data-sidebar-sortable-id="local-device:/repo/local"]'
    ) as HTMLElement
    const remoteActivator = screen.getByTestId('project-drag-activator-8')
    const remoteButton = remoteActivator.closest('button') as HTMLButtonElement
    const remoteMetadata = screen.getByTestId('project-device-status-8')

    mockSidebarSortableRect(localSortable, 0)
    mockSidebarSortableRect(remoteSortable, 30)

    expect(remoteSortable).toHaveAttribute('tabindex', '0')
    expect(remoteSortable).toHaveAttribute('role', 'button')
    expect(remoteActivator).not.toHaveAttribute('data-sidebar-drag-activator')
    expect(remoteButton).toHaveAttribute('data-sidebar-drag-activator')
    expect(remoteMetadata).toHaveClass(
      'pointer-events-auto',
      'group-hover/project:opacity-0',
      'group-focus-within/project:opacity-0'
    )
    expect(remoteMetadata).not.toHaveClass(
      'group-hover/project:invisible',
      'group-focus-within/project:invisible'
    )

    fireEvent.pointerDown(remoteMetadata, {
      button: 0,
      buttons: 1,
      clientX: 220,
      clientY: 45,
      isPrimary: true,
      pointerId: 1,
    })
    fireEvent.pointerMove(document, {
      buttons: 1,
      clientX: 220,
      clientY: 10,
      isPrimary: true,
      pointerId: 1,
    })
    expect(remoteSortable).not.toHaveAttribute('data-dragging')
    fireEvent.pointerUp(document, {
      button: 0,
      buttons: 0,
      clientX: 220,
      clientY: 10,
      isPrimary: true,
      pointerId: 1,
    })

    fireEvent.pointerDown(remoteButton, {
      button: 0,
      buttons: 1,
      clientX: 220,
      clientY: 45,
      isPrimary: true,
      pointerId: 2,
    })
    fireEvent.pointerMove(document, {
      buttons: 1,
      clientX: 220,
      clientY: 10,
      isPrimary: true,
      pointerId: 2,
    })
    expect(remoteSortable).toHaveAttribute('data-dragging', 'true')
    fireEvent.pointerMove(document, {
      buttons: 1,
      clientX: 220,
      clientY: 5,
      isPrimary: true,
      pointerId: 2,
    })
    fireEvent.pointerUp(document, {
      button: 0,
      buttons: 0,
      clientX: 220,
      clientY: 5,
      isPrimary: true,
      pointerId: 2,
    })

    await waitFor(() => expect(onReorderRuntimeProjects).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(remoteSortable).not.toHaveAttribute('data-dragging'))
    await waitForSidebarPointerSensorCleanup()
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
      error: {
        stage: 'check',
        kind: 'unsupported',
        code: 'APP_UPDATE_UNAVAILABLE',
        occurredAt: 1,
        detail: null,
      },
    })

    expect(screen.queryByTestId('sidebar-app-update-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-app-update-action')).not.toBeInTheDocument()
    expect(screen.getByTestId('settings-button')).toHaveClass('pr-10')
  })

  test('shows installed release notes above the account row and opens details on demand', async () => {
    renderSidebar({}, undefined, {
      installedReleaseNotes: {
        version: '0.2.0',
        body: '## Changes\n\n- Added the new changelog card.\n\n[Learn more](https://example.com)',
      },
    })

    const card = screen.getByTestId('sidebar-release-notes-card')
    const account = screen.getByTestId('settings-button')
    const openButton = screen.getByTestId('sidebar-release-notes-open')
    expect(card.compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(card).toHaveTextContent('Wework 已更新至 v0.2.0')
    expect(screen.queryByTestId('app-release-notes-dialog')).not.toBeInTheDocument()

    await userEvent.click(openButton)

    expect(screen.getByTestId('app-release-notes-dialog')).toBeInTheDocument()
    expect(screen.getByTestId('app-release-notes-content')).toHaveTextContent(
      'Added the new changelog card.'
    )
    const closeButton = screen.getByTestId('app-release-notes-dialog-close')
    const releaseNotesLink = screen.getByRole('link', { name: 'Learn more' })
    await waitFor(() => expect(closeButton).toHaveFocus())

    await userEvent.tab()
    expect(releaseNotesLink).toHaveFocus()
    await userEvent.tab()
    expect(closeButton).toHaveFocus()
    await userEvent.tab({ shift: true })
    expect(releaseNotesLink).toHaveFocus()

    await userEvent.click(closeButton)

    expect(screen.queryByTestId('app-release-notes-dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('sidebar-release-notes-card')).toBeInTheDocument()
    expect(openButton).toHaveFocus()
  })

  test('dismisses the installed release notes card only from its close action', async () => {
    const dismissInstalledReleaseNotes = vi.fn()
    renderSidebar({}, undefined, {
      installedReleaseNotes: {
        version: '0.2.0',
        body: '## Changes',
      },
      dismissInstalledReleaseNotes,
    })

    await userEvent.click(screen.getByTestId('sidebar-release-notes-dismiss'))

    expect(dismissInstalledReleaseNotes).toHaveBeenCalledTimes(1)
  })

  test('shows download progress in the account-row update icon', () => {
    renderSidebar({}, undefined, {
      availableUpdate: { currentVersion: '0.1.0', version: '0.1.1' },
      status: 'downloading',
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

  test('filters the sidebar to unread, active, and waiting conversations', async () => {
    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'project-7', name: 'Wegent' },
            totalTasks: 3,
            deviceWorkspaces: [
              {
                deviceId: 'local-device',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: [
                  {
                    taskId: 'running-task',
                    workspacePath: '/repo/Wegent',
                    title: 'Running task',
                    runtime: 'codex',
                    running: true,
                  },
                  {
                    taskId: 'waiting-task',
                    workspacePath: '/repo/Wegent',
                    title: 'Waiting task',
                    runtime: 'codex',
                    status: 'waiting_for_user_input',
                  },
                  {
                    taskId: 'running-waiting-task',
                    workspacePath: '/repo/Wegent',
                    title: 'Running waiting task',
                    runtime: 'codex',
                    running: true,
                    status: 'waiting_for_user_input',
                  },
                  {
                    taskId: 'idle-task',
                    workspacePath: '/repo/Wegent',
                    title: 'Idle task',
                    runtime: 'codex',
                  },
                ],
              },
            ],
          },
        ],
        chats: [
          {
            deviceId: 'local-device',
            available: true,
            workspacePath: '/workspace/chats/unread',
            workspaceKind: 'chat',
            tasks: [
              {
                taskId: 'unread-task',
                workspacePath: '/workspace/chats/unread',
                workspaceKind: 'chat',
                title: 'Unread task',
                runtime: 'codex',
              },
            ],
          },
        ],
        totalTasks: 5,
      },
      unreadRuntimeTaskKeys: new Set(['local-device\0unread-task']),
    })

    expect(screen.getByTestId('runtime-priority-filter-attention-dot')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('runtime-priority-filter-button'))

    expect(screen.getByTestId('runtime-priority-section')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-priority-filter-button')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByTestId('runtime-local-task-row-unread-task')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-row-running-task')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-row-waiting-task')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-row-running-waiting-task')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-waiting-waiting-task')).toBeInTheDocument()
    expect(screen.queryByTestId('runtime-local-task-row-idle-task')).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-row-unread-task')).toHaveClass(
      'min-h-[48px]',
      'py-1.5'
    )
    expect(screen.getByTestId('runtime-local-task-source-unread-task')).toHaveTextContent('Wework')
    expect(screen.getByTestId('runtime-local-task-source-waiting-task')).toHaveTextContent('Wegent')
    const priorityRows = Array.from(
      screen
        .getByTestId('runtime-priority-list')
        .querySelectorAll<HTMLElement>('[data-testid^="runtime-local-task-row-"]')
    )
    expect(priorityRows.map(row => row.dataset.testid)).toEqual([
      'runtime-local-task-row-unread-task',
      'runtime-local-task-row-waiting-task',
      'runtime-local-task-row-running-waiting-task',
      'runtime-local-task-row-running-task',
    ])
    expect(screen.queryByTestId('projects-section-toggle')).not.toBeInTheDocument()
    expect(screen.getByTestId('new-chat-button')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-button')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-cloud-connection-button')).toBeInTheDocument()

    await userEvent.click(screen.getByTestId('runtime-priority-filter-button'))

    expect(screen.queryByTestId('runtime-priority-section')).not.toBeInTheDocument()
    expect(screen.getByTestId('projects-section-toggle')).toBeInTheDocument()
  })

  test('keeps a read task in the active priority session and moves it to recent after reopening', async () => {
    const onMarkRuntimeTaskRead = vi.fn()
    const onOpenRuntimeTask = vi.fn()
    const updatedAt = new Date().toISOString()
    const runtimeWork = {
      projects: [],
      chats: [
        {
          deviceId: 'local-device',
          available: true,
          workspacePath: '/workspace/chats/priority-session',
          workspaceKind: 'chat' as const,
          tasks: [
            {
              taskId: 'session-unread',
              workspacePath: '/workspace/chats/priority-session',
              workspaceKind: 'chat' as const,
              title: 'Session unread',
              runtime: 'codex' as const,
              updatedAt,
            },
          ],
        },
      ],
      totalTasks: 1,
    }
    const initialProps = createSidebarProps({
      runtimeWork,
      unreadRuntimeTaskKeys: new Set(['local-device\0session-unread']),
      onMarkRuntimeTaskRead,
      onOpenRuntimeTask,
    })
    const lifecycleStore = new RuntimeTaskLifecycleStore('desktop-sidebar-priority-session-test')
    lifecycleStore.syncRuntimeWork(runtimeWork)
    const view = render(
      <RuntimeTaskLifecycleProvider store={lifecycleStore}>
        <DesktopSidebar {...initialProps} />
      </RuntimeTaskLifecycleProvider>
    )

    await userEvent.click(screen.getByTestId('runtime-priority-filter-button'))
    await userEvent.click(screen.getByTestId('runtime-local-task-row-session-unread'))

    const readProps = createSidebarProps({
      runtimeWork,
      unreadRuntimeTaskKeys: new Set(),
      onMarkRuntimeTaskRead,
      onOpenRuntimeTask,
    })
    view.rerender(
      <RuntimeTaskLifecycleProvider store={lifecycleStore}>
        <DesktopSidebar {...readProps} />
      </RuntimeTaskLifecycleProvider>
    )

    expect(
      screen
        .getByTestId('runtime-priority-list')
        .querySelector('[data-testid="runtime-local-task-row-session-unread"]')
    ).not.toBeNull()
    expect(
      screen.queryByTestId('runtime-local-task-unread-dot-session-unread')
    ).not.toBeInTheDocument()

    await userEvent.click(screen.getByTestId('runtime-priority-filter-button'))
    await userEvent.click(screen.getByTestId('runtime-priority-filter-button'))

    expect(screen.queryByTestId('runtime-priority-list')).not.toBeInTheDocument()
    expect(
      screen
        .getByTestId(/^runtime-priority-recent-list-/)
        .querySelector('[data-testid="runtime-local-task-row-session-unread"]')
    ).not.toBeNull()
  })

  test('keeps existing recent placement stable and appends newly urgent tasks', async () => {
    const updatedAt = new Date().toISOString()
    const initialRuntimeWork = {
      projects: [],
      chats: [
        {
          deviceId: 'local-device',
          available: true,
          workspacePath: '/workspace/chats/priority-recent',
          workspaceKind: 'chat' as const,
          tasks: [
            {
              taskId: 'existing-recent',
              workspacePath: '/workspace/chats/priority-recent',
              workspaceKind: 'chat' as const,
              title: 'Existing recent',
              runtime: 'codex' as const,
              updatedAt,
            },
          ],
        },
      ],
      totalTasks: 1,
    }
    const initialProps = createSidebarProps({ runtimeWork: initialRuntimeWork })
    const lifecycleStore = new RuntimeTaskLifecycleStore('desktop-sidebar-priority-recent-test')
    lifecycleStore.syncRuntimeWork(initialRuntimeWork)
    const view = render(
      <RuntimeTaskLifecycleProvider store={lifecycleStore}>
        <DesktopSidebar {...initialProps} />
      </RuntimeTaskLifecycleProvider>
    )

    await userEvent.click(screen.getByTestId('runtime-priority-filter-button'))
    expect(
      screen
        .getByTestId(/^runtime-priority-recent-list-/)
        .querySelector('[data-testid="runtime-local-task-row-existing-recent"]')
    ).not.toBeNull()

    const updatedRuntimeWork = {
      ...initialRuntimeWork,
      chats: [
        {
          ...initialRuntimeWork.chats[0],
          tasks: [
            ...initialRuntimeWork.chats[0].tasks,
            {
              taskId: 'new-waiting',
              workspacePath: '/workspace/chats/priority-recent',
              workspaceKind: 'chat' as const,
              title: 'New waiting',
              runtime: 'codex' as const,
              status: 'waiting_for_user_input',
              updatedAt,
            },
          ],
        },
      ],
      totalTasks: 2,
    }
    const updatedProps = createSidebarProps({
      runtimeWork: updatedRuntimeWork,
      unreadRuntimeTaskKeys: new Set(['local-device\0existing-recent']),
    })
    act(() => lifecycleStore.syncRuntimeWork(updatedRuntimeWork))
    view.rerender(
      <RuntimeTaskLifecycleProvider store={lifecycleStore}>
        <DesktopSidebar {...updatedProps} />
      </RuntimeTaskLifecycleProvider>
    )

    await waitFor(() => {
      expect(
        screen
          .getByTestId('runtime-priority-list')
          .querySelector('[data-testid="runtime-local-task-row-new-waiting"]')
      ).not.toBeNull()
    })
    expect(
      screen
        .getByTestId(/^runtime-priority-recent-list-/)
        .querySelector('[data-testid="runtime-local-task-row-existing-recent"]')
    ).not.toBeNull()
    expect(screen.getByTestId('runtime-local-task-unread-dot-existing-recent')).toBeInTheDocument()
  })

  test('marks unread priority tasks as read and continues scoped archiving after a failure', async () => {
    const onMarkRuntimeTaskRead = vi.fn()
    const archiveError = new Error('Device offline')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onArchiveRuntimeTask = vi
      .fn()
      .mockRejectedValueOnce(archiveError)
      .mockResolvedValue(undefined)
    const updatedAt = new Date().toISOString()
    renderSidebar({
      runtimeWork: {
        projects: [],
        chats: [
          {
            deviceId: 'local-device',
            available: true,
            workspacePath: '/workspace/chats/priority-actions',
            workspaceKind: 'chat',
            tasks: [
              {
                taskId: 'priority-unread',
                workspacePath: '/workspace/chats/priority-actions',
                workspaceKind: 'chat',
                title: 'Priority unread',
                runtime: 'codex',
                updatedAt,
              },
              {
                taskId: 'priority-waiting',
                workspacePath: '/workspace/chats/priority-actions',
                workspaceKind: 'chat',
                title: 'Priority waiting',
                runtime: 'codex',
                status: 'waiting_for_user_input',
                updatedAt,
              },
              {
                taskId: 'recent-only',
                workspacePath: '/workspace/chats/priority-actions',
                workspaceKind: 'chat',
                title: 'Recent only',
                runtime: 'codex',
                updatedAt,
              },
            ],
          },
        ],
        totalTasks: 3,
      },
      unreadRuntimeTaskKeys: new Set(['local-device\0priority-unread']),
      onMarkRuntimeTaskRead,
      onArchiveRuntimeTask,
    })

    await userEvent.click(screen.getByTestId('runtime-priority-filter-button'))
    await userEvent.click(screen.getByTestId('runtime-priority-filter-options'))
    await userEvent.click(screen.getByTestId('runtime-priority-filter-mark-all-read'))

    expect(onMarkRuntimeTaskRead).toHaveBeenCalledTimes(1)
    expect(onMarkRuntimeTaskRead).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'priority-unread' })
    )

    await userEvent.click(screen.getByTestId('runtime-priority-filter-options'))
    await userEvent.click(screen.getByTestId('runtime-priority-filter-archive'))
    expect(screen.getByTestId('runtime-priority-archive-dialog')).toHaveTextContent(
      '归档 2 个优先级任务？'
    )
    await userEvent.click(screen.getByTestId('runtime-priority-archive-dialog-confirm-button'))

    await waitFor(() => expect(onArchiveRuntimeTask).toHaveBeenCalledTimes(2))
    expect(onArchiveRuntimeTask.mock.calls.map(([address]) => address.taskId)).toEqual([
      'priority-unread',
      'priority-waiting',
    ])
    expect(consoleError).toHaveBeenCalledWith('Failed to archive priority task', archiveError)
    expect(screen.queryByTestId('runtime-priority-archive-dialog')).not.toBeInTheDocument()
    consoleError.mockRestore()
  })

  test('sorts priority tasks with numeric-string timestamps', async () => {
    renderSidebar({
      runtimeWork: {
        projects: [],
        chats: [
          {
            deviceId: 'local-device',
            available: true,
            workspacePath: '/workspace/chats/priority-timestamps',
            workspaceKind: 'chat',
            tasks: [
              {
                taskId: 'older-waiting-task',
                workspacePath: '/workspace/chats/priority-timestamps',
                workspaceKind: 'chat',
                title: 'Older waiting task',
                runtime: 'codex',
                status: 'waiting_for_user_input',
                updatedAt: '2024-01-01T00:00:00.000Z',
              },
              {
                taskId: 'recent-waiting-task',
                workspacePath: '/workspace/chats/priority-timestamps',
                workspaceKind: 'chat',
                title: 'Recent waiting task',
                runtime: 'codex',
                status: 'waiting_for_user_input',
                updatedAt: '1750000000000',
              },
            ],
          },
        ],
        totalTasks: 2,
      },
    })

    await userEvent.click(screen.getByTestId('runtime-priority-filter-button'))

    const priorityRows = Array.from(
      screen
        .getByTestId('runtime-priority-list')
        .querySelectorAll<HTMLElement>('[data-testid^="runtime-local-task-row-"]')
    )
    expect(priorityRows.map(row => row.dataset.testid)).toEqual([
      'runtime-local-task-row-recent-waiting-task',
      'runtime-local-task-row-older-waiting-task',
    ])
  })

  test('toggles the priority filter with the configured macOS shortcut', () => {
    renderSidebar()

    fireEvent.keyDown(window, { key: 'u', metaKey: true, altKey: true })

    expect(screen.getByTestId('runtime-priority-section')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'u', metaKey: true })

    expect(screen.getByTestId('runtime-priority-section')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'u', ctrlKey: true, altKey: true })

    expect(screen.getByTestId('runtime-priority-section')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'u', metaKey: true, altKey: true })

    expect(screen.queryByTestId('runtime-priority-section')).not.toBeInTheDocument()
  })

  test('uses the configured priority shortcut and ignores editable targets', () => {
    setActiveKeybindings([
      {
        command: TOGGLE_PRIORITY_FILTER_COMMAND,
        key: 'Command+Shift+P',
      },
    ])
    renderSidebar()

    fireEvent.keyDown(window, { key: 'u', metaKey: true, altKey: true })
    expect(screen.queryByTestId('runtime-priority-section')).not.toBeInTheDocument()

    const input = document.createElement('input')
    document.body.appendChild(input)
    fireEvent.keyDown(input, { key: 'p', metaKey: true, shiftKey: true })
    expect(screen.queryByTestId('runtime-priority-section')).not.toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'p', metaKey: true, shiftKey: true })
    expect(screen.getByTestId('runtime-priority-section')).toBeInTheDocument()
    input.remove()
  })

  test('shows the priority filter tooltip and shortcut on hover', async () => {
    const user = userEvent.setup()

    renderSidebar()

    await user.hover(screen.getByTestId('runtime-priority-filter-button'))

    const tooltip = screen.getByTestId('runtime-priority-filter-tooltip')
    expect(tooltip).toHaveTextContent('按优先级筛选')
    expect(tooltip).toHaveTextContent('U')
  })

  test('moves pinned priority tasks into a separate section when requested', async () => {
    renderSidebar({
      runtimeWork: {
        projects: [],
        chats: [
          {
            deviceId: 'local-device',
            available: true,
            workspacePath: '/workspace/chats/priority',
            workspaceKind: 'chat',
            tasks: [
              {
                taskId: 'pinned-waiting',
                workspacePath: '/workspace/chats/priority',
                workspaceKind: 'chat',
                title: 'Pinned waiting task',
                runtime: 'codex',
                status: 'waiting_for_user_input',
                pinned: true,
              },
              {
                taskId: 'regular-waiting',
                workspacePath: '/workspace/chats/priority',
                workspaceKind: 'chat',
                title: 'Regular waiting task',
                runtime: 'codex',
                status: 'waiting_for_user_input',
              },
            ],
          },
        ],
        totalTasks: 2,
      },
    })

    await userEvent.click(screen.getByTestId('runtime-priority-filter-button'))

    expect(screen.getByTestId('runtime-local-task-row-regular-waiting')).toBeInTheDocument()
    expect(
      screen
        .getByTestId('runtime-priority-list')
        .querySelector('[data-testid="runtime-local-task-row-pinned-waiting"]')
    ).not.toBeNull()

    await userEvent.click(screen.getByTestId('runtime-priority-filter-options'))
    await userEvent.click(screen.getByTestId('runtime-priority-filter-toggle-pinned'))

    expect(
      screen
        .getByTestId('runtime-priority-pinned-list')
        .querySelector('[data-testid="runtime-local-task-row-pinned-waiting"]')
    ).not.toBeNull()
    expect(
      screen
        .getByTestId('runtime-priority-list')
        .querySelector('[data-testid="runtime-local-task-row-pinned-waiting"]')
    ).toBeNull()
  })

  test('shows attention for pinned priority tasks when pinned items are not separated', async () => {
    renderSidebar({
      runtimeWork: {
        projects: [],
        chats: [
          {
            deviceId: 'local-device',
            available: true,
            workspacePath: '/workspace/chats/pinned-priority',
            workspaceKind: 'chat',
            tasks: [
              {
                taskId: 'pinned-waiting',
                workspacePath: '/workspace/chats/pinned-priority',
                workspaceKind: 'chat',
                title: 'Pinned waiting task',
                runtime: 'codex',
                status: 'waiting_for_user_input',
                pinned: true,
              },
            ],
          },
        ],
        totalTasks: 1,
      },
    })

    expect(screen.getByTestId('runtime-priority-filter-attention-dot')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('runtime-priority-filter-button'))
    expect(screen.getByTestId('runtime-local-task-row-pinned-waiting')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('runtime-priority-filter-options'))
    await userEvent.click(screen.getByTestId('runtime-priority-filter-toggle-pinned'))
    expect(screen.getByTestId('runtime-priority-empty')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-priority-pinned-list')).toHaveTextContent(
      'Pinned waiting task'
    )
  })

  test('keeps search in the product header and orders primary sidebar actions', () => {
    renderSidebar()

    const newChatButton = screen.getByTestId('new-chat-button')
    const searchButton = screen.getByTestId('runtime-search-button')
    const priorityFilterButton = screen.getByTestId('runtime-priority-filter-button')
    const pluginsButton = screen.getByTestId('plugins-button')
    const cloudButton = screen.getByTestId('sidebar-cloud-connection-button')
    const projectsHeader = screen.getByTestId('projects-section-toggle')

    expect(pluginsButton.querySelector('.lucide-plug')).toBeInTheDocument()

    expect(searchButton.compareDocumentPosition(newChatButton)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    expect(searchButton.compareDocumentPosition(priorityFilterButton)).toBe(
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
    expect(scrollContainer).toHaveClass('border-transparent', 'scrollbar-none')
    expect(scrollContainer).not.toHaveClass('border-border', 'scrollbar-soft')

    fireEvent.scroll(scrollContainer, { target: { scrollTop: 24 } })

    expect(scrollContainer).toHaveAttribute('data-scrolled', 'true')
    expect(scrollContainer).toHaveClass('border-border', 'scrollbar-soft')
    expect(scrollContainer).not.toHaveClass('border-transparent', 'scrollbar-none')

    fireEvent.scroll(scrollContainer, { target: { scrollTop: 0 } })

    expect(scrollContainer).toHaveAttribute('data-scrolled', 'false')
    expect(scrollContainer).toHaveClass('border-transparent', 'scrollbar-none')
    expect(scrollContainer).not.toHaveClass('border-border', 'scrollbar-soft')

    expect(searchButton.parentElement?.parentElement).toHaveClass('h-9', 'justify-between')
    expect(pluginsButton.parentElement).toHaveClass('space-y-0.5')
    expect(pluginsButton.parentElement).not.toHaveClass('pt-2')
  })

  test('locks native sidebar scrolling while a task drag is outside the sidebar', () => {
    renderSidebar()

    const scrollContainer = screen.getByTestId('sidebar-worklists-scroll')
    vi.spyOn(scrollContainer, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 280,
      bottom: 700,
      width: 280,
      height: 700,
      toJSON: () => ({}),
    } as DOMRect)
    scrollContainer.scrollTop = 120

    act(() => {
      dispatchWorkbenchSidebarPaneDragStart({ paneKey: 'task:1', title: 'Task 1' })
      fireEvent.pointerMove(window, { clientX: 600, clientY: 680 })
    })

    expect(scrollContainer).toHaveClass('overflow-y-hidden')
    scrollContainer.scrollTop = 240
    fireEvent.scroll(scrollContainer)
    expect(scrollContainer.scrollTop).toBe(120)

    act(() => {
      fireEvent.pointerMove(window, { clientX: 120, clientY: 680 })
    })
    expect(scrollContainer).toHaveClass('overflow-y-auto')

    act(() => {
      dispatchWorkbenchSidebarPaneDragCancel()
    })
  })

  test('preserves manual task-list scrolling across runtime refreshes', async () => {
    const chatPath = '/Users/alice/.wework/workspace/chats/sidebar-scroll'
    const runtimeWork = (status: string) => ({
      projects: [],
      chats: [
        {
          deviceId: 'local-device',
          deviceName: 'Local Mac',
          deviceStatus: 'online' as const,
          available: true,
          workspacePath: chatPath,
          workspaceKind: 'chat' as const,
          tasks: [
            {
              taskId: 'active-task',
              workspacePath: chatPath,
              workspaceKind: 'chat' as const,
              title: 'Active task',
              runtime: 'codex' as const,
              status,
            },
            {
              taskId: 'other-task',
              workspacePath: chatPath,
              workspaceKind: 'chat' as const,
              title: 'Other task',
              runtime: 'codex' as const,
            },
          ],
        },
      ],
      totalTasks: 2,
    })
    const currentRuntimeTask = {
      deviceId: 'local-device',
      taskId: 'active-task',
      workspacePath: chatPath,
    }
    const initialProps = createSidebarProps({
      projects: [],
      runtimeWork: runtimeWork('running'),
      currentRuntimeTask,
    })
    const lifecycleStore = new RuntimeTaskLifecycleStore('desktop-sidebar-scroll-refresh-test')
    lifecycleStore.syncRuntimeWork(initialProps.runtimeWork)
    const view = render(
      <RuntimeTaskLifecycleProvider store={lifecycleStore}>
        <DesktopSidebar {...initialProps} />
      </RuntimeTaskLifecycleProvider>
    )
    const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView)

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
    scrollIntoView.mockClear()

    const scrollContainer = screen.getByTestId('sidebar-worklists-scroll')
    scrollContainer.scrollTop = 180
    fireEvent.scroll(scrollContainer)

    const refreshedProps = createSidebarProps({
      projects: [],
      runtimeWork: runtimeWork('waiting_for_user_input'),
      currentRuntimeTask: { ...currentRuntimeTask },
    })
    act(() => lifecycleStore.syncRuntimeWork(refreshedProps.runtimeWork))
    view.rerender(
      <RuntimeTaskLifecycleProvider store={lifecycleStore}>
        <DesktopSidebar {...refreshedProps} />
      </RuntimeTaskLifecycleProvider>
    )

    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(scrollContainer.scrollTop).toBe(180)

    const switchedProps = createSidebarProps({
      projects: [],
      runtimeWork: refreshedProps.runtimeWork,
      currentRuntimeTask: {
        deviceId: 'local-device',
        taskId: 'other-task',
        workspacePath: chatPath,
      },
    })
    view.rerender(
      <RuntimeTaskLifecycleProvider store={lifecycleStore}>
        <DesktopSidebar {...switchedProps} />
      </RuntimeTaskLifecycleProvider>
    )

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
    expect(scrollIntoView.mock.contexts[0]).toBe(
      screen.getByTestId('runtime-local-task-row-other-task')
    )
  })

  test('matches Codex sidebar text emphasis levels', () => {
    renderSidebar({ onToggleSidebar: vi.fn() }, { status: 'disconnected', isConnected: false })

    const newTaskButton = screen.getByTestId('new-chat-button')
    const searchButton = screen.getByTestId('runtime-search-button')
    const collapseSidebarButton = screen.getByTestId('collapse-sidebar-button')
    const pluginsButton = screen.getByTestId('plugins-button')
    const cloudButton = screen.getByTestId('sidebar-cloud-connection-button')
    const newTaskIcon = newTaskButton.querySelector('svg')
    const cloudIcon = cloudButton.parentElement?.querySelector('svg')
    const projectsToggle = screen.getByTestId('projects-section-toggle')
    const projectsTitle = projectsToggle.querySelector('span')

    for (const button of [newTaskButton, pluginsButton, cloudButton]) {
      expect(button).toHaveClass('font-normal', 'text-[rgb(var(--color-sidebar-text-primary))]')
    }
    expect(collapseSidebarButton).toHaveClass(
      'text-[rgb(var(--color-sidebar-text-primary))]',
      'hover:text-[rgb(var(--color-sidebar-text-primary))]'
    )
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

  test('shows cloud work availability and follows the contributed sidebar path', async () => {
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
      activeItem: 'cloud-work',
      onOpenSettings,
    })

    const cloudButton = screen.getByTestId('sidebar-cloud-connection-button')
    const statusLabel = screen.getByTestId('sidebar-cloud-status-label')
    const settingsButton = screen.getByTestId('sidebar-cloud-management-button')

    expect(cloudButton).toHaveTextContent('云端工作')
    expect(cloudButton).toHaveTextContent('可用')
    expect(cloudButton.parentElement).toHaveClass('bg-[rgb(var(--color-sidebar-active))]')
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

    expect(window.location.pathname).toBe('/cloud-work')
    expect(onOpenSettings).not.toHaveBeenCalled()
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

  test('opens the path contributed by the plugin-center sidebar item', async () => {
    renderSidebar()

    await userEvent.click(screen.getByTestId('plugins-button'))

    expect(window.location.pathname).toBe('/plugins')
  })

  test('opens the path contributed by the Applications sidebar item', async () => {
    renderSidebar({ activeItem: 'sites' })

    expect(screen.getByTestId('sites-button')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByTestId('sites-button')).toHaveTextContent('应用')
    await userEvent.click(screen.getByTestId('sites-button'))

    expect(window.location.pathname).toBe('/sites')
  })

  test('keeps a dynamic DSH navigation icon mounted across unrelated sidebar rerenders', async () => {
    const runtime = window.__WEWORK_DSH_UI__
    expect(runtime).toBeDefined()
    const navigation = [
      ...runtime!.getEntries(WEWORK_DSH_SLOTS.sidebarNavigation),
      {
        id: 'shield.navigation',
        label: 'Shield',
        icon: 'shield',
        path: '/shield',
        surface: 'route',
        testId: 'shield-button',
      },
    ]
    window.__WEWORK_DSH_UI__ = {
      ...runtime!,
      getEntries: slotName =>
        slotName === WEWORK_DSH_SLOTS.sidebarNavigation
          ? navigation
          : runtime!.getEntries(slotName),
    }
    renderSidebar()

    const shieldButton = screen.getByTestId('shield-button')
    const shieldIcon = await waitFor(() => {
      const icon = shieldButton.querySelector('.lucide-shield')
      expect(icon).toBeInTheDocument()
      return icon
    })

    fireEvent.scroll(screen.getByTestId('sidebar-worklists-scroll'), {
      target: { scrollTop: 24 },
    })

    expect(shieldButton.querySelector('.lucide-shield')).toBe(shieldIcon)
  })

  test('removes sidebar entries when their DSH plugins stop contributing them', () => {
    const runtime = window.__WEWORK_DSH_UI__
    expect(runtime).toBeDefined()
    const listeners = new Set<() => void>()
    let navigation = runtime!.getEntries(WEWORK_DSH_SLOTS.sidebarNavigation)
    window.__WEWORK_DSH_UI__ = {
      ...runtime!,
      getEntries: slotName =>
        slotName === WEWORK_DSH_SLOTS.sidebarNavigation
          ? navigation
          : runtime!.getEntries(slotName),
      subscribe: (slotName, listener) => {
        if (slotName !== WEWORK_DSH_SLOTS.sidebarNavigation) {
          return runtime!.subscribe(slotName, listener)
        }
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    renderSidebar()

    expect(screen.getByTestId('sites-button')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-cloud-connection-button')).toBeInTheDocument()

    act(() => {
      navigation = navigation.filter(
        item => item.id !== 'applications.navigation' && item.id !== 'cloud-work.navigation'
      )
      listeners.forEach(listener => listener())
    })

    expect(screen.queryByTestId('sites-button')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-cloud-connection-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('automation-button')).toBeInTheDocument()
    expect(screen.getByTestId('plugins-button')).toBeInTheDocument()
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

  test('shows Automations when experimental features are disabled', () => {
    experimentalFeatures.enabled = false
    renderSidebar()

    expect(screen.getByTestId('automation-button')).toBeInTheDocument()
  })

  test('renders chat runtime tasks as conversations instead of workspace groups', async () => {
    const onOpenRuntimeTask = vi.fn()
    const chatPath = '/Users/alice/.wework/workspace/chats/2026-06-20/hi-1'

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
                runtimeHandle: {
                  origin: {
                    type: 'board_comment',
                    cloudProjectId: 'project-1',
                    loopItemId: 'item-1',
                  },
                },
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
    expect(screen.queryByTestId('runtime-local-task-board-comment-chat-1')).not.toBeInTheDocument()
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
      runtimeHandle: {
        origin: {
          type: 'board_comment',
          cloudProjectId: 'project-1',
          loopItemId: 'item-1',
        },
      },
    })
  })

  test('hides project automation manager sessions from standalone tasks', () => {
    const chatPath = '/Users/alice/.wework/workspace/chats/2026-08-14/automation'

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
                taskId: 'automation-manager',
                workspacePath: chatPath,
                workspaceKind: 'chat',
                title: 'Automation manager',
                runtime: 'codex',
                runtimeHandle: {
                  origin: {
                    type: 'project_automation',
                    automationRole: 'manager',
                    run_id: 'run-1',
                  },
                },
              },
              {
                taskId: 'project-robot',
                workspacePath: chatPath,
                workspaceKind: 'chat',
                title: 'Project robot',
                runtime: 'codex',
                runtimeHandle: {
                  origin: {
                    type: 'project_automation',
                    run_id: 'run-1',
                  },
                },
              },
            ],
          },
        ],
        totalTasks: 2,
      },
      onOpenRuntimeTask: vi.fn(),
    })

    expect(
      screen.queryByTestId('runtime-local-task-row-automation-manager')
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-row-project-robot')).toHaveTextContent(
      'Project robot'
    )
  })

  test('sweeps a runtime task title after it is updated', async () => {
    const chatPath = '/Users/alice/.wework/workspace/chats/2026-08-06/title-update'
    const runtimeWork = (title: string) => ({
      projects: [],
      chats: [
        {
          deviceId: 'local-device',
          deviceName: 'Local Mac',
          deviceStatus: 'online' as const,
          available: true,
          workspacePath: chatPath,
          workspaceKind: 'chat' as const,
          tasks: [
            {
              taskId: 'friendly-title-task',
              workspacePath: chatPath,
              workspaceKind: 'chat' as const,
              title,
              runtime: 'codex' as const,
            },
          ],
        },
      ],
      totalTasks: 1,
    })
    const lifecycleStore = new RuntimeTaskLifecycleStore('friendly-title-sheen-test')
    const initialProps = createSidebarProps({
      projects: [],
      runtimeWork: runtimeWork('原始标题'),
    })
    lifecycleStore.syncRuntimeWork(initialProps.runtimeWork)
    const { rerender } = render(
      <RuntimeTaskLifecycleProvider store={lifecycleStore}>
        <DesktopSidebar {...initialProps} />
      </RuntimeTaskLifecycleProvider>
    )

    expect(screen.getByTestId('runtime-local-task-title-friendly-title-task')).not.toHaveClass(
      'is-updated'
    )

    const updatedProps = createSidebarProps({
      projects: [],
      runtimeWork: runtimeWork('AI 优化后的标题'),
    })
    lifecycleStore.syncRuntimeWork(updatedProps.runtimeWork)
    rerender(
      <RuntimeTaskLifecycleProvider store={lifecycleStore}>
        <DesktopSidebar {...updatedProps} />
      </RuntimeTaskLifecycleProvider>
    )

    await waitFor(() => {
      expect(screen.getByTestId('runtime-local-task-title-friendly-title-task')).toHaveClass(
        'is-updated'
      )
    })
    expect(
      screen.getByTestId('runtime-local-task-title-shimmer-friendly-title-task')
    ).toBeInTheDocument()
  })

  test('marks every active split group member and distinguishes the focused member', () => {
    const chatPath = '/Users/alice/.wework/workspace/chats/2026-08-14/split-group'
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
                taskId: 'split-one',
                workspacePath: chatPath,
                workspaceKind: 'chat',
                title: 'Split one',
                runtime: 'codex',
              },
              {
                taskId: 'split-two',
                workspacePath: chatPath,
                workspaceKind: 'chat',
                title: 'Split two',
                runtime: 'codex',
              },
            ],
          },
        ],
        totalTasks: 2,
      },
      currentRuntimeTask: {
        deviceId: 'local-device',
        taskId: 'split-one',
        workspacePath: chatPath,
      },
      splitGroupMemberships: {
        'runtime:local-device:split-one': {
          groupId: 'group-one',
          displayNumber: 1,
          active: true,
          focused: true,
        },
        'runtime:local-device:split-two': {
          groupId: 'group-one',
          displayNumber: 1,
          active: true,
          focused: false,
        },
      },
      onOpenRuntimeTask: vi.fn(),
    })

    const firstRow = screen.getByTestId('runtime-local-task-row-split-one')
    const secondRow = screen.getByTestId('runtime-local-task-row-split-two')
    expect(firstRow).toHaveClass('bg-[rgb(var(--color-sidebar-active))]')
    expect(secondRow).toHaveClass('bg-[rgb(var(--color-sidebar-active))]')
    expect(firstRow).toHaveAttribute('aria-current', 'page')
    expect(secondRow).not.toHaveAttribute('aria-current')
    expect(screen.getByTestId('runtime-local-task-split-group-split-one')).toHaveAccessibleName(
      '分屏 1'
    )
    expect(screen.getByTestId('runtime-local-task-split-group-split-two')).toHaveAttribute(
      'data-split-group',
      'group-one'
    )
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
    const runtimeWork = {
      projects: [],
      chats: [
        {
          deviceId: 'local-device',
          available: true,
          workspacePath: chatPath,
          workspaceKind: 'chat' as const,
          tasks: [
            {
              taskId: 'optimistic-chat',
              threadId: 'optimistic-thread',
              workspacePath: chatPath,
              workspaceKind: 'chat' as const,
              title: 'Optimistic pinned task',
              runtime: 'codex',
            },
          ],
        },
      ],
      totalTasks: 1,
    }
    const props = createSidebarProps({
      runtimeWork,
      onSetRuntimeTaskPinned,
    })
    const lifecycleStore = new RuntimeTaskLifecycleStore('desktop-sidebar-pin-refresh-test')
    lifecycleStore.syncRuntimeWork(runtimeWork)
    const view = render(
      <RuntimeTaskLifecycleProvider store={lifecycleStore}>
        <DesktopSidebar {...props} />
      </RuntimeTaskLifecycleProvider>
    )

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

    const staleRuntimeWork = {
      ...runtimeWork,
      chats: runtimeWork.chats.map(workspace => ({
        ...workspace,
        tasks: workspace.tasks.map(task => ({ ...task })),
      })),
    }
    act(() => lifecycleStore.syncRuntimeWork(staleRuntimeWork))
    view.rerender(
      <RuntimeTaskLifecycleProvider store={lifecycleStore}>
        <DesktopSidebar {...props} runtimeWork={staleRuntimeWork} />
      </RuntimeTaskLifecycleProvider>
    )

    expect(screen.getByTestId('sidebar-pinned-section')).toContainElement(
      screen.getByTestId('runtime-local-task-row-optimistic-chat')
    )

    await act(async () => resolvePinRequest?.())
  })

  test('preserves the latest pin intent until ordered runtime updates acknowledge it', async () => {
    const requests: Array<{ pinned: boolean; resolve: () => void }> = []
    const onSetRuntimeTaskPinned = vi.fn(
      (data: { pinned: boolean }) =>
        new Promise<void>(resolve => {
          requests.push({ pinned: data.pinned, resolve })
        })
    )
    const chatPath = '/Users/alice/Documents/Codex/2026-07-12/rapid-pin'
    const runtimeWork = (pinned: boolean) => ({
      projects: [],
      chats: [
        {
          deviceId: 'local-device',
          available: true,
          workspacePath: chatPath,
          workspaceKind: 'chat' as const,
          tasks: [
            {
              taskId: 'rapid-pin-chat',
              threadId: 'rapid-pin-thread',
              workspacePath: chatPath,
              workspaceKind: 'chat' as const,
              title: 'Rapid pin task',
              runtime: 'codex' as const,
              pinned,
            },
          ],
        },
      ],
      totalTasks: 1,
    })
    const initialRuntimeWork = runtimeWork(false)
    const props = createSidebarProps({
      runtimeWork: initialRuntimeWork,
      onSetRuntimeTaskPinned,
    })
    const lifecycleStore = new RuntimeTaskLifecycleStore('desktop-sidebar-rapid-pin-test')
    lifecycleStore.syncRuntimeWork(initialRuntimeWork)
    const view = render(
      <RuntimeTaskLifecycleProvider store={lifecycleStore}>
        <DesktopSidebar {...props} />
      </RuntimeTaskLifecycleProvider>
    )

    await userEvent.click(screen.getByTestId('runtime-local-task-mark-rapid-pin-chat'))
    await waitFor(() => expect(onSetRuntimeTaskPinned).toHaveBeenCalledTimes(1))
    expect(requests[0]?.pinned).toBe(true)
    expect(screen.getByTestId('sidebar-pinned-section')).toContainElement(
      screen.getByTestId('runtime-local-task-row-rapid-pin-chat')
    )

    await userEvent.click(screen.getByTestId('runtime-local-task-mark-rapid-pin-chat'))
    expect(screen.queryByTestId('sidebar-pinned-section')).not.toBeInTheDocument()
    expect(onSetRuntimeTaskPinned).toHaveBeenCalledTimes(1)

    await act(async () => requests[0]?.resolve())
    await waitFor(() => expect(onSetRuntimeTaskPinned).toHaveBeenCalledTimes(2))
    expect(requests[1]?.pinned).toBe(false)

    const firstAcknowledgement = runtimeWork(true)
    act(() => lifecycleStore.syncRuntimeWork(firstAcknowledgement))
    view.rerender(
      <RuntimeTaskLifecycleProvider store={lifecycleStore}>
        <DesktopSidebar {...props} runtimeWork={firstAcknowledgement} />
      </RuntimeTaskLifecycleProvider>
    )
    expect(screen.queryByTestId('sidebar-pinned-section')).not.toBeInTheDocument()

    await act(async () => requests[1]?.resolve())
    const latestAcknowledgement = runtimeWork(false)
    act(() => lifecycleStore.syncRuntimeWork(latestAcknowledgement))
    view.rerender(
      <RuntimeTaskLifecycleProvider store={lifecycleStore}>
        <DesktopSidebar {...props} runtimeWork={latestAcknowledgement} />
      </RuntimeTaskLifecycleProvider>
    )

    const externalPinUpdate = runtimeWork(true)
    act(() => lifecycleStore.syncRuntimeWork(externalPinUpdate))
    view.rerender(
      <RuntimeTaskLifecycleProvider store={lifecycleStore}>
        <DesktopSidebar {...props} runtimeWork={externalPinUpdate} />
      </RuntimeTaskLifecycleProvider>
    )
    expect(screen.getByTestId('sidebar-pinned-section')).toContainElement(
      screen.getByTestId('runtime-local-task-row-rapid-pin-chat')
    )
  })

  test('preserves a later pin intent when an earlier queued request fails', async () => {
    const requests: Array<{
      pinned: boolean
      reject: (error: Error) => void
      resolve: () => void
    }> = []
    const onSetRuntimeTaskPinned = vi.fn(
      (data: { pinned: boolean }) =>
        new Promise<void>((resolve, reject) => {
          requests.push({ pinned: data.pinned, reject, resolve })
        })
    )
    const chatPath = '/Users/alice/Documents/Codex/2026-07-12/rejected-rapid-pin'
    const runtimeWork = {
      projects: [],
      chats: [
        {
          deviceId: 'local-device',
          available: true,
          workspacePath: chatPath,
          workspaceKind: 'chat' as const,
          tasks: [
            {
              taskId: 'rejected-rapid-pin-chat',
              threadId: 'rejected-rapid-pin-thread',
              workspacePath: chatPath,
              workspaceKind: 'chat' as const,
              title: 'Rejected rapid pin task',
              runtime: 'codex' as const,
              pinned: false,
            },
          ],
        },
      ],
      totalTasks: 1,
    }
    renderSidebar({ runtimeWork, onSetRuntimeTaskPinned })

    await userEvent.click(screen.getByTestId('runtime-local-task-mark-rejected-rapid-pin-chat'))
    await waitFor(() => expect(onSetRuntimeTaskPinned).toHaveBeenCalledTimes(1))
    expect(requests[0]?.pinned).toBe(true)

    await userEvent.click(screen.getByTestId('runtime-local-task-mark-rejected-rapid-pin-chat'))
    expect(screen.queryByTestId('sidebar-pinned-section')).not.toBeInTheDocument()
    expect(onSetRuntimeTaskPinned).toHaveBeenCalledTimes(1)

    await act(async () => requests[0]?.reject(new Error('Pin request failed')))
    await waitFor(() => expect(onSetRuntimeTaskPinned).toHaveBeenCalledTimes(2))
    expect(requests[1]?.pinned).toBe(false)
    expect(screen.queryByTestId('sidebar-pinned-section')).not.toBeInTheDocument()

    await act(async () => requests[1]?.resolve())
  })

  test('moves a project task to the pinned section before the pin request finishes', async () => {
    let resolvePinRequest: (() => void) | undefined
    const onSetRuntimeTaskPinned = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolvePinRequest = resolve
        })
    )
    renderSidebar({
      runtimeWork: {
        projects: [
          {
            project: {
              id: 7,
              key: 'project-7',
              name: 'Wegent',
              stateDeviceId: 'local-device',
            },
            totalTasks: 1,
            deviceWorkspaces: [
              {
                deviceId: 'local-device',
                available: true,
                workspacePath: '/repo/Wegent',
                tasks: [
                  {
                    taskId: 'optimistic-project-task',
                    threadId: 'optimistic-project-thread',
                    workspacePath: '/repo/Wegent',
                    title: 'Optimistic project task',
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
    await userEvent.click(screen.getByTestId('runtime-local-task-mark-optimistic-project-task'))

    await waitFor(() => {
      const pinnedRow = screen.getByTestId('runtime-local-task-row-optimistic-project-task')
      expect(screen.getByTestId('sidebar-pinned-section')).toContainElement(pinnedRow)
    })
    expect(onSetRuntimeTaskPinned).toHaveBeenCalledWith({
      deviceId: 'local-device',
      threadId: 'optimistic-project-thread',
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

  test('starts task pointer sorting from the full title area', async () => {
    const onReorderRuntimeProjectTasks = vi.fn().mockResolvedValue(undefined)
    const onOpenRuntimeTask = vi.fn()
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
      onOpenRuntimeTask,
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
    expect(secondSortable).toHaveAttribute('tabindex', '0')

    const firstActivator = screen.getByTestId('runtime-local-task-drag-activator-chat-1')
    const firstTitleSpace = firstActivator.parentElement as HTMLElement
    const firstTrailing = screen.getByTestId('runtime-local-task-trailing-chat-1')
    const firstActions = screen.getByTestId('runtime-local-task-hover-actions-chat-1')
    mockSidebarSortableRect(firstSortable, 0)
    mockSidebarSortableRect(secondSortable, 30)

    expect(firstSortable).toContainElement(firstActivator)
    expect(firstActivator).not.toContainElement(firstActions)
    expect(firstActivator).not.toHaveAttribute('data-sidebar-drag-activator')
    expect(firstTitleSpace).toHaveAttribute('data-sidebar-drag-activator')
    expect(firstTrailing).not.toHaveAttribute('data-sidebar-drag-activator')
    expect(firstActions).not.toHaveAttribute('data-sidebar-drag-activator')
    expect(screen.getByTestId('runtime-local-task-row-chat-1')).not.toHaveAttribute(
      'data-sidebar-drag-activator'
    )

    fireEvent.click(screen.getByTestId('runtime-local-task-row-chat-1'))
    fireEvent.click(screen.getByTestId('runtime-local-task-row-chat-1'))
    expect(onOpenRuntimeTask).toHaveBeenCalledTimes(2)
    expect(onReorderRuntimeProjectTasks).not.toHaveBeenCalled()

    firstSortable.focus()
    fireEvent.keyDown(firstSortable, { key: ' ', code: 'Space' })
    expect(firstSortable).toHaveAttribute('data-dragging', 'true')
    await waitForSidebarPointerSensorCleanup()
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' })
    await waitFor(() => expect(firstSortable).not.toHaveAttribute('data-dragging'))

    for (const [pointerId, target] of [firstTrailing, firstActions].entries()) {
      fireEvent.pointerDown(target, {
        button: 0,
        buttons: 1,
        clientX: 220,
        clientY: 10,
        isPrimary: true,
        pointerId: pointerId + 1,
      })
      fireEvent.pointerMove(document, {
        buttons: 1,
        clientX: 220,
        clientY: 45,
        isPrimary: true,
        pointerId: pointerId + 1,
      })
      expect(firstSortable).not.toHaveAttribute('data-dragging')
      fireEvent.pointerUp(document, {
        button: 0,
        clientX: 220,
        clientY: 45,
        pointerId: pointerId + 1,
      })
    }

    fireEvent.pointerDown(firstActivator, {
      button: 0,
      buttons: 1,
      clientX: 20,
      clientY: 10,
      isPrimary: true,
      pointerId: 4,
    })
    fireEvent.pointerMove(document, {
      buttons: 1,
      clientX: 20,
      clientY: 15,
      isPrimary: true,
      pointerId: 4,
    })
    expect(firstSortable).not.toHaveAttribute('data-dragging')
    fireEvent.pointerMove(document, {
      buttons: 1,
      clientX: 20,
      clientY: 45,
      isPrimary: true,
      pointerId: 4,
    })
    expect(firstSortable).toHaveAttribute('data-dragging', 'true')
    fireEvent.pointerMove(document, {
      buttons: 1,
      clientX: 20,
      clientY: 50,
      isPrimary: true,
      pointerId: 4,
    })
    fireEvent.pointerUp(document, {
      button: 0,
      buttons: 0,
      clientX: 20,
      clientY: 50,
      isPrimary: true,
      pointerId: 4,
    })

    await waitFor(() => expect(onReorderRuntimeProjectTasks).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(firstSortable).not.toHaveAttribute('data-dragging'))
    await waitForSidebarPointerSensorCleanup()
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

  test('renames a runtime conversation from its context menu without space starting drag', async () => {
    const user = userEvent.setup()
    const onOpenRuntimeTask = vi.fn()
    const onReorderRuntimeProjectTasks = vi.fn().mockResolvedValue(undefined)
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
                title: '对齐 需求 核心点',
                runtime: 'codex',
              },
            ],
          },
        ],
        totalTasks: 1,
      },
      onOpenRuntimeTask,
      onReorderRuntimeProjectTasks,
      onRenameRuntimeTask,
    })

    const taskRow = screen.getByTestId('runtime-local-task-row-codex-rename')
    const sortable = document.querySelector(
      '[data-sidebar-sortable-id="local-device:codex-rename"]'
    ) as HTMLElement

    fireEvent.contextMenu(taskRow, {
      clientX: 20,
      clientY: 10,
    })
    await user.click(screen.getByTestId('runtime-local-task-menu-rename-codex-rename'))

    expect(screen.getByTestId('rename-runtime-local-task-input-codex-rename')).toHaveValue(
      '对齐 需求 核心点'
    )
    expect(screen.getByText('保持简短且易于识别')).toBeInTheDocument()
    expect(onReorderRuntimeProjectTasks).not.toHaveBeenCalled()

    const renameInput = screen.getByTestId('rename-runtime-local-task-input-codex-rename')
    await user.type(renameInput, ' ')
    expect(sortable).not.toHaveAttribute('data-dragging')
    expect(onReorderRuntimeProjectTasks).not.toHaveBeenCalled()

    await user.clear(renameInput)
    await user.type(renameInput, '对齐方案')
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

  test('opens a runtime conversation once before double click rename', async () => {
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
            available: true,
            workspacePath: '/workspace/chats/chat-double-click',
            workspaceKind: 'chat',
            tasks: [
              {
                taskId: 'codex-double-click',
                workspacePath: '/workspace/chats/chat-double-click',
                workspaceKind: 'chat',
                title: 'Double click rename',
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

    await user.dblClick(screen.getByTestId('runtime-local-task-row-codex-double-click'))

    expect(onOpenRuntimeTask).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('rename-runtime-local-task-input-codex-double-click')).toHaveValue(
      'Double click rename'
    )
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
                deviceName: 'Remote Host',
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
    expect(screen.getByTestId('project-device-status-7')).toHaveTextContent('Remote Host')
    expect(screen.getByTestId('project-device-status-7-dot')).toHaveClass(
      'bg-[rgb(var(--color-sidebar-text-muted))]',
      'opacity-55'
    )
    expect(screen.getByTestId('project-device-status-7-dot')).not.toHaveAttribute('style')
    expect(screen.getByText('Local Wegent')).toBeInTheDocument()
    expect(screen.getByTestId('project-folder-icon-8')).toBeInTheDocument()
    expect(screen.getAllByTestId('project-item')).toHaveLength(2)
  })

  test('shows the device name and original device id in project and task hover cards', async () => {
    vi.useFakeTimers()
    renderSidebar({
      devices: [
        localDevice(),
        localDevice({
          id: 2,
          device_id: 'remote-device-id',
          socket_device_id: 'remote-runtime-id',
          name: '公司云端 MacBook Pro',
          is_default: false,
          device_type: 'remote',
        }),
      ],
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'remote-project-id', name: 'Sites' },
            deviceWorkspaces: [
              {
                deviceId: 'remote-runtime-id',
                deviceName: 'remote-runtime-id',
                remoteHostId: 'cloud-device-dev',
                workspacePath: '/Users/alice/Sites',
                workspaceSource: 'remote',
                available: true,
                tasks: [
                  {
                    taskId: 'remote-hover-task',
                    title: 'Deploy Sites',
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

    const projectRow = screen.getByTestId('project-row-7')
    fireEvent.mouseEnter(projectRow)
    await act(async () => vi.advanceTimersByTime(450))
    const projectHover = screen.getByTestId('project-hover-card-7')
    expect(projectHover).toHaveTextContent('公司云端 MacBook Pro')
    expect(projectHover).toHaveTextContent('ID：cloud-device-dev')
    expect(projectHover).not.toHaveTextContent('remote-runtime-id')

    fireEvent.pointerMove(document.body)
    await act(async () => vi.advanceTimersByTime(120))
    fireEvent.click(screen.getByTestId('project-item-button'))
    const taskRow = screen.getByTestId('runtime-local-task-row-remote-hover-task')
    fireEvent.mouseEnter(taskRow)
    await act(async () => vi.advanceTimersByTime(450))
    const taskHover = screen.getByTestId('runtime-local-task-hover-content-remote-hover-task')
    expect(taskHover).toHaveTextContent('公司云端 MacBook Pro')
    expect(taskHover).toHaveTextContent('ID：cloud-device-dev')
    expect(taskHover).not.toHaveTextContent('remote-runtime-id')
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

    expect(screen.getByTestId('project-device-status-7')).toHaveTextContent('Remote Host')
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
    const spinnerLayer = runningStatus.querySelector('.animate-spin')
    expect(spinnerLayer).toBeInstanceOf(HTMLSpanElement)
    expect(spinnerLayer).toHaveClass('will-change-transform')
    expect(spinnerLayer?.querySelector('svg')).not.toHaveClass('animate-spin')
    expect(screen.queryByTestId('runtime-local-task-running-codex-idle')).not.toBeInTheDocument()
  })

  test('shows a paused status when a running task has a paused follow-up queue', async () => {
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
                    taskId: 'paused-follow-up',
                    workspacePath: '/repo/Wegent',
                    title: 'Paused follow-up',
                    runtime: 'codex',
                    running: true,
                    updatedAt: '2026-08-19T03:00:00Z',
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
    expect(screen.getByTestId('runtime-local-task-running-paused-follow-up')).toBeInTheDocument()

    act(() => {
      cacheRuntimeConversationQueuePaused(
        {
          deviceId: 'local-device',
          taskId: 'paused-follow-up',
          workspacePath: '/repo/Wegent',
        },
        true
      )
    })

    expect(screen.getByTestId('runtime-local-task-queue-paused-paused-follow-up')).toHaveAttribute(
      'aria-label',
      '追问队列已暂停'
    )
    expect(
      screen.queryByTestId('runtime-local-task-running-paused-follow-up')
    ).not.toBeInTheDocument()

    act(() => {
      cacheRuntimeConversationQueuePaused(
        {
          deviceId: 'local-device',
          taskId: 'paused-follow-up',
          workspacePath: '/repo/Wegent',
        },
        false
      )
    })

    expect(screen.getByTestId('runtime-local-task-running-paused-follow-up')).toBeInTheDocument()
    expect(
      screen.queryByTestId('runtime-local-task-queue-paused-paused-follow-up')
    ).not.toBeInTheDocument()
  })

  test('shows queued positions and runs queue actions through the workbench', async () => {
    const forceStartRuntimeTask = vi.fn().mockResolvedValue(undefined)
    const reorderQueuedRuntimeTask = vi.fn().mockResolvedValue(undefined)
    renderSidebar(
      {
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
                      taskId: 'queued-first',
                      workspacePath: '/repo/Wegent',
                      title: 'First queued task',
                      runtime: 'codex',
                      status: 'queued',
                      queuePosition: 1,
                      running: false,
                      updatedAt: '2026-08-12T03:00:00Z',
                    },
                    {
                      taskId: 'queued-second',
                      workspacePath: '/repo/Wegent',
                      title: 'Second queued task',
                      runtime: 'codex',
                      status: 'queued',
                      queuePosition: 2,
                      running: false,
                      updatedAt: '2026-08-12T02:00:00Z',
                    },
                  ],
                },
              ],
            },
          ],
          chats: [],
          totalTasks: 2,
        },
      },
      undefined,
      undefined,
      {
        forceStartRuntimeTask,
        reorderQueuedRuntimeTask,
        setWorkbenchError: vi.fn(),
      }
    )

    await userEvent.click(screen.getByTestId('project-item-button'))

    expect(screen.getByTestId('runtime-local-task-queue-position-queued-first')).toHaveTextContent(
      '1'
    )
    expect(screen.getByTestId('runtime-local-task-queue-position-queued-second')).toHaveTextContent(
      '2'
    )
    await userEvent.click(screen.getByTestId('runtime-local-task-queue-up-queued-second'))
    await waitFor(() => {
      expect(reorderQueuedRuntimeTask).toHaveBeenCalledWith({
        deviceId: 'local-device',
        taskId: 'queued-second',
        workspacePath: '/repo/Wegent',
        queuePosition: 1,
      })
    })

    await userEvent.click(screen.getByTestId('runtime-local-task-force-start-queued-first'))
    await waitFor(() => {
      expect(forceStartRuntimeTask).toHaveBeenCalledWith({
        deviceId: 'local-device',
        taskId: 'queued-first',
        workspacePath: '/repo/Wegent',
      })
    })
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
      expect(screen.getByTestId('runtime-local-task-archive-toast-codex-1')).toHaveClass(
        'electron-titlebar-interactive-region',
        'pointer-events-auto'
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

    expect(taskRow).not.toHaveAttribute('data-marked')
    expect(taskRow.className).not.toContain('color-sidebar-marked')

    await user.click(markButton)

    const pinnedTaskRow = screen.getByTestId('runtime-local-task-row-codex-1')
    const unpinButton = screen.getByTestId('runtime-local-task-mark-codex-1')
    expect(screen.getByTestId('sidebar-pinned-section')).toContainElement(pinnedTaskRow)
    expect(pinnedTaskRow).toHaveAttribute('data-marked', 'true')
    expect(pinnedTaskRow.className).not.toContain('color-sidebar-marked')
    expect(screen.getByTestId('runtime-local-task-pin-icon-codex-1')).toHaveClass('fill-current')
    expect(unpinButton).toHaveAttribute('aria-label', '取消置顶')
    expect(onOpenRuntimeTask).not.toHaveBeenCalled()
    expect(onSetRuntimeTaskPinned).toHaveBeenLastCalledWith({
      deviceId: 'local-device',
      threadId: 'thread-1',
      pinned: true,
    })

    await user.click(unpinButton)

    const unpinnedTaskRow = screen.getByTestId('runtime-local-task-row-codex-1')
    const pinButton = screen.getByTestId('runtime-local-task-mark-codex-1')
    expect(screen.queryByTestId('sidebar-pinned-section')).not.toBeInTheDocument()
    expect(unpinnedTaskRow).not.toHaveAttribute('data-marked')
    expect(unpinnedTaskRow.className).not.toContain('color-sidebar-marked')
    expect(screen.getByTestId('runtime-local-task-pin-icon-codex-1')).not.toHaveClass(
      'fill-current'
    )
    expect(pinButton).toHaveAttribute('aria-label', '置顶任务')
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
    expect(screen.getByTestId('runtime-local-task-mark-legacy-thread-id')).toHaveAttribute(
      'aria-label',
      '取消置顶'
    )
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

    const titleActivator = screen.getByText(taskTitle)
    const title = titleActivator.parentElement as HTMLElement
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

  test('keeps change request icons inside shallow pinned and task rows', async () => {
    const snapshot: TaskChangeRequestSnapshot = {
      target: {
        deviceId: 'local-device',
        taskId: 'task-with-pr',
        workspacePath: '/repo/Wegent',
        remoteUrl: 'https://github.com/wecode-ai/Wegent.git',
        branch: 'fix/sidebar-pr-icon',
      },
      changeRequest: {
        provider: 'github',
        number: 2875,
        url: 'https://github.com/wecode-ai/Wegent/pull/2875',
        title: 'Keep PR icons inside the sidebar',
        state: 'open',
        draft: false,
        checks: 'success',
        mergeability: 'mergeable',
        mergeQueue: 'not_queued',
      },
      fetchedAt: '2026-08-21T00:00:00Z',
      stale: false,
      error: null,
    }
    const changeRequestSpy = vi
      .spyOn(changeRequestMonitor, 'useTaskChangeRequest')
      .mockReturnValue(snapshot)

    try {
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
                      taskId: 'pinned-task',
                      threadId: 'pinned-thread',
                      pinned: true,
                      workspacePath: '/repo/Wegent',
                      title: 'Pinned task',
                      runtime: 'codex',
                    },
                    {
                      taskId: 'project-task',
                      workspacePath: '/repo/Wegent',
                      title: 'Project task',
                      runtime: 'codex',
                    },
                  ],
                },
              ],
            },
          ],
          chats: [
            {
              deviceId: 'local-device',
              available: true,
              workspacePath: '/workspace/chats/task-with-pr',
              workspaceKind: 'chat',
              tasks: [
                {
                  taskId: 'chat-task',
                  workspacePath: '/workspace/chats/task-with-pr',
                  workspaceKind: 'chat',
                  title: 'Chat task',
                  runtime: 'codex',
                },
              ],
            },
          ],
          totalTasks: 3,
        },
      })

      const pinnedIcon = screen.getByTestId('runtime-local-task-change-request-pinned-task')
      const chatIcon = screen.getByTestId('runtime-local-task-change-request-chat-task')
      expect(pinnedIcon.parentElement?.parentElement).toHaveClass('mr-1')
      expect(pinnedIcon.parentElement?.parentElement).not.toHaveClass('-ml-7')
      expect(chatIcon.parentElement?.parentElement).toHaveClass('mr-1')
      expect(chatIcon.parentElement?.parentElement).not.toHaveClass('-ml-7')

      await userEvent.click(screen.getByTestId('project-item-button'))
      expect(
        screen.getByTestId('runtime-local-task-change-request-project-task').parentElement
          ?.parentElement
      ).toHaveClass('-ml-7', 'mr-1')
    } finally {
      changeRequestSpy.mockRestore()
    }
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
      opener: 'file-manager',
      path: '/Users/alice/dev/Wegent',
    })
  })

  test('hides automatic project-space joining when experimental features are disabled', async () => {
    experimentalFeatures.enabled = false
    const user = userEvent.setup()
    const projectSpaceApi = {
      listCloudProjects: vi.fn().mockResolvedValue({ items: [] }),
    } as unknown as ProjectSpaceApi

    renderSidebar({
      projects: [],
      runtimeWork: {
        projects: [
          {
            project: {
              id: 7,
              key: 'project:7',
              name: 'Wegent',
              source: 'local_project',
              stateDeviceId: 'local-device',
              roots: [{ kind: 'local', path: '/Users/alice/dev/Wegent' }],
            },
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
      projectSpaceApis: [projectSpaceApi],
      onUpdateLocalRuntimeProject: vi.fn().mockResolvedValue(undefined),
    })

    await user.click(screen.getByTestId('project-menu-7'))
    await user.click(screen.getByTestId('edit-project-7'))

    expect(screen.queryByTestId('local-project-auto-join-space-select')).not.toBeInTheDocument()
    expect(projectSpaceApi.listCloudProjects).not.toHaveBeenCalled()
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

  test('opens away reminder controls from the account IM message button', async () => {
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
    expect(screen.getByTestId('sidebar-global-im-notification-muted-icon')).toHaveClass(
      'lucide-message-circle-off'
    )
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

  test('shows global IM notifications while experimental features are disabled', () => {
    experimentalFeatures.enabled = false

    renderSidebar({ onToggleGlobalImNotification: vi.fn() })

    expect(screen.getByTestId('sidebar-global-im-notification-button')).toBeInTheDocument()
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
    const settingsButton = screen.getByTestId('sidebar-global-im-notification-settings-button')
    expect(settingsButton).toHaveClass('shrink-0', 'whitespace-nowrap')
    await user.click(settingsButton)

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
    expect(screen.getByTestId('runtime-local-task-notify-icon-codex-1')).toHaveClass(
      'lucide-message-circle',
      'fill-current'
    )

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

    const initialProps = createSidebarProps({ runtimeWork: runtimeWorkWithTaskCount(6) })
    const lifecycleStore = new RuntimeTaskLifecycleStore('desktop-sidebar-growing-list-test')
    lifecycleStore.syncRuntimeWork(initialProps.runtimeWork)
    const view = render(
      <RuntimeTaskLifecycleProvider store={lifecycleStore}>
        <DesktopSidebar {...initialProps} />
      </RuntimeTaskLifecycleProvider>
    )

    await userEvent.click(screen.getByTestId('project-item-button'))
    await userEvent.click(screen.getByTestId('project-runtime-tasks-expand-7'))

    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(6)
    expect(screen.queryByTestId('project-runtime-tasks-expand-7')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-runtime-tasks-collapse-7')).toBeInTheDocument()

    const nextProps = createSidebarProps({ runtimeWork: runtimeWorkWithTaskCount(16) })
    act(() => lifecycleStore.syncRuntimeWork(nextProps.runtimeWork))
    view.rerender(
      <RuntimeTaskLifecycleProvider store={lifecycleStore}>
        <DesktopSidebar {...nextProps} />
      </RuntimeTaskLifecycleProvider>
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
    expect(panel).toHaveClass('hidden')

    await user.click(button)

    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(panel).toHaveAttribute('aria-hidden', 'false')
    expect(panel).not.toHaveClass('hidden')

    await user.click(button)

    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(panel).toHaveAttribute('aria-hidden', 'true')
    expect(panel).toHaveClass('hidden')
  })

  test('switches project hover affordance based on expanded state', async () => {
    const user = userEvent.setup()

    renderSidebar()

    const button = screen.getByTestId('project-item-button')
    const title = screen.getByTestId('project-title-7')
    const folderIcon = screen.getByTestId('project-folder-icon-7')
    const collapsedIndicator = screen.getByTestId('project-collapsed-hover-indicator-7')
    const expandedIndicator = screen.getByTestId('project-expanded-hover-indicator-7')

    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(folderIcon).toHaveAttribute('data-state', 'closed')
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
    expect(screen.getByTestId('project-folder-icon-7')).toHaveAttribute('data-state', 'open')
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
    expect(panel).toHaveClass('hidden')
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

  test('does not render a standalone task workspace as a project', () => {
    const workspacePath = '/Users/alice/.wework/workspace/chats/standalone-task'

    renderSidebar({
      projects: [],
      devices: [localDevice({ device_id: 'device-1', name: 'Local Mac' })],
      standaloneDeviceId: 'device-1',
      standaloneWorkspacePath: workspacePath,
      runtimeWork: {
        projects: [],
        chats: [
          {
            deviceId: 'device-1',
            deviceName: 'Local Mac',
            deviceStatus: 'online',
            available: true,
            workspacePath,
            workspaceKind: 'chat',
            tasks: [
              {
                taskId: 'standalone-task',
                workspacePath,
                workspaceKind: 'chat',
                title: '只显示在任务中',
                runtime: 'codex',
              },
            ],
          },
        ],
        totalTasks: 1,
      },
    })

    expect(screen.queryByTestId('project-item-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-row-standalone-task')).toBeInTheDocument()
  })

  test('does not render a standalone project row when the path is already represented on another device', () => {
    const workspacePath = '/Users/alice/repo'

    renderSidebar({
      projects: [],
      devices: [localDevice({ device_id: 'device-1', name: 'Local Mac' })],
      standaloneDeviceId: 'device-1',
      standaloneWorkspacePath: workspacePath,
      runtimeWork: {
        projects: [
          {
            project: { id: 7, key: 'cloud-project', name: 'Repo' },
            totalTasks: 0,
            deviceWorkspaces: [
              {
                id: 10,
                projectId: 7,
                deviceId: 'device-cloud',
                deviceName: 'Cloud Device',
                deviceStatus: 'online',
                available: true,
                workspacePath,
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

    expect(screen.getAllByTestId('project-item-button')).toHaveLength(1)
    expect(screen.getByTestId('project-item-button')).toHaveTextContent('Repo')
  })
})
