import {
  AppUpdateContext,
  type AppUpdateContextValue,
} from '@/features/app-update/app-update-context'
import { applyAppearance } from '@/features/appearance/applyAppearance'
import { defaultAppearance } from '@/features/appearance/presets'
import type { CloudConnectionContextValue } from '@/features/cloud-connection/CloudConnectionContext'
import {
  CloudConnectionContext,
  DISCONNECTED_STATE,
} from '@/features/cloud-connection/CloudConnectionContext'
import {
  cacheRuntimeConversationQueuePaused,
  clearRuntimeConversationCacheForTests,
} from '@/features/workbench/runtimeConversationCache'
import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import { WorkbenchContext } from '@/features/workbench/workbenchContexts'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import '@/i18n'
import { setActiveKeybindings } from '@/lib/keybindings'
import { openLocalWorkspace } from '@/lib/local-terminal'
import { preloadDefaultDshUiTestModules } from '@/test/setup.dom'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'
import type { CloudWorkStatus } from '@/types/workbench'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest'
import { installGitUiTestContributions } from '../../../dsh/ui-git/test-support'
import { DesktopSidebar } from './DesktopSidebar'
import { WEWORK_DSH_SLOTS } from '@/features/dsh-runtime/dshUiSlots'
import { rightWorkspaceDshSidebar } from './workspace-panels/rightWorkspaceDshSidebar'

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
    onCloneGitRepository: vi.fn(),
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
  test('keeps worktree details in hover content and allows partially expanded tasks to collapse', async () => {
    const onOpenRuntimeTask = vi.fn()
    renderSidebar({
      onOpenRuntimeTask,
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
                workspacePath: '/workspace/Wegent',
                tasks: Array.from({ length: 26 }, (_, index) => ({
                  taskId: `worktree-${index}`,
                  workspacePath: `/workspace/worktrees/${index}/Wegent`,
                  workspaceKind: 'worktree' as const,
                  worktreeId: String(index),
                  title: `Task ${index}`,
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
    expect(screen.getByTestId('desktop-sidebar')).not.toHaveClass('font-normal')
    expect(screen.getByText('Wework')).toHaveClass('font-medium')
    await userEvent.click(screen.getByTestId('project-item-button'))
    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(5)
    const row = screen.getAllByTestId(/^runtime-local-task-row-/)[0]
    const taskId = row.dataset.testid!.replace('runtime-local-task-row-', '')
    expect(row).toHaveAccessibleName(`Task ${taskId.replace('worktree-', '')} · Git worktree`)
    expect(
      screen.queryByTestId(`runtime-local-task-worktree-icon-${taskId}`)
    ).not.toBeInTheDocument()
    await userEvent.hover(row)
    await waitFor(() =>
      expect(screen.getByTestId(`runtime-local-task-worktree-icon-${taskId}`)).toBeInTheDocument()
    )
    await userEvent.click(row)
    expect(onOpenRuntimeTask).toHaveBeenCalledWith({
      deviceId: 'local-device',
      workspacePath: `/workspace/worktrees/${taskId.replace('worktree-', '')}/Wegent`,
      taskId,
    })
    const expandButton = screen.getByTestId('project-runtime-tasks-expand-7')
    expect(expandButton).toHaveTextContent('显示更多')
    await userEvent.click(expandButton)
    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(15)
    expect(screen.getByTestId('project-runtime-tasks-expand-7')).toBeInTheDocument()
    const collapseButton = screen.getByTestId('project-runtime-tasks-collapse-7')
    expect(collapseButton).toHaveTextContent('收起')
    await userEvent.click(collapseButton)
    expect(screen.getAllByTestId(/^runtime-local-task-row-/)).toHaveLength(5)
    expect(screen.queryByTestId('project-runtime-tasks-collapse-7')).not.toBeInTheDocument()
  })

  test.each(['loading', 'error'] as const)(
    'does not present a %s task list as empty',
    async phase => {
      const onRetryRuntimeWork = vi.fn().mockResolvedValue(undefined)
      renderSidebar({
        runtimeWork: null,
        runtimeWorkLoad: { phase, error: phase === 'error' ? 'Request timed out' : null },
        onRetryRuntimeWork,
      })
      expect(screen.getByTestId('runtime-work-load-status')).toBeInTheDocument()
      expect(screen.queryByTestId('runtime-chat-empty')).not.toBeInTheDocument()
      expect(screen.queryByTestId('projects-empty-create-button')).not.toBeInTheDocument()
      if (phase === 'error') {
        await userEvent.click(screen.getByTestId('runtime-work-load-retry'))
        expect(onRetryRuntimeWork).toHaveBeenCalledOnce()
      }
    }
  )
  beforeEach(async () => {
    await preloadDefaultDshUiTestModules()
    await installGitUiTestContributions()
    experimentalFeatures.enabled = true
    window.history.replaceState({}, '', '/')
    localStorage.clear()
    vi.stubEnv('VITE_WEGENT_BACKEND_URL', '')
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

  test.each(['light'] as const)(
    'keeps the waiting indicator readable as the accent changes in %s mode',
    theme => {
      const sidebarStyles = readFileSync('src/styles/globals.css', 'utf8')
      const themeStyles =
        theme === 'light'
          ? sidebarStyles.split("[data-theme='dark']")[0]
          : sidebarStyles.split("[data-theme='dark']")[1]
      expect(themeStyles).toContain('--color-sidebar-attention: var(--color-primary);')
      const luminance = (rgb: string) => {
        const channels = rgb.split(' ').map(value => {
          const channel = Number(value) / 255
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
        })
        return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
      }
      const root = document.documentElement
      const originalAttributes = [
        'style',
        'data-theme',
        'data-appearance-mode',
        'data-appearance-theme',
        'data-ui-theme-id',
        'data-sidebar-translucent',
        'class',
      ].map(name => [name, root.getAttribute(name)] as const)
      try {
        for (const [accentColor, expectedAccent] of [
          [defaultAppearance.accentColor, '37 99 235'],
          ['#123456', '18 52 86'],
          ['#facc15', '250 204 21'],
          ['#808080', '128 128 128'],
          ['#000000', '0 0 0'],
          ['#ffffff', '255 255 255'],
          ['#fff', '255 255 255'],
          [defaultAppearance.accentColor, '37 99 235'],
        ]) {
          applyAppearance(
            {
              ...defaultAppearance,
              themeOverrides: { ...defaultAppearance.themeOverrides, [theme]: { accentColor } },
            },
            theme
          )
          expect(root.style.getPropertyValue('--color-primary')).toBe(expectedAccent)
          if (theme === 'light' && accentColor === defaultAppearance.accentColor) {
            expect(root.style.getPropertyValue('--color-sidebar-attention')).toBe(expectedAccent)
          }
          const foreground = luminance(root.style.getPropertyValue('--color-sidebar-attention'))
          const composite = (color: string, backdrop: number[]) => {
            const [rgb, opacity = '1'] = color.split('/')
            return rgb
              .trim()
              .split(/\s+/)
              .map(
                (value, index) =>
                  Number(value) * Number(opacity) + backdrop[index] * (1 - Number(opacity))
              )
          }
          const canvas = composite(root.style.getPropertyValue('--color-bg-base'), [0, 0, 0])
          const sidebar = composite(root.style.getPropertyValue('--color-sidebar'), canvas)
          for (const surface of [
            sidebar,
            composite(root.style.getPropertyValue('--color-sidebar-hover'), sidebar),
            composite(root.style.getPropertyValue('--color-sidebar-active'), sidebar),
          ]) {
            const background = luminance(
              expectedAccent
                .split(' ')
                .map((value, index) => Number(value) * 0.1 + surface[index] * 0.9)
                .join(' ')
            )
            const contrast =
              (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
            expect(contrast).toBeGreaterThanOrEqual(3)
          }
        }
      } finally {
        for (const [name, value] of originalAttributes) {
          if (value === null) root.removeAttribute(name)
          else root.setAttribute(name, value)
        }
      }
    }
  )

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

  test.each(['projects-create-button', 'projects-empty-create-button'])(
    'closes project creation with Escape without refocusing the clicked %s',
    async triggerTestId => {
      renderSidebar({
        projects: [],
        runtimeWork: { projects: [], chats: [], totalTasks: 0 },
        cloudWorkStatus: cloudWorkStatus({
          availability: 'empty',
          checks: { runtimeWork: 'empty' },
        }),
      })
      const user = userEvent.setup()
      const trigger = screen.getByTestId(triggerTestId)
      await user.click(trigger)
      const localOption = screen.getByTestId('project-create-local-option')
      expect(localOption).toHaveFocus()

      fireEvent.keyDown(localOption, { key: 'Escape', isComposing: true })
      expect(screen.getByTestId('projects-create-button-menu')).toBeInTheDocument()
      await user.keyboard('{Escape}')

      expect(screen.queryByTestId('projects-create-button-menu')).not.toBeInTheDocument()
      expect(trigger).not.toHaveFocus()
      await user.keyboard('{Enter}')
      expect(screen.queryByTestId('projects-create-button-menu')).not.toBeInTheDocument()
    }
  )

  test('keeps project creation keyboard navigation inside the dialog and returns to its keyboard trigger', async () => {
    renderSidebar()
    const user = userEvent.setup()
    const trigger = screen.getByTestId('projects-create-button')
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByTestId('project-create-local-option')).toHaveFocus()

    await user.tab()
    expect(screen.getByTestId('project-create-remote-option')).toHaveFocus()
    await user.tab()
    expect(screen.getByTestId('close-project-source-dialog')).toHaveFocus()
    await user.tab({ shift: true })
    expect(screen.getByTestId('project-create-remote-option')).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('projects-create-button-menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
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
      '[data-sidebar-sortable-id="project:8"]'
    ) as HTMLElement
    const localSortable = document.querySelector(
      '[data-sidebar-sortable-id="project:7"]'
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

  test('keeps cloud logout available without a configured backend URL', async () => {
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

    await userEvent.click(screen.getByTestId('settings-button'))

    expect(screen.getByTestId('logout-menu-button')).toHaveTextContent('退出登录')

    await userEvent.click(screen.getByTestId('logout-menu-button'))

    expect(disconnect).toHaveBeenCalledTimes(1)
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
    expect(button).toHaveAttribute('aria-label', '更新到 0.1.1')
    expect(button).not.toHaveAttribute('title')
    expect(action).not.toHaveClass('max-w-0', 'opacity-0', 'overflow-hidden')
    expect(screen.getByTestId('settings-button')).toHaveClass('pr-[72px]')

    await userEvent.click(button)

    expect(installUpdate).toHaveBeenCalledTimes(1)
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
    renderSidebar({
      devices: [localDevice()],
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
  })

  test('treats an empty cloud device list as an add-device state instead of an error', async () => {
    renderSidebar({
      devices: [localDevice()],
      cloudWorkStatus: cloudWorkStatus({
        availability: 'empty',
        checks: { devices: 'empty' },
      }),
    })

    expect(screen.queryByTestId('sidebar-cloud-error-button')).not.toBeInTheDocument()
    expect(screen.getByTestId('sidebar-cloud-connection-button')).toHaveTextContent('无设备')

    await userEvent.click(screen.getByTestId('sidebar-cloud-connection-button'))

    expect(screen.getByTestId('standalone-folder-project-dialog')).toHaveTextContent('添加设备')
    expect(screen.getByTestId('add-device-panel')).toBeInTheDocument()
  })

  test('shows managed cloud and remote Docker choices without a host script', async () => {
    renderSidebar()
    await userEvent.click(screen.getByTestId('sidebar-cloud-connection-button'))
    expect(screen.getByTestId('add-device-panel')).toHaveTextContent('云设备')
    expect(screen.getByTestId('add-device-panel')).toHaveTextContent('远程 Docker 设备')
    expect(screen.queryByTestId('remote-device-startup-tab-process')).not.toBeInTheDocument()
    expect(screen.queryByTestId('remote-docker-command')).not.toBeInTheDocument()
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

  test('opens a contributed workspace sidebar tab without changing the current route', async () => {
    const runtime = window.__WEWORK_DSH_UI__
    expect(runtime).toBeDefined()
    const openTab = vi.spyOn(rightWorkspaceDshSidebar, 'openTab').mockImplementation(() => {})
    const navigation = [
      ...runtime!.getEntries(WEWORK_DSH_SLOTS.sidebarNavigation),
      {
        id: 'reference-website.navigation',
        label: 'Reference website',
        icon: 'globe',
        workspaceSidebarTab: 'reference-website',
        testId: 'reference-website-button',
      },
    ]
    window.__WEWORK_DSH_UI__ = {
      ...runtime!,
      getEntries: slotName =>
        slotName === WEWORK_DSH_SLOTS.sidebarNavigation
          ? navigation
          : runtime!.getEntries(slotName),
    }
    window.history.replaceState({}, '', '/')

    renderSidebar()
    await userEvent.click(screen.getByTestId('reference-website-button'))

    expect(openTab).toHaveBeenCalledWith({ type: 'reference-website' })
    expect(window.location.pathname).toBe('/')
    openTab.mockRestore()
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

  test('shows Applications while experimental features are disabled', () => {
    experimentalFeatures.enabled = false
    renderSidebar()

    expect(screen.getByTestId('sites-button')).toHaveTextContent('应用')
  })

  test('shows My stand-in with a Beta badge regardless of the experimental preference', async () => {
    const onOpenStandIn = vi.fn()
    experimentalFeatures.enabled = false
    const view = renderSidebar({ onOpenStandIn })
    expect(screen.getByTestId('personal-stand-in-button')).toBeVisible()
    expect(screen.getByTestId('personal-stand-in-beta')).toHaveTextContent('Beta')
    await userEvent.click(screen.getByTestId('personal-stand-in-button'))
    view.unmount()
    experimentalFeatures.enabled = true
    renderSidebar({ onOpenStandIn })
    await userEvent.click(screen.getByTestId('personal-stand-in-button'))
    expect(onOpenStandIn).toHaveBeenCalledTimes(2)
  })

  test.each([0, 3, 105])(
    'shows the stand-in unread count %i with a capped visible badge',
    count => {
      renderSidebar({ onOpenStandIn: vi.fn(), standInUnreadCount: count })
      if (count === 0) {
        expect(screen.queryByTestId('personal-stand-in-unread-count')).not.toBeInTheDocument()
      } else {
        const badge = screen.getByTestId('personal-stand-in-unread-count')
        expect(badge).toHaveTextContent(count > 99 ? '99+' : String(count))
        expect(badge).toHaveAttribute('aria-label', `${count} 条未读`)
      }
      expect(screen.getByTestId('personal-stand-in-beta')).toBeVisible()
    }
  )

  test('opens independent schedules from the sidebar when experimental features are disabled', async () => {
    experimentalFeatures.enabled = false
    renderSidebar()

    expect(screen.getByTestId('automation-button')).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('automation-button'))
    expect(window.location.pathname).toBe('/automations')
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
      '[data-sidebar-sortable-id="local-device:chat-1"]'
    ) as HTMLElement
    const secondSortable = document.querySelector(
      '[data-sidebar-sortable-id="local-device:chat-2"]'
    ) as HTMLElement
    expect(screen.getByTestId('runtime-chat-task-sortable-list')).toContainElement(firstSortable)
    expect(firstSortable).toHaveAttribute('tabindex', '0')
    expect(firstSortable).toHaveAttribute('role', 'button')
    expect(secondSortable).toHaveAttribute('tabindex', '0')

    const firstActivator = screen.getByTestId('runtime-local-task-drag-activator-chat-1')
    const firstTitleSpace = screen.getByTestId('runtime-local-task-title-chat-1')
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

  test('shows offline device projects and tasks by default and persists hiding them', async () => {
    const user = userEvent.setup()
    const runtimeWork = {
      projects: [
        {
          project: { id: 7, key: 'project:7', name: 'Online project' },
          deviceWorkspaces: [
            {
              deviceId: 'local-device',
              deviceName: 'Local Mac',
              deviceStatus: 'online' as const,
              available: true,
              workspacePath: '/repo/online',
              tasks: [
                {
                  taskId: 'online-project-task',
                  workspacePath: '/repo/online',
                  title: 'Online project task',
                  runtime: 'codex',
                },
              ],
            },
          ],
        },
        {
          project: { id: 8, key: 'project:8', name: 'Offline project' },
          deviceWorkspaces: [
            {
              deviceId: 'remote-device',
              deviceName: 'Remote Host',
              deviceStatus: 'offline' as const,
              available: false,
              workspacePath: '/repo/offline',
              tasks: [
                {
                  taskId: 'offline-project-task',
                  workspacePath: '/repo/offline',
                  title: 'Offline project task',
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
          deviceName: 'Local Mac',
          deviceStatus: 'online' as const,
          available: true,
          workspacePath: '/chats/online',
          workspaceKind: 'chat',
          tasks: [
            {
              taskId: 'online-chat-task',
              workspacePath: '/chats/online',
              workspaceKind: 'chat',
              title: 'Online chat task',
              runtime: 'codex',
            },
          ],
        },
        {
          deviceId: 'remote-device',
          deviceName: 'Remote Host',
          deviceStatus: 'offline' as const,
          available: false,
          workspacePath: '/chats/offline',
          workspaceKind: 'chat',
          tasks: [
            {
              taskId: 'offline-chat-task',
              workspacePath: '/chats/offline',
              workspaceKind: 'chat',
              title: 'Offline chat task',
              runtime: 'codex',
            },
          ],
        },
      ],
      totalTasks: 4,
    }
    const props = {
      devices: [
        localDevice(),
        localDevice({
          id: 2,
          device_id: 'remote-device',
          name: 'Remote Host',
          status: 'offline' as const,
          is_default: false,
          device_type: 'remote',
        }),
      ],
      runtimeWork,
      onArchiveProjectsConversations: vi.fn().mockResolvedValue(undefined),
    }

    const view = renderSidebar(props)

    expect(screen.getByTestId('project-row-7')).toBeInTheDocument()
    expect(screen.getByTestId('project-row-8')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-row-online-chat-task')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-row-offline-chat-task')).toBeInTheDocument()

    const offlineProjectToggle = screen
      .getByTestId('project-row-8')
      .querySelector<HTMLButtonElement>('[data-testid="project-item-button"]')
    expect(offlineProjectToggle).not.toBeNull()
    await user.click(offlineProjectToggle!)
    expect(screen.getByTestId('runtime-local-task-row-offline-project-task')).toBeInTheDocument()

    await user.click(screen.getByTestId('projects-section-menu'))
    const visibilityItem = screen.getByTestId('projects-section-show-offline-device-items')
    expect(visibilityItem).toHaveAttribute('role', 'menuitemcheckbox')
    expect(visibilityItem).toHaveAttribute('aria-checked', 'true')
    await user.click(visibilityItem)

    expect(screen.getByTestId('project-row-7')).toBeInTheDocument()
    expect(screen.queryByTestId('project-row-8')).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-row-online-chat-task')).toBeInTheDocument()
    expect(screen.queryByTestId('runtime-local-task-row-offline-chat-task')).not.toBeInTheDocument()
    expect(localStorage.getItem('wework.desktop.sidebar.showOfflineDeviceItems.1')).toBe('false')

    view.unmount()
    renderSidebar(props)

    expect(screen.queryByTestId('project-row-8')).not.toBeInTheDocument()
    expect(screen.queryByTestId('runtime-local-task-row-offline-chat-task')).not.toBeInTheDocument()
    await user.click(screen.getByTestId('projects-section-menu'))
    expect(screen.getByTestId('projects-section-show-offline-device-items')).toHaveAttribute(
      'aria-checked',
      'false'
    )
  })

  test('shows a queued active Goal recovery as running while preserving queue actions', async () => {
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
                    taskId: 'recovering-goal',
                    workspacePath: '/repo/Wegent',
                    title: 'Recover active Goal',
                    runtime: 'codex',
                    running: false,
                    status: 'queued',
                    queuePosition: 2,
                    goalStatus: 'active',
                    completedAt: 1_789_484_915_000,
                    updatedAt: '2026-09-15T15:08:35Z',
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

    expect(screen.getByTestId('runtime-local-task-running-recovering-goal')).toHaveAttribute(
      'aria-label',
      '运行中，有目标'
    )
    expect(
      screen.queryByTestId('runtime-local-task-queued-recovering-goal')
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-queue-down-recovering-goal')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-force-start-recovering-goal')).toBeInTheDocument()

    act(() => {
      cacheRuntimeConversationQueuePaused(
        {
          deviceId: 'local-device',
          taskId: 'recovering-goal',
          workspacePath: '/repo/Wegent',
        },
        true
      )
    })

    expect(screen.getByTestId('runtime-local-task-running-recovering-goal')).toBeInTheDocument()
    expect(
      screen.queryByTestId('runtime-local-task-queue-paused-recovering-goal')
    ).not.toBeInTheDocument()
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
      const sidebarProps = {
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
      }
      const rendered = renderSidebar(sidebarProps)

      await user.click(screen.getByTestId('project-item-button'))
      let taskRow = screen.getByTestId('runtime-local-task-row-codex-1')
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
      const contextMenuTrigger = screen.getByTestId('runtime-local-task-menu-codex-1')
      expect(contextMenuTrigger).toHaveClass('hidden')
      expect(contextMenuTrigger.parentElement?.children).toHaveLength(1)
      expect(contextMenuTrigger.parentElement?.firstElementChild).toBe(contextMenuTrigger)
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

      rendered.unmount()
      renderSidebar(sidebarProps)
      await user.click(screen.getByTestId('project-item-button'))
      taskRow = screen.getByTestId('runtime-local-task-row-codex-1')
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

  test('renders the icon declared by a conversation menu extension', async () => {
    const user = userEvent.setup()
    window.__WEWORK_DSH_EXTENSIONS__ = {
      getRevision: () => 0,
      subscribe: () => () => {},
      context: { matches: () => true },
      commands: {
        get: (id: string) =>
          id === 'conversation-export.open'
            ? {
                id,
                title: '导出会话',
                icon: 'download',
              }
            : null,
      },
      menus: {
        list: (location: string) =>
          location === 'conversation.context'
            ? [
                {
                  id: 'conversation-export.conversation.context',
                  command: 'conversation-export.open',
                  title: '导出会话',
                  icon: 'download',
                  enabled: true,
                },
              ]
            : [],
      },
    } as unknown as NonNullable<Window['__WEWORK_DSH_EXTENSIONS__']>
    onTestFinished(() => {
      delete window.__WEWORK_DSH_EXTENSIONS__
    })

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
    })

    await user.click(screen.getByTestId('runtime-local-task-menu-codex-1'))
    const exportItem = screen.getByTestId(
      'runtime-local-task-menu-extension-conversation-export.conversation.context-codex-1'
    )
    await waitFor(() => expect(exportItem.querySelector('svg.lucide-download')).toBeInTheDocument())
  })

  test('preserves pending archive undo when a runtime task gains its thread id', async () => {
    const user = userEvent.setup()
    const onArchiveRuntimeTask = vi.fn().mockResolvedValue(undefined)
    const initialTask = {
      taskId: 'codex-1',
      workspacePath: '/repo/Wegent',
      title: 'Fix reconnect',
      runtime: 'codex' as const,
      updatedAt: '2026-06-20T02:00:00Z',
    }
    const runtimeWork = (threadId?: string) => ({
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
              tasks: [{ ...initialTask, ...(threadId ? { threadId } : {}) }],
            },
          ],
        },
      ],
      chats: [],
      totalTasks: 1,
    })
    const initialProps = createSidebarProps({
      runtimeWork: runtimeWork(),
      onArchiveRuntimeTask,
    })
    const lifecycleStore = new RuntimeTaskLifecycleStore('desktop-sidebar-archive-identity-test')
    lifecycleStore.syncRuntimeWork(initialProps.runtimeWork)
    const view = render(
      <RuntimeTaskLifecycleProvider store={lifecycleStore}>
        <DesktopSidebar {...initialProps} />
      </RuntimeTaskLifecycleProvider>
    )

    await user.click(screen.getByTestId('project-item-button'))
    await user.click(screen.getByTestId('runtime-local-task-archive-codex-1'))

    expect(screen.getByTestId('runtime-local-task-archive-toast-codex-1')).toBeInTheDocument()

    const nextProps = {
      ...initialProps,
      runtimeWork: runtimeWork('thread-1'),
    }
    act(() => {
      lifecycleStore.syncRuntimeWork(nextProps.runtimeWork)
      view.rerender(
        <RuntimeTaskLifecycleProvider store={lifecycleStore}>
          <DesktopSidebar {...nextProps} />
        </RuntimeTaskLifecycleProvider>
      )
    })

    expect(screen.getByTestId('runtime-local-task-archive-toast-codex-1')).toBeInTheDocument()
    expect(
      screen.getByTestId('runtime-local-task-row-codex-1').closest('[data-sidebar-sortable-id]')
    ).toHaveAttribute('data-sidebar-sortable-id', 'local-device:codex-1')

    await user.click(screen.getByTestId('runtime-local-task-archive-undo-codex-1'))

    expect(onArchiveRuntimeTask).not.toHaveBeenCalled()
    expect(screen.getByTestId('runtime-local-task-row-codex-1')).not.toHaveClass('hidden')
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
    expect(screen.getByTestId('archive-project-conversations-7')).toHaveTextContent('归档所有聊天')
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

  test.each([
    ['remote', 'relay', '2.0.21'],
    ['cloud', 'runtime', '2.0.21'],
    ['remote', 'relay', undefined],
    ['cloud', 'runtime', undefined],
  ] as const)(
    'keeps an online %s project editable through its %s owner alias according to executor version %s',
    async (deviceType, ownerAlias, executorVersion) => {
      const pluginApi = {
        readState: vi.fn().mockResolvedValue({ marketplaceItems: [] }),
        installAvailablePlugin: vi.fn(),
      }
      const save = vi.fn().mockResolvedValue(undefined)
      const listDirectories = vi.fn().mockResolvedValue([])
      const canonicalDevice = {
        device_id: 'executor',
        socket_device_id: 'relay',
        runtime_instance_id: 'runtime',
        device_type: deviceType,
        status: 'online',
        name: 'Owner',
        executor_version: executorVersion,
      }
      const projectWork = {
        project: {
          id: 7,
          key: 'real',
          sidebarStateKey: 'mirror',
          ownerDeviceId: ownerAlias,
          ownerProjectKey: 'real',
          stateDeviceId: 'local-device',
          name: 'Device project',
          source: 'remote_project',
          roots: [{ kind: 'local', path: '/owner' }],
        },
        deviceWorkspaces: [
          {
            deviceId: 'executor',
            remoteHostId: 'relay',
            workspaceSource: 'remote',
            workspacePath: '/owner',
            available: true,
            tasks: [],
          },
        ],
      }
      const projectDevicePluginApi = vi.fn().mockReturnValue(pluginApi)
      renderSidebar({
        projects: [],
        devices: [canonicalDevice] as never,
        runtimeWork: { projects: [projectWork], chats: [], totalTasks: 0 },
        onUpdateLocalRuntimeProject: save,
        onListDeviceDirectories: listDirectories,
        projectDevicePluginApi,
      })
      await userEvent.click(screen.getByTestId('project-menu-7'))
      await userEvent.click(screen.getByTestId('rename-project-7'))
      expect(screen.getByTestId('save-local-project-button')).toBeEnabled()
      expect(screen.queryByTestId('project-device-offline')).not.toBeInTheDocument()
      if (executorVersion === undefined) {
        expect(screen.getByTestId('local-project-name-input')).toBeEnabled()
        expect(screen.getByTestId('add-local-project-folders')).toBeDisabled()
        expect(screen.getByTestId('project-folders-upgrade-hint')).toBeVisible()
        await userEvent.click(screen.getByTestId('local-project-settings-ai-tab'))
        expect(screen.getByTestId('local-project-instructions-input')).toBeDisabled()
        await userEvent.click(screen.getByTestId('local-project-settings-basic-tab'))
        fireEvent.change(screen.getByTestId('local-project-name-input'), {
          target: { value: 'Renamed alias project' },
        })
        await userEvent.click(screen.getByTestId('save-local-project-button'))
        await waitFor(() =>
          expect(save).toHaveBeenCalledWith({
            deviceId: ownerAlias,
            projectKey: 'real',
            name: 'Renamed alias project',
            roots: ['/owner'],
          })
        )
        expect(listDirectories).not.toHaveBeenCalled()
        expect(projectDevicePluginApi).toHaveBeenCalledWith(ownerAlias)
        return
      }
      await userEvent.click(screen.getByTestId('local-project-settings-plugins-tab'))
      await waitFor(() =>
        expect(pluginApi.readState).toHaveBeenCalledWith({
          mergeAllMarketplaces: true,
          refresh: true,
        })
      )
      await userEvent.click(screen.getByTestId('local-project-settings-basic-tab'))
      await userEvent.click(screen.getByTestId('add-local-project-folders'))
      expect(screen.getByTestId('local-project-folder-picker')).toBeInTheDocument()
      await waitFor(() => expect(listDirectories).toHaveBeenCalledWith('executor', '/owner'))
      await userEvent.click(screen.getByTestId('save-local-project-button'))
      await waitFor(() =>
        expect(save).toHaveBeenCalledWith(
          expect.objectContaining({ deviceId: ownerAlias, projectKey: 'real', roots: ['/owner'] })
        )
      )
      expect(projectDevicePluginApi).toHaveBeenCalledWith(ownerAlias)
    }
  )

  test.each(['remote', 'cloud'])(
    'opens full project settings for an offline %s device',
    async deviceType => {
      const user = userEvent.setup()
      const projectDevicePluginApi = vi.fn()
      renderSidebar({
        projects: [],
        devices: [
          { device_id: 'owner', device_type: deviceType, status: 'offline', name: 'Owner' },
        ] as never,
        runtimeWork: {
          projects: [
            {
              project: {
                id: 7,
                key: 'real',
                sidebarStateKey: 'mirror',
                source: 'remote_project',
                stateDeviceId: 'local-device',
                ownerDeviceId: 'owner',
                ownerProjectKey: 'real',
                name: 'Device project',
                roots: [{ kind: 'local', path: '/owner' }],
              },
              deviceWorkspaces: [
                {
                  deviceId: 'owner',
                  remoteHostId: 'owner',
                  workspaceSource: 'remote',
                  workspacePath: '/owner',
                  available: false,
                  tasks: [],
                },
              ],
            },
          ],
          chats: [],
          totalTasks: 0,
        },
        onUpdateLocalRuntimeProject: vi.fn(),
        projectDevicePluginApi,
      })
      await user.click(screen.getByTestId('project-menu-7'))
      await user.click(screen.getByTestId('rename-project-7'))
      expect(screen.getByTestId('local-project-edit-dialog')).toBeInTheDocument()
      expect(screen.getByTestId('save-local-project-button')).toBeDisabled()
      expect(projectDevicePluginApi).toHaveBeenCalledWith('owner')
    }
  )

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

  test('keeps the account available during cloud errors without a second notification surface', () => {
    renderSidebar(
      {},
      {
        status: 'error',
        isConnected: false,
        token: null,
        user: null,
        error: 'Cloud connection failed',
      }
    )
    expect(screen.getByTestId('settings-button')).toBeVisible()
    expect(screen.queryByTestId('sidebar-global-im-notification-button')).not.toBeInTheDocument()
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
  test('preserves manual task-list scrolling across runtime refreshes', async () => {
    localStorage.setItem('wework:debug-runtime', '1')
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    onTestFinished(() => debug.mockRestore())
    const autoScrollEntries = () =>
      debug.mock.calls.flatMap(([prefix, entry]) =>
        prefix === '[Wework] Runtime sidebar state' && entry?.event === 'active-task-auto-scroll'
          ? [entry]
          : []
      )
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
              running: status === 'running',
              interactionStatus:
                status === 'waiting_for_user_input' ? ('waitingForUserInput' as const) : null,
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
    const initialAutoScrollCount = autoScrollEntries().length
    expect(autoScrollEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'before', willScroll: true }),
        expect.objectContaining({ phase: 'after', willScroll: true }),
      ])
    )

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
    expect(autoScrollEntries()).toHaveLength(initialAutoScrollCount)
    expect(screen.getByTestId('runtime-local-task-waiting-active-task')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-hover-actions-active-task')).toHaveClass(
      'right-full',
      'mr-1'
    )

    const resumedProps = createSidebarProps({
      projects: [],
      runtimeWork: runtimeWork('running'),
      currentRuntimeTask,
    })
    act(() => lifecycleStore.syncRuntimeWork(resumedProps.runtimeWork))
    view.rerender(
      <RuntimeTaskLifecycleProvider store={lifecycleStore}>
        <DesktopSidebar {...resumedProps} />
      </RuntimeTaskLifecycleProvider>
    )
    expect(screen.queryByTestId('runtime-local-task-waiting-active-task')).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-running-active-task')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-local-task-hover-actions-active-task')).toHaveClass(
      'right-0'
    )
    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(scrollContainer.scrollTop).toBe(180)
    expect(autoScrollEntries()).toHaveLength(initialAutoScrollCount)

    const switchedProps = createSidebarProps({
      projects: [],
      runtimeWork: resumedProps.runtimeWork,
      currentRuntimeTask: {
        deviceId: 'local-device',
        taskId: 'other-task',
        workspacePath: chatPath,
      },
    })
    scrollIntoView.mockImplementationOnce(() => {
      scrollContainer.scrollTop = 50
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
    expect(autoScrollEntries().slice(-2)).toEqual([
      expect.objectContaining({
        phase: 'before',
        changedDependencies: ['taskId', 'taskKey'],
        previousDependencies: expect.objectContaining({ taskId: 'active-task', rowVisible: true }),
        dependencies: expect.objectContaining({ taskId: 'other-task', rowVisible: true }),
        metrics: expect.objectContaining({ scrollTop: 180 }),
      }),
      expect.objectContaining({
        phase: 'after',
        changedDependencies: ['taskId', 'taskKey'],
        metrics: expect.objectContaining({ scrollTop: 50 }),
      }),
    ])
  })
})
