import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import '@/i18n'
import { preloadDefaultDshUiTestModules } from '@/test/setup.dom'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { DesktopSidebar } from './DesktopSidebar'

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

function renderSidebar(overrides: Partial<Parameters<typeof DesktopSidebar>[0]> = {}) {
  const props: Parameters<typeof DesktopSidebar>[0] = createSidebarProps(overrides)
  const lifecycleStore = new RuntimeTaskLifecycleStore('desktop-sidebar-test')
  lifecycleStore.syncRuntimeWork(props.runtimeWork)

  const tree = (sidebarProps: Parameters<typeof DesktopSidebar>[0]) => (
    <RuntimeTaskLifecycleProvider store={lifecycleStore}>
      <DesktopSidebar {...sidebarProps} />
    </RuntimeTaskLifecycleProvider>
  )
  const view = render(tree(props))
  return (next: Partial<Parameters<typeof DesktopSidebar>[0]>) =>
    view.rerender(tree({ ...props, ...next }))
}

// Compile injected modules before the per-test hook, as in the original suite.
await preloadDefaultDshUiTestModules()

beforeEach(async () => {
  await preloadDefaultDshUiTestModules()
  localStorage.clear()
  window.__WEWORK_RUNTIME_CONFIG__ = {
    ...window.__WEWORK_RUNTIME_CONFIG__,
    desktopHost: 'electron',
  }
  Element.prototype.scrollIntoView = vi.fn()
}, 60_000)

describe('DesktopSidebar event waits', () => {
  test.each([
    ['armed', false, '等待事件'],
    ['pending', false, '事件已到达，等待继续'],
    ['error', false, '事件继续执行遇到问题，请查看会话'],
    ['cancelled', false, null],
    ['armed', true, null],
    ['pending', true, '事件已到达，等待继续'],
  ] as const)('event subscription sidebar status %s running=%s', async (status, running, label) => {
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
                    taskId: 'event-wait',
                    title: 'Wait for CI',
                    runtime: 'codex',
                    running,
                    status: running ? 'running' : 'done',
                    runtimeHandle: {
                      connectionEventSubscriptions: [
                        { subscription_key: 'one', source: { name: 'Wegent' }, status },
                      ],
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
    await userEvent.click(screen.getByTestId('project-item-button'))
    const icon = screen.queryByTestId('runtime-local-task-event-event-wait')
    if (label) expect(icon).toHaveAttribute('aria-label', label)
    else expect(icon).not.toBeInTheDocument()
  })
})

test('keeps the loaded empty task list visible while refreshing and after a refresh failure', () => {
  const rerender = renderSidebar({
    runtimeWork: null,
    runtimeWorkLoad: { phase: 'loading', error: null },
  })
  const emptyId = 'runtime-chat-empty'
  const statusId = 'runtime-work-load-status'
  expect(screen.queryByTestId(emptyId)).not.toBeInTheDocument()
  expect(screen.getByTestId(statusId)).toHaveAttribute('role', 'status')

  const runtimeWork = { projects: [], chats: [], totalTasks: 0 }
  rerender({ runtimeWork, runtimeWorkLoad: { phase: 'ready', error: null } })
  const emptyRow = screen.getByTestId(emptyId)

  rerender({ runtimeWork, runtimeWorkLoad: { phase: 'refreshing', error: null } })
  expect(screen.getByTestId(emptyId)).toBe(emptyRow)
  expect(screen.queryByTestId(statusId)).not.toBeInTheDocument()

  rerender({ runtimeWork, runtimeWorkLoad: { phase: 'error', error: 'Request timed out' } })
  expect(screen.getByTestId(emptyId)).toBe(emptyRow)
  expect(screen.getByTestId(statusId)).toHaveAttribute('role', 'alert')
})

test.each(['right-click', 'more button'])(
  'dismisses the project preview for the %s menu',
  async entry => {
    renderSidebar()
    const user = userEvent.setup()
    const row = screen.getByTestId('project-row-7')
    const cardId = 'project-hover-card-7'
    const menuId = 'project-menu-7-menu'

    await user.hover(row)
    expect(await screen.findByTestId(cardId)).toBeVisible()

    if (entry === 'right-click') {
      fireEvent.contextMenu(row, { clientX: 120, clientY: 200 })
    } else {
      await user.click(screen.getByTestId('project-menu-7'))
    }

    expect(await screen.findByTestId(menuId)).toBeVisible()
    expect(screen.getByTestId('remove-project-7')).toBeVisible()
    await waitFor(() => expect(screen.queryByTestId(cardId)).not.toBeInTheDocument())
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId(menuId)).not.toBeInTheDocument())

    await user.unhover(row)
    await user.hover(row)
    expect(await screen.findByTestId(cardId)).toBeVisible()
  }
)

test('chat batch archive releases the sidebar while the request is pending', async () => {
  const archive = Promise.withResolvers<void>()
  const onArchiveChatConversations = vi.fn(() => archive.promise)
  const onOpenSearch = vi.fn()
  renderSidebar({
    onArchiveChatConversations,
    onOpenSearch,
    runtimeWork: {
      projects: [],
      chats: [
        {
          deviceId: 'local-device',
          available: true,
          workspacePath: '/repo/Wegent',
          workspaceKind: 'chat',
          tasks: [
            {
              taskId: 'first-chat',
              title: 'First chat',
              runtime: 'codex',
              running: false,
              status: 'done',
            },
            {
              taskId: 'second-chat',
              title: 'Second chat',
              runtime: 'codex',
              running: false,
              status: 'done',
            },
          ],
        },
      ],
      totalTasks: 2,
    },
  })
  const menu = screen.getByTestId('runtime-chat-section-menu')
  const action = 'runtime-chat-section-archive-all-chats'
  const dialog = 'runtime-chat-section-archive-conversations-dialog'

  await userEvent.click(menu)
  expect(screen.getByTestId(action)).not.toHaveAttribute('aria-disabled', 'true')
  await userEvent.click(screen.getByTestId(action))
  await userEvent.click(screen.getByTestId(`${dialog}-confirm-button`))

  expect(onArchiveChatConversations).toHaveBeenCalledOnce()
  expect(screen.queryByTestId(`${dialog}-overlay`)).not.toBeInTheDocument()
  await userEvent.click(screen.getByTestId('runtime-search-button'))
  expect(onOpenSearch).toHaveBeenCalledOnce()
  await userEvent.click(menu)
  expect(screen.getByTestId(action)).toHaveAttribute('aria-disabled', 'true')

  await act(async () => archive.resolve())
  expect(screen.getByTestId(action)).not.toHaveAttribute('aria-disabled', 'true')
})
