import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import '@/i18n'
import { setActiveKeybindings } from '@/lib/keybindings'
import { preloadDefaultDshUiTestModules } from '@/test/setup.dom'
import type { RuntimeTaskSummary, RuntimeWorkListResponse } from '@/types/api'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { DesktopSidebar } from './DesktopSidebar'

type SidebarProps = Parameters<typeof DesktopSidebar>[0]

function task(taskId: string, overrides: Partial<RuntimeTaskSummary> = {}): RuntimeTaskSummary {
  return { taskId, title: taskId, workspacePath: '/repo', runtime: 'codex', ...overrides }
}

function runtimeWork(): RuntimeWorkListResponse {
  return {
    projects: [
      {
        project: { id: 7, key: 'pinned-space', name: 'Pinned space', pinned: true },
        totalTasks: 2,
        deviceWorkspaces: [
          {
            deviceId: 'local-device',
            available: true,
            workspacePath: '/repo',
            tasks: [task('pinned-read', { pinned: true }), task('project-unread')],
          },
        ],
      },
      {
        project: { id: 8, key: 'regular-space', name: 'Regular space' },
        totalTasks: 1,
        deviceWorkspaces: [
          {
            deviceId: 'local-device',
            available: true,
            workspacePath: '/repo',
            tasks: [task('project-read')],
          },
        ],
      },
    ],
    chats: [
      {
        deviceId: 'local-device',
        available: true,
        workspacePath: '/chats',
        workspaceKind: 'chat',
        tasks: [
          task('pinned-unread', { pinned: true }),
          task('chat-read'),
          task('chat-unread'),
          task('running-read', { running: true }),
          task('waiting-read', { status: 'waiting_for_user_input' }),
        ],
      },
    ],
    totalTasks: 8,
  }
}

function renderSidebar(overrides: Partial<SidebarProps> = {}) {
  let props: SidebarProps = {
    user: { id: 1, user_name: 'alice', email: 'alice@example.com' },
    projects: [],
    devices: [],
    runtimeWork: runtimeWork(),
    unreadRuntimeTaskKeys: new Set([
      'local-device\0pinned-unread',
      'local-device\0project-unread',
      'local-device\0chat-unread',
    ]),
    onNewChat: vi.fn(),
    onStartStandaloneChat: vi.fn(),
    onSelectProject: vi.fn(),
    onStartNewProjectChat: vi.fn(),
    onUpdateProjectName: vi.fn(),
    onRemoveProject: vi.fn(),
    onCloneGitRepository: vi.fn(),
    onOpenSettings: vi.fn(),
    onLogout: vi.fn(),
    ...overrides,
  }
  const store = new RuntimeTaskLifecycleStore('collapse-read-test')
  store.syncRuntimeWork(props.runtimeWork)
  const tree = () => (
    <RuntimeTaskLifecycleProvider store={store}>
      <DesktopSidebar {...props} />
    </RuntimeTaskLifecycleProvider>
  )
  const view = render(tree())
  return {
    ...view,
    store,
    rerenderProps(next: Partial<SidebarProps>) {
      props = { ...props, ...next }
      view.rerender(tree())
    },
  }
}

const rowId = (id: string) => `runtime-local-task-row-${id}`
async function selectAction(action: 'collapse-read' | 'expand-read' | 'priority') {
  await userEvent.click(screen.getByTestId('runtime-task-view-menu-button'))
  await userEvent.click(screen.getByTestId(`runtime-task-view-${action}`))
}

await preloadDefaultDshUiTestModules()

