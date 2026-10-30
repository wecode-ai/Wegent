import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { DesktopSidebar } from './DesktopSidebar'
import { useRightWorkspaceShortcuts } from './workspace-panels/useRightWorkspaceShortcuts'
import {
  RuntimeTaskLifecycleProvider,
  RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import { COLLAPSE_READ_CONVERSATIONS_COMMAND, setActiveKeybindings } from '@/lib/keybindings'
import { preloadDefaultDshUiTestModules } from '@/test/setup'
import type { RuntimeTaskSummary, RuntimeWorkListResponse } from '@/types/api'

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

  test('collapses read rows in the original groups and restores them without mutating tasks', async () => {
    const onMarkRuntimeTaskRead = vi.fn()
    const onArchiveRuntimeTask = vi.fn()
    renderSidebar({ onMarkRuntimeTaskRead, onArchiveRuntimeTask })
    await userEvent.click(
      within(screen.getByTestId('project-row-7')).getByTestId('project-item-button')
    )
    await userEvent.click(
      within(screen.getByTestId('project-row-8')).getByTestId('project-item-button')
    )

    await selectAction('collapse-read')

    expect(screen.getByTestId('runtime-priority-filter-button')).toHaveAccessibleName(
      '收起已读会话'
    )
    expect(screen.getByTestId('runtime-priority-filter-button')).not.toHaveAttribute('aria-pressed')
    expect(screen.queryByTestId('runtime-priority-section')).not.toBeInTheDocument()
    expect(screen.getByTestId('project-row-7')).toBeInTheDocument()
    expect(screen.getByTestId('project-row-8')).toBeInTheDocument()
    expect(
      within(screen.getByTestId('sidebar-pinned-section')).getByTestId(rowId('pinned-unread'))
    ).toBeInTheDocument()
    expect(
      within(screen.getByTestId('project-local-tasks-panel-7')).getByTestId(rowId('project-unread'))
    ).toBeInTheDocument()
    expect(screen.getByTestId(rowId('chat-unread'))).toBeInTheDocument()
    for (const id of ['pinned-read', 'project-read', 'chat-read']) {
      expect(screen.queryByTestId(rowId(id))).not.toBeInTheDocument()
    }
    expect(screen.getByTestId(rowId('running-read'))).toBeInTheDocument()
    expect(screen.getByTestId(rowId('waiting-read'))).toBeInTheDocument()
    expect(onMarkRuntimeTaskRead).not.toHaveBeenCalled()
    expect(onArchiveRuntimeTask).not.toHaveBeenCalled()

    await selectAction('expand-read')

    for (const id of ['pinned-read', 'project-read', 'chat-read', 'running-read', 'waiting-read']) {
      expect(screen.getByTestId(rowId(id))).toBeInTheDocument()
    }
  })

  test('keeps newly read rows until the next click and permanently restores new unread rows', async () => {
    const onOpenRuntimeTask = vi.fn()
    const onMarkRuntimeTaskRead = vi.fn()
    const work = runtimeWork()
    work.chats[0].tasks = work.chats[0].tasks.filter(
      task => !['running-read', 'waiting-read'].includes(task.taskId)
    )
    const view = renderSidebar({ onOpenRuntimeTask, onMarkRuntimeTaskRead, runtimeWork: work })
    await selectAction('collapse-read')
    await userEvent.click(screen.getByTestId(rowId('chat-unread')))
    expect(onOpenRuntimeTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'chat-unread' })
    )
    expect(onMarkRuntimeTaskRead).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'chat-unread' })
    )

    view.rerenderProps({
      unreadRuntimeTaskKeys: new Set(),
      currentRuntimeTask: { deviceId: 'local-device', taskId: 'chat-unread' },
    })
    expect(screen.getByTestId(rowId('chat-unread'))).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('runtime-priority-filter-button'))
    expect(screen.getByTestId(rowId('chat-unread'))).toBeInTheDocument()
    view.rerenderProps({ currentRuntimeTask: null })
    expect(screen.getByTestId(rowId('chat-unread'))).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('runtime-priority-filter-button'))
    expect(screen.queryByTestId(rowId('chat-unread'))).not.toBeInTheDocument()
    expect(screen.getByTestId('runtime-chat-section-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-chat-empty')).toHaveTextContent('已读会话已收起')

    view.rerenderProps({ unreadRuntimeTaskKeys: new Set(['local-device\0chat-unread']) })
    expect(screen.getByTestId(rowId('chat-unread'))).toBeInTheDocument()
    view.rerenderProps({ unreadRuntimeTaskKeys: new Set() })
    expect(screen.getByTestId(rowId('chat-unread'))).toBeInTheDocument()
  })

  test.each(['pinned-read', 'project-read', 'chat-read'])(
    'keeps the current read conversation %s visible through every collapse entry',
    async taskId => {
      renderSidebar({
        unreadRuntimeTaskKeys: new Set(),
        currentRuntimeTask: { deviceId: 'local-device', taskId },
      })
      if (taskId === 'project-read') {
        await userEvent.click(
          within(screen.getByTestId('project-row-8')).getByTestId('project-item-button')
        )
      }

      await selectAction('collapse-read')
      expect(screen.getByTestId(rowId(taskId))).toBeInTheDocument()
      await userEvent.click(screen.getByTestId('runtime-priority-filter-button'))
      expect(screen.getByTestId(rowId(taskId))).toBeInTheDocument()
      fireEvent.keyDown(window, {
        key: '‰',
        code: 'KeyR',
        metaKey: true,
        altKey: true,
        shiftKey: true,
      })
      expect(screen.getByTestId(rowId(taskId))).toBeInTheDocument()
      for (const otherId of ['pinned-read', 'project-read', 'chat-read']) {
        if (otherId !== taskId) expect(screen.queryByTestId(rowId(otherId))).not.toBeInTheDocument()
      }
    }
  )

  test('restores a hidden read conversation when navigation selects it', async () => {
    const view = renderSidebar()
    await selectAction('collapse-read')
    expect(screen.queryByTestId(rowId('chat-read'))).not.toBeInTheDocument()

    view.rerenderProps({ currentRuntimeTask: { deviceId: 'local-device', taskId: 'chat-read' } })
    expect(screen.getByTestId(rowId('chat-read'))).toBeInTheDocument()
    view.rerenderProps({ currentRuntimeTask: null })
    expect(screen.getByTestId(rowId('chat-read'))).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('runtime-priority-filter-button'))
    expect(screen.queryByTestId(rowId('chat-read'))).not.toBeInTheDocument()
  })

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

  test.each([false, true])(
    'restores only the clicked project when its panel was initially expanded: %s',
    async initiallyExpanded => {
      renderSidebar()
      const projectButton = within(screen.getByTestId('project-row-8')).getByTestId(
        'project-item-button'
      )
      if (initiallyExpanded) await userEvent.click(projectButton)
      await selectAction('collapse-read')

      await userEvent.click(projectButton)

      expect(projectButton).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByTestId('project-local-tasks-panel-8')).toHaveAttribute(
        'aria-hidden',
        'false'
      )
      expect(screen.getByTestId(rowId('project-read'))).toBeInTheDocument()
      expect(screen.queryByTestId(rowId('pinned-read'))).not.toBeInTheDocument()
      expect(screen.queryByTestId(rowId('chat-read'))).not.toBeInTheDocument()

      await userEvent.click(projectButton)
      expect(projectButton).toHaveAttribute('aria-expanded', 'false')
      await userEvent.click(screen.getByTestId('runtime-priority-filter-button'))
      expect(screen.queryByTestId(rowId('project-read'))).not.toBeInTheDocument()
    }
  )

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

  test.each(['running', 'queued', 'input', 'async-input'] as const)(
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

  test('uses current lifecycle state when the task list still reports an old running state', async () => {
    const { store } = renderSidebar()
    const address = { deviceId: 'local-device', taskId: 'running-read' }
    act(() => {
      store.executorSettled(address)
      store.turnSettled(address, null, 'succeeded')
    })

    await selectAction('collapse-read')

    expect(screen.queryByTestId(rowId('running-read'))).not.toBeInTheDocument()
    expect(screen.getByTestId(rowId('waiting-read'))).toBeInTheDocument()
  })

  test.each([false, true])(
    'restores standalone tasks from their heading when initially expanded: %s',
    async initiallyExpanded => {
      renderSidebar({ unreadRuntimeTaskKeys: new Set(['local-device\0project-unread']) })
      const taskHeading = screen.getByTestId('runtime-chat-section-toggle')
      if (!initiallyExpanded) await userEvent.click(taskHeading)
      await selectAction('collapse-read')

      await userEvent.click(taskHeading)

      expect(taskHeading).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByTestId(rowId('chat-read'))).toBeInTheDocument()
      expect(screen.getByTestId(rowId('waiting-read'))).toBeInTheDocument()
      expect(screen.getByTestId(rowId('pinned-unread'))).toBeInTheDocument()
      expect(screen.queryByTestId(rowId('project-read'))).not.toBeInTheDocument()
      expect(screen.queryByTestId(rowId('pinned-read'))).not.toBeInTheDocument()

      await userEvent.click(taskHeading)
      expect(taskHeading).toHaveAttribute('aria-expanded', 'false')
      await userEvent.click(taskHeading)
      expect(screen.getByTestId(rowId('chat-read'))).toBeInTheDocument()
      await userEvent.click(screen.getByTestId('runtime-priority-filter-button'))
      expect(screen.queryByTestId(rowId('chat-read'))).not.toBeInTheDocument()
    }
  )

  test('retains the pinned heading when every pinned conversation is collapsed', async () => {
    renderSidebar({
      unreadRuntimeTaskKeys: new Set(),
      runtimeWork: {
        projects: [],
        totalTasks: 1,
        chats: [
          {
            deviceId: 'local-device',
            available: true,
            workspacePath: '/chats',
            workspaceKind: 'chat',
            tasks: [task('only-pinned', { pinned: true })],
          },
        ],
      },
    })
    await selectAction('collapse-read')

    expect(screen.getByTestId('sidebar-pinned-section-header')).toHaveTextContent('置顶')
    expect(screen.queryByTestId(rowId('only-pinned'))).not.toBeInTheDocument()
    expect(screen.getByTestId('projects-section-toggle')).toBeInTheDocument()
    expect(screen.getByTestId('runtime-chat-section-toggle')).toBeInTheDocument()
  })

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

  test('honors customized and disabled shortcuts', () => {
    setActiveKeybindings([{ command: COLLAPSE_READ_CONVERSATIONS_COMMAND, key: 'Command+Shift+H' }])
    renderSidebar()
    fireEvent.keyDown(window, { key: 'r', metaKey: true, altKey: true, shiftKey: true })
    expect(screen.getByTestId(rowId('chat-read'))).toBeInTheDocument()
    act(() => setActiveKeybindings([{ command: COLLAPSE_READ_CONVERSATIONS_COMMAND, key: null }]))
    fireEvent.keyDown(window, { key: 'h', metaKey: true, shiftKey: true })
    expect(screen.getByTestId(rowId('chat-read'))).toBeInTheDocument()
    act(() =>
      setActiveKeybindings([
        { command: COLLAPSE_READ_CONVERSATIONS_COMMAND, key: 'Command+Shift+H' },
      ])
    )
    fireEvent.keyDown(window, { key: 'h', metaKey: true, shiftKey: true })
    expect(screen.queryByTestId(rowId('chat-read'))).not.toBeInTheDocument()
  })

  test('collapses read conversations when review shortcuts are also mounted', () => {
    const onSelectReview = vi.fn()
    renderHook(() =>
      useRightWorkspaceShortcuts({
        active: true,
        canOpenReview: true,
        allowTemporaryChat: true,
        canBrowseFiles: true,
        onNavigate: action => action(),
        onSelectReview,
        onSelectBrowser: vi.fn(),
        onSelectChat: vi.fn(),
        onSelectFiles: vi.fn(),
      })
    )
    renderSidebar()

    fireEvent.keyDown(window, {
      key: '‰',
      code: 'KeyR',
      metaKey: true,
      altKey: true,
      shiftKey: true,
    })
    expect(screen.queryByTestId(rowId('chat-read'))).not.toBeInTheDocument()
    expect(onSelectReview).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: '®', code: 'KeyR', metaKey: true, altKey: true })
    expect(onSelectReview).toHaveBeenCalledOnce()
  })

  test('returns from the board or priority view to the grouped sidebar', async () => {
    const onToggleMyWork = vi.fn()
    const view = renderSidebar({ onToggleMyWork, taskView: 'default-work-items' })
    fireEvent.keyDown(window, { key: 'r', metaKey: true, altKey: true, shiftKey: true })
    expect(onToggleMyWork).toHaveBeenCalledOnce()
    expect(screen.getByTestId('projects-section-toggle')).toBeInTheDocument()
    view.rerenderProps({ taskView: 'workbench' })
    await selectAction('priority')
    expect(screen.getByTestId('runtime-priority-section')).toBeInTheDocument()
    expect(screen.getByTestId(rowId('waiting-read'))).toBeInTheDocument()
    await selectAction('collapse-read')
    expect(screen.queryByTestId('runtime-priority-section')).not.toBeInTheDocument()
    expect(screen.getByTestId('projects-section-toggle')).toBeInTheDocument()
    expect(screen.getByTestId(rowId('waiting-read'))).toBeInTheDocument()
    expect(screen.getByTestId(rowId('running-read'))).toBeInTheDocument()
    expect(screen.queryByTestId(rowId('chat-read'))).not.toBeInTheDocument()
  })

  test('clears collapsed rows when the account changes', async () => {
    const view = renderSidebar()
    await selectAction('collapse-read')
    expect(screen.queryByTestId(rowId('chat-read'))).not.toBeInTheDocument()
    view.rerenderProps({ user: { id: 2, user_name: 'bob', email: 'bob@example.com' } })
    expect(screen.getByTestId(rowId('chat-read'))).toBeInTheDocument()
  })
})