describe('DesktopSidebar read conversation collapse', () => {
  beforeEach(async () => {
    await preloadDefaultDshUiTestModules()
    localStorage.clear()
    setActiveKeybindings([])
    Element.prototype.scrollIntoView = vi.fn()
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    })
  })

  test.each(['project', 'task'] as const)(
    'keeps project spaces collapsed when switching tasks in a pinned %s',
    async pinned => {
      const work = runtimeWork()
      work.projects[0].project.pinned = pinned === 'project'
      const workspace = work.projects[0].deviceWorkspaces![0]
      workspace.tasks = [
        task('first', { pinned: pinned === 'task' }),
        task('second', { pinned: pinned === 'task' }),
      ]
      const onOpenRuntimeTask = vi.fn()
      const view = renderSidebar({ runtimeWork: work, onOpenRuntimeTask })
      const toggle = screen.getByTestId('projects-section-toggle')
      if (pinned === 'project') {
        await userEvent.click(
          within(screen.getByTestId('project-row-7')).getByTestId('project-item-button')
        )
      }
      await userEvent.click(toggle)
      expect(toggle).toHaveAttribute('aria-expanded', 'false')

      for (const taskId of ['first', 'second']) {
        const scrollIntoView = vi.mocked(Element.prototype.scrollIntoView)
        scrollIntoView.mockClear()
        await userEvent.click(screen.getByTestId(rowId(taskId)))
        expect(onOpenRuntimeTask).toHaveBeenLastCalledWith({
          deviceId: 'local-device',
          taskId,
          workspacePath: '/repo',
        })
        view.rerenderProps({ currentRuntimeTask: onOpenRuntimeTask.mock.lastCall![0] })

        expect(toggle).toHaveAttribute('aria-expanded', 'false')
        expect(screen.getByTestId('sidebar-pinned-section')).toContainElement(
          screen.getByTestId(rowId(taskId))
        )
        expect(screen.queryByTestId('project-row-8')).not.toBeInTheDocument()
        expect(scrollIntoView.mock.contexts).toContain(screen.getByTestId(rowId(taskId)))
      }

      view.unmount()
      renderSidebar({ runtimeWork: work, currentRuntimeTask: onOpenRuntimeTask.mock.lastCall![0] })
      expect(screen.getByTestId('projects-section-toggle')).toHaveAttribute(
        'aria-expanded',
        'false'
      )
    }
  )

  test('reveals a selected regular project task and preserves a subsequent manual collapse', async () => {
    const view = renderSidebar()
    const toggle = screen.getByTestId('projects-section-toggle')
    await userEvent.click(toggle)

    view.rerenderProps({
      currentRuntimeTask: { deviceId: 'local-device', taskId: 'project-read' },
    })

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('project-local-tasks-panel-8')).toContainElement(
      screen.getByTestId(rowId('project-read'))
    )

    await userEvent.click(toggle)
    view.rerenderProps({ runtimeWork: runtimeWork() })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  test.each([
    { group: 'regular project', taskId: 'project-read', expanded: true, projectIds: [8] },
    { group: 'pinned project', taskId: 'project-unread', expanded: false, projectIds: [7] },
    { group: 'pinned task', taskId: 'pinned-read', expanded: false, projectIds: [] },
  ])(
    'restores the new account preferences before revealing its selected $group task',
    ({ taskId, expanded, projectIds }) => {
      const storedPreferences = {
        projectsExpanded: 'false',
        chatsExpanded: 'false',
        priorityShowPinned: 'true',
        showOfflineDeviceItems: 'false',
        expandedProjectIds: '[]',
      }
      const storageKey = (key: string, userId: number) => `wework.desktop.sidebar.${key}.${userId}`
      for (const [key, value] of Object.entries(storedPreferences)) {
        localStorage.setItem(storageKey(key, 2), value)
      }
      const view = renderSidebar({ currentRuntimeTask: { deviceId: 'local-device', taskId } })
      const previousPreferences = Object.keys(storedPreferences).map(key => ({
        key: storageKey(key, 1),
        value: localStorage.getItem(storageKey(key, 1)),
      }))
      const setItem = vi.spyOn(Storage.prototype, 'setItem')
      try {
        view.rerenderProps({
          user: { id: 2, user_name: 'bob', email: 'bob@example.com' },
        })

        expect(screen.getByTestId('projects-section-toggle')).toHaveAttribute(
          'aria-expanded',
          String(expanded)
        )
        expect(screen.getByTestId(rowId(taskId))).toBeInTheDocument()
        const expectedPreferences = {
          ...storedPreferences,
          projectsExpanded: String(expanded),
          expandedProjectIds: JSON.stringify(projectIds),
        }
        for (const [key, value] of Object.entries(expectedPreferences)) {
          expect(localStorage.getItem(storageKey(key, 2))).toBe(value)
        }
        for (const { key, value } of previousPreferences) {
          expect(localStorage.getItem(key)).toBe(value)
        }
        const sidebarWrites = setItem.mock.calls.filter(([key]) =>
          key.startsWith('wework.desktop.sidebar.')
        )
        const expectedWrites = Object.entries(expectedPreferences).map(([key, value]) => [
          storageKey(key, 2),
          value,
        ])
        expect(sidebarWrites).toEqual(expect.arrayContaining(expectedWrites))
        for (const write of sidebarWrites) {
          expect(expectedWrites).toContainEqual(write)
        }
      } finally {
        setItem.mockRestore()
      }
    }
  )

  test('does not preserve a different device conversation with the same task ID', async () => {
    const work = runtimeWork()
    work.chats.push({
      ...work.chats[0],
      deviceId: 'remote-device',
      tasks: [task('chat-read', { title: 'Remote read duplicate' })],
    })
    renderSidebar({
      runtimeWork: work,
      unreadRuntimeTaskKeys: new Set(),
      currentRuntimeTask: { deviceId: 'local-device', taskId: 'chat-read' },
    })
    expect(screen.getAllByTestId(rowId('chat-read'))).toHaveLength(2)

    await selectAction('collapse-read')

    expect(screen.getAllByTestId(rowId('chat-read'))).toHaveLength(1)
    expect(screen.queryByText('Remote read duplicate')).not.toBeInTheDocument()
  })

  test.each(['pinned', 'project', 'chat'] as const)(
    'keeps read running, queued, and waiting conversations visible in the %s group',
    async group => {
      const work = runtimeWork()
      const protectedTasks = [
        task('protected-running', { running: true }),
        task('protected-queued', { running: false, status: 'queued' }),
        task('protected-input', { interactionStatus: 'waitingForUserInput' }),
        task('protected-async-input', {
          running: false,
          status: 'done',
          interactionStatus: 'awaitingUserReply',
        }),
        task('protected-approval', { status: 'waiting_for_approval' }),
      ].map(task => ({ ...task, pinned: group === 'pinned' }))
      if (group === 'chat') {
        work.chats[0].tasks.push(...protectedTasks)
      } else {
        work.projects[1].deviceWorkspaces![0].tasks.push(...protectedTasks)
      }
      renderSidebar({ runtimeWork: work, unreadRuntimeTaskKeys: new Set() })
      if (group === 'project') {
        await userEvent.click(
          within(screen.getByTestId('project-row-8')).getByTestId('project-item-button')
        )
      }

      await selectAction('collapse-read')

      const section = screen.getByTestId(
        group === 'pinned'
          ? 'sidebar-pinned-section'
          : group === 'project'
            ? 'project-local-tasks-panel-8'
            : 'desktop-sidebar'
      )
      for (const task of protectedTasks) {
        expect(within(section).getByTestId(rowId(task.taskId))).toBeInTheDocument()
      }
      expect(screen.queryByTestId(rowId('project-read'))).not.toBeInTheDocument()
      expect(screen.queryByTestId(rowId('chat-read'))).not.toBeInTheDocument()
    }
  )

  test.each(['queued'] as const)(
    'restores a hidden conversation when it becomes %s and retains it until the next collapse',
    async state => {
      const { store } = renderSidebar()
      const address = { deviceId: 'local-device', taskId: 'chat-read' }
      await selectAction('collapse-read')
      expect(screen.queryByTestId(rowId('chat-read'))).not.toBeInTheDocument()

      act(() => {
        if (state === 'running') store.turnStarted(address, 'new-turn')
        else if (state === 'queued') store.sendQueued(address)
        else store.userInputRequested(address, state === 'async-input' ? 'async' : undefined)
      })
      expect(screen.getByTestId(rowId('chat-read'))).toBeInTheDocument()
      await userEvent.click(screen.getByTestId('runtime-priority-filter-button'))
      expect(screen.getByTestId(rowId('chat-read'))).toBeInTheDocument()

      act(() => {
        store.userInputResponded(address)
        store.executorSettled(address)
        store.turnSettled(address, 'new-turn', 'succeeded')
      })
      expect(screen.getByTestId(rowId('chat-read'))).toBeInTheDocument()
      await userEvent.click(screen.getByTestId('runtime-priority-filter-button'))
      expect(screen.queryByTestId(rowId('chat-read'))).not.toBeInTheDocument()
    }
  )

  test('uses Shift Option Command R from the composer and respects editable, repeat, and composition guards', () => {
    renderSidebar()
    for (const event of [
      { key: 'r', metaKey: true },
      { key: 'r', metaKey: true, altKey: true },
      { key: 'r', metaKey: true, altKey: true, shiftKey: true, repeat: true },
      { key: 'r', metaKey: true, altKey: true, shiftKey: true, isComposing: true },
    ])
      fireEvent.keyDown(window, event)
    expect(screen.getByTestId(rowId('chat-read'))).toBeInTheDocument()
    const input = document.createElement('input')
    document.body.appendChild(input)
    try {
      fireEvent.keyDown(input, { key: 'r', metaKey: true, altKey: true, shiftKey: true })
      expect(screen.getByTestId(rowId('chat-read'))).toBeInTheDocument()
      input.dataset.testid = 'chat-message-input'
      fireEvent.keyDown(input, {
        key: '‰',
        code: 'KeyR',
        metaKey: true,
        altKey: true,
        shiftKey: true,
      })
      expect(screen.queryByTestId(rowId('chat-read'))).not.toBeInTheDocument()
    } finally {
      input.remove()
    }
  })
})
