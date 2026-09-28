import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CloudConnectionContext,
  type CloudConnectionContextValue,
} from '@/features/cloud-connection/CloudConnectionContext'
import { NotificationCenter } from './NotificationCenter'
import {
  NotificationTaskSourceBridge,
  NotificationTaskSourceProvider,
} from './NotificationTaskSource'
import { useIssueDispatchNotificationActionRegistration } from './useIssueDispatchNotificationActionRegistration'
import { readActiveNotificationPreferences } from './notificationPreferences'

const api = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  readAll: vi.fn(),
  getPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}))
const navigation = vi.hoisted(() => ({ navigateTo: vi.fn() }))
const runtimeApi = vi.hoisted(() => ({
  getImNotificationSettings: vi.fn(),
  updateGlobalImNotification: vi.fn(),
}))
const desktopHost = vi.hoisted(() => ({ invoke: vi.fn() }))
const environment = vi.hoisted(() => ({ electron: false }))
const taskState = vi.hoisted(() => ({ reminders: null as unknown }))
vi.mock('@/api/notifications', () => ({ createNotificationsApi: () => api }))
vi.mock('@/api/runtimeWork', () => ({ createRuntimeWorkApi: () => runtimeApi }))
vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: desktopHost.invoke }))
vi.mock('@/desktop/trayNavigation', () => ({ syncNotificationUnreadCount: vi.fn() }))
vi.mock('@/lib/runtime-environment', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/runtime-environment')>()),
  getDesktopWindowLabel: () => 'main',
  isElectronRuntime: () => environment.electron,
}))
vi.mock('@/lib/navigation', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/navigation')>()),
  navigateTo: navigation.navigateTo,
}))
vi.mock('@/features/workbench/useWorkbench', () => ({
  useWorkbench: () => ({ runtimeTaskReminders: taskState.reminders }),
}))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const entry = {
  id: 'n1',
  kind: 'message',
  title: 'Review failed',
  body: 'Please review',
  url: 'wework://boards/12/issues/ISSUE-1',
  payload: {},
  created_at: '2026-09-07T00:00:00+00:00',
  read_at: null,
}
const connection = {
  token: 'test-token',
  apiBaseUrl: 'http://backend/api',
  user: { id: 1 },
} as CloudConnectionContextValue
const view = (value = connection) => (
  <CloudConnectionContext.Provider value={value}>
    <NotificationCenter />
  </CloudConnectionContext.Provider>
)
const task = {
  key: 'device-1\0task-1',
  address: { deviceId: 'device-1', taskId: 'task-1' },
  task: {
    taskId: 'task-1',
    workspacePath: '/project',
    title: 'Finished review',
    runtime: 'codex',
    completedAt: '2026-09-08T00:00:00Z',
  },
  workspace: { deviceId: 'device-1', available: true, workspacePath: '/project', tasks: [] },
  projectName: 'Project',
}
const markRuntimeTaskRead = vi.fn()
const issueDispatchNotificationAction = vi.fn()

function IssueDispatchNotificationActionBridge() {
  useIssueDispatchNotificationActionRegistration(
    'issue-dispatch-test',
    true,
    issueDispatchNotificationAction
  )
  return null
}

const viewWithTask = (value = connection) => (
  <NotificationTaskSourceProvider>
    <NotificationTaskSourceBridge id="task-tab" active />
    {view(value)}
  </NotificationTaskSourceProvider>
)
const viewWithIssueDispatchAction = (value = connection) => (
  <NotificationTaskSourceProvider>
    <IssueDispatchNotificationActionBridge />
    {view(value)}
  </NotificationTaskSourceProvider>
)

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  environment.electron = false
  desktopHost.invoke.mockResolvedValue({
    taskCompletionNotificationsEnabled: false,
  })
  api.list.mockImplementation((_offset, category) =>
    Promise.resolve(
      category === 'general'
        ? { items: [entry], unread_count: 1, next_offset: null }
        : { items: [], unread_count: 0, next_offset: null }
    )
  )
  api.read.mockResolvedValue({ ...entry, read_at: '2026-09-07T01:00:00+00:00' })
  api.readAll.mockResolvedValue(undefined)
  api.getPreferences.mockResolvedValue({
    tasks: { in_app: true, system: false, im: null },
    collaboration: { in_app: true, system: true, im: true },
    general: { in_app: true, system: null, im: true },
  })
  api.updatePreferences.mockImplementation(({ category, channel, enabled }) =>
    Promise.resolve({
      tasks: {
        in_app: category === 'tasks' && channel === 'in_app' ? enabled : true,
        system: category === 'tasks' && channel === 'system' ? enabled : false,
        im: null,
      },
      collaboration: {
        in_app: category === 'collaboration' && channel === 'in_app' ? enabled : true,
        system: category === 'collaboration' && channel === 'system' ? enabled : true,
        im: category === 'collaboration' && channel === 'im' ? enabled : true,
      },
      general: {
        in_app: category === 'general' && channel === 'in_app' ? enabled : true,
        system: null,
        im: category === 'general' && channel === 'im' ? enabled : true,
      },
    })
  )
  runtimeApi.getImNotificationSettings.mockResolvedValue({
    global: { enabled: false, sessionKey: 'session-1' },
    runtimeTaskSubscriptions: [],
  })
  runtimeApi.updateGlobalImNotification.mockImplementation(({ enabled, sessionKey }) =>
    Promise.resolve({
      global: { enabled, sessionKey },
      runtimeTaskSubscriptions: [],
    })
  )
  taskState.reminders = {
    items: [task],
    unreadTaskKeys: new Set([task.key]),
    markRuntimeTaskRead,
  }
  issueDispatchNotificationAction.mockResolvedValue(undefined)
})

describe('notification center', () => {
  it('marks a general notification read while keeping its content open without navigation', async () => {
    const general = { ...entry, url: null, body: '你好' }
    api.list.mockImplementation((_offset, category) =>
      Promise.resolve(
        category === 'general'
          ? { items: [general], unread_count: 1, next_offset: null }
          : { items: [], unread_count: 0, next_offset: null }
      )
    )
    api.read.mockResolvedValue({ ...general, read_at: '2026-09-08T01:00:00+00:00' })
    const open = vi.fn()
    window.addEventListener('wework-open-scheme', open)
    render(view())
    await screen.findByTestId('wework-notifications-unread')
    fireEvent.click(screen.getByTestId('wework-notifications-button'))
    expect(screen.queryByTestId('wework-notification-n1')).toBeNull()
    fireEvent.click(screen.getByTestId('wework-notifications-category-general'))
    fireEvent.click(await screen.findByTestId('wework-notification-n1'))
    await waitFor(() => expect(screen.queryByTestId('wework-notifications-unread')).toBeNull())
    expect(api.read).toHaveBeenCalledWith('n1')
    expect(screen.getByText('你好')).toBeVisible()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(open).not.toHaveBeenCalled()
    window.removeEventListener('wework-open-scheme', open)
  })

  it.each([entry.url, 'wework://boards'])(
    'opens the saved scheme after marking it read: %s',
    async url => {
      api.read.mockResolvedValue({ ...entry, url, read_at: '2026-09-08T01:00:00+00:00' })
      const open = vi.fn()
      window.addEventListener('wework-open-scheme', open)
      render(view())
      await screen.findByTestId('wework-notifications-unread')
      fireEvent.click(screen.getByTestId('wework-notifications-button'))
      fireEvent.click(screen.getByTestId('wework-notifications-category-general'))
      fireEvent.click(await screen.findByTestId('wework-notification-n1'))
      await waitFor(() => expect(api.read).toHaveBeenCalledWith('n1'))
      await waitFor(() => expect(open).toHaveBeenCalledOnce())
      expect(open.mock.calls[0][0].detail).toBe(url)
      window.removeEventListener('wework-open-scheme', open)
    }
  )

  it('retains the notification and reports a failed read instead of navigating', async () => {
    api.read.mockRejectedValue(new Error('offline'))
    render(view())
    fireEvent.click(screen.getByTestId('wework-notifications-button'))
    fireEvent.click(screen.getByTestId('wework-notifications-category-general'))
    fireEvent.click(await screen.findByTestId('wework-notification-n1'))
    expect(await screen.findByRole('alert')).toHaveTextContent('offline')
    expect(screen.getByTestId('wework-notification-n1')).toBeVisible()
  })

  it('refreshes on a live event and clears inbox content when the account changes', async () => {
    const rendered = render(view())
    await screen.findByTestId('wework-notifications-unread')
    await act(async () => window.dispatchEvent(new Event('wework-notifications-changed')))
    expect(api.list).toHaveBeenCalledTimes(4)
    api.list.mockResolvedValue({ items: [], unread_count: 0, next_offset: null })
    rendered.rerender(view({ ...connection, user: { ...connection.user!, id: 2 } }))
    fireEvent.click(screen.getByTestId('wework-notifications-button'))
    fireEvent.click(screen.getByTestId('wework-notifications-category-general'))
    expect(await screen.findByText('notifications.empty_category')).toBeVisible()
    expect(screen.queryByText(entry.title)).not.toBeInTheDocument()
  })

  it('keeps the local notification feed available while disconnected', async () => {
    render(viewWithTask({ ...connection, token: null, apiBaseUrl: null }))
    expect(await screen.findByTestId('wework-notifications-unread')).toHaveTextContent('1')
    fireEvent.click(screen.getByTestId('wework-notifications-button'))
    fireEvent.click(screen.getByTestId('wework-notifications-category-tasks'))
    fireEvent.click(screen.getByTestId('wework-notification-task-task-1'))
    expect(markRuntimeTaskRead).toHaveBeenCalledWith(task.address)
    expect(navigation.navigateTo).toHaveBeenCalledWith(
      '/runtime-tasks?deviceId=device-1&taskId=task-1'
    )
    expect(api.list).not.toHaveBeenCalled()
  })

  it('keeps local task notification settings editable while disconnected', async () => {
    render(viewWithTask({ ...connection, token: null, apiBaseUrl: null }))
    fireEvent.click(screen.getByTestId('wework-notifications-button'))
    fireEvent.click(screen.getByTestId('wework-notifications-settings'))

    expect(screen.getByTestId('wework-notifications-popover')).toHaveClass(
      'electron-titlebar-interactive-region'
    )
    expect(document.body).toHaveAttribute('data-wework-anchor-popover-open')
    const taskSystem = screen.getByTestId('wework-notifications-setting-tasks-system')
    expect(taskSystem).toBeEnabled()
    expect(screen.getByTestId('wework-notifications-setting-collaboration-im')).toBeDisabled()
    fireEvent.click(taskSystem)

    await waitFor(() => expect(readActiveNotificationPreferences().tasks.system).toBe(true))
    expect(taskSystem).toHaveAttribute('aria-checked', 'true')
    expect(api.updatePreferences).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('wework-notifications-button'))
    expect(document.body).not.toHaveAttribute('data-wework-anchor-popover-open')
  })

  it('migrates the legacy task system setting for offline users', async () => {
    environment.electron = true
    desktopHost.invoke.mockResolvedValue({
      taskCompletionNotificationsEnabled: true,
    })

    render(viewWithTask({ ...connection, token: null, apiBaseUrl: null }))

    await waitFor(() => expect(readActiveNotificationPreferences().tasks.system).toBe(true))
    expect(api.updatePreferences).not.toHaveBeenCalled()
  })

  it('counts tasks and cloud records together and marks both sources read', async () => {
    render(viewWithTask())
    expect(await screen.findByTestId('wework-notifications-unread')).toHaveTextContent('2')
    fireEvent.click(screen.getByTestId('wework-notifications-button'))
    expect(screen.getByTestId('wework-notifications-category-tasks')).toBeVisible()
    expect(screen.getByTestId('wework-notifications-category-general')).toBeVisible()
    expect(screen.queryByTestId('wework-notification-task-task-1')).toBeNull()
    expect(screen.queryByTestId('wework-notification-n1')).toBeNull()
    fireEvent.click(screen.getByTestId('wework-notifications-category-tasks'))
    expect(screen.getByTestId('wework-notification-task-task-1')).toBeVisible()
    fireEvent.click(screen.getByTestId('wework-notifications-back'))
    fireEvent.click(screen.getByTestId('wework-notifications-read-all'))
    await waitFor(() => expect(api.readAll).toHaveBeenCalledOnce())
    expect(markRuntimeTaskRead).toHaveBeenCalledWith(task.address)
  })

  it('keeps cloud categories separate and loads the selected category page', async () => {
    const assignment = {
      ...entry,
      id: 'assignment-1',
      kind: 'assignment',
      title: 'Assigned',
      payload: { actorName: 'Alice', projectName: 'Project', itemTitle: 'Issue' },
    }
    const dispatch = {
      ...entry,
      id: 'dispatch-1',
      kind: 'issue_dispatch_assignment',
      title: 'Dispatch',
    }
    api.list.mockImplementation((offset, category) =>
      Promise.resolve(
        category === 'collaboration'
          ? offset === 0
            ? { items: [assignment], unread_count: 2, next_offset: 1 }
            : { items: [dispatch], unread_count: 2, next_offset: null }
          : { items: [entry], unread_count: 1, next_offset: null }
      )
    )

    render(view())
    expect(await screen.findByTestId('wework-notifications-unread')).toHaveTextContent('3')
    fireEvent.click(screen.getByTestId('wework-notifications-button'))
    fireEvent.click(screen.getByTestId('wework-notifications-category-collaboration'))
    expect(screen.getByTestId('wework-notification-assignment-1')).toBeVisible()
    expect(screen.queryByTestId('wework-notification-n1')).toBeNull()
    fireEvent.click(screen.getByTestId('wework-notifications-more'))
    expect(await screen.findByTestId('wework-notification-dispatch-1')).toBeVisible()
    expect(api.list).toHaveBeenCalledWith(1, 'collaboration')
    fireEvent.click(screen.getByTestId('wework-notifications-back'))
    fireEvent.click(screen.getByTestId('wework-notifications-category-general'))
    expect(screen.getByTestId('wework-notification-n1')).toBeVisible()
    expect(screen.queryByTestId('wework-notification-assignment-1')).toBeNull()
  })

  it('does not request a private inbox when there is no cloud connection', () => {
    render(<NotificationCenter />)
    expect(screen.getByTestId('wework-notifications-button')).toBeEnabled()
    expect(api.list).not.toHaveBeenCalled()
  })

  it('renders the board, item key, state and reply context of a notification', async () => {
    const mention = {
      ...entry,
      kind: 'mention',
      title: 'hajimi 在「修复登录」提到了你',
      body: '麻烦看下这个改动',
      payload: {
        projectId: '12',
        projectName: 'test-pro',
        itemId: 'WEG-12',
        itemKey: 'WEG-12',
        itemTitle: '修复登录',
        itemStatus: '进行中',
        itemPriority: 'high',
        actorName: 'hajimi',
        commentId: 'c-1',
        commentPreview: '麻烦看下这个改动',
        replyPreview: '先合了这条',
      },
    }
    api.list.mockResolvedValue({ items: [mention], unread_count: 1, next_offset: null })
    render(view())
    fireEvent.click(screen.getByTestId('wework-notifications-button'))
    fireEvent.click(screen.getByTestId('wework-notifications-category-collaboration'))
    const summary = await screen.findByTestId('wework-notification-n1-summary')
    expect(summary).toHaveTextContent('test-pro')
    expect(summary).toHaveTextContent('WEG-12')
    expect(summary).toHaveTextContent('进行中')
    expect(summary).toHaveTextContent('todo.priority')
    expect(screen.getByTestId('wework-notification-n1-reply')).toBeVisible()
    const row = screen.getByTestId('wework-notification-n1')
    expect(row).toHaveAttribute('data-unread', 'true')
    // The board is part of the summary line, so the body must not repeat it.
    expect(row).not.toHaveTextContent('看板：test-pro')
    expect(row).toHaveTextContent('麻烦看下这个改动')
  })

  it('omits the body of a notification that has no detail of its own', async () => {
    const assignment = {
      ...entry,
      kind: 'assignment',
      title: 'admin 把「修复登录」分配给了你',
      body: '',
      payload: {
        projectId: '12',
        projectName: 'test-pro',
        itemId: 'WEG-12',
        itemTitle: '修复登录',
        actorName: 'admin',
      },
    }
    api.list.mockResolvedValue({ items: [assignment], unread_count: 1, next_offset: null })
    render(view())
    fireEvent.click(screen.getByTestId('wework-notifications-button'))
    fireEvent.click(screen.getByTestId('wework-notifications-category-collaboration'))
    const row = await screen.findByTestId('wework-notification-n1')
    expect(row).toHaveTextContent('admin 把「修复登录」分配给了你')
    expect(screen.getByTestId('wework-notification-n1-summary')).toHaveTextContent('test-pro')
    expect(screen.queryByTestId('wework-notification-n1-body')).toBeNull()
  })

  it('creates or opens the personal task assigned by an Issue dispatch notification', async () => {
    const dispatchNotification = {
      ...entry,
      kind: 'issue_dispatch_assignment',
      title: '新任务：采集 CPU 证据',
      body: '负责人向你分配了协作任务。',
      url: null,
      payload: {
        projectId: '12',
        itemId: 'issue-1',
        issueId: 'issue-1',
        dispatchTaskId: 'human-assignment-1',
        humanAssignmentId: 'human-assignment-1',
        dispatchId: 'dispatch-1',
        roundId: 'round-1',
        assignmentId: 'collect-cpu',
        taskTitle: '采集 CPU 证据',
        instructions: '只读采集 CPU 证据并提交交付。',
        workflowStageId: 'investigate',
        action: 'create_personal_task',
        idempotencyKey: 'human-assignment:human-assignment-1',
      },
    }
    api.list.mockImplementation((_offset, category) =>
      Promise.resolve(
        category === 'collaboration'
          ? { items: [dispatchNotification], unread_count: 1, next_offset: null }
          : { items: [], unread_count: 0, next_offset: null }
      )
    )
    api.read.mockResolvedValue({
      ...dispatchNotification,
      read_at: '2026-09-25T01:00:00+00:00',
    })

    render(viewWithIssueDispatchAction())
    fireEvent.click(screen.getByTestId('wework-notifications-button'))
    fireEvent.click(screen.getByTestId('wework-notifications-category-collaboration'))
    fireEvent.click(await screen.findByTestId('issue-dispatch-notification-create-task'))

    await waitFor(() =>
      expect(issueDispatchNotificationAction).toHaveBeenCalledWith({
        projectId: '12',
        itemId: 'issue-1',
        issueId: 'issue-1',
        dispatchTaskId: 'human-assignment-1',
        humanAssignmentId: 'human-assignment-1',
        dispatchId: 'dispatch-1',
        roundId: 'round-1',
        assignmentId: 'collect-cpu',
        taskTitle: '采集 CPU 证据',
        instructions: '只读采集 CPU 证据并提交交付。',
        workflowStageId: 'investigate',
        idempotencyKey: 'human-assignment:human-assignment-1',
      })
    )
    expect(screen.queryByTestId('wework-notifications-popover')).toBeNull()
  })

  it('updates notification channels from the settings view', async () => {
    render(view())
    fireEvent.click(screen.getByTestId('wework-notifications-button'))
    fireEvent.click(screen.getByTestId('wework-notifications-settings'))
    const taskSystem = await screen.findByTestId('wework-notifications-setting-tasks-system')
    fireEvent.click(taskSystem)
    await waitFor(() =>
      expect(api.updatePreferences).toHaveBeenCalledWith({
        category: 'tasks',
        channel: 'system',
        enabled: true,
      })
    )
  })

  it('does not let a slow preference refresh overwrite a completed toggle', async () => {
    render(view())
    await waitFor(() => expect(api.getPreferences).toHaveBeenCalled())
    api.getPreferences.mockClear()
    runtimeApi.getImNotificationSettings.mockClear()

    let resolveImSettings:
      | ((value: {
          global: { enabled: boolean; sessionKey: string }
          runtimeTaskSubscriptions: never[]
        }) => void)
      | undefined
    runtimeApi.getImNotificationSettings.mockReturnValueOnce(
      new Promise(resolve => {
        resolveImSettings = resolve
      })
    )

    fireEvent.click(screen.getByTestId('wework-notifications-button'))
    fireEvent.click(screen.getByTestId('wework-notifications-settings'))
    await waitFor(() => expect(api.getPreferences).toHaveBeenCalledOnce())
    const taskSystem = screen.getByTestId('wework-notifications-setting-tasks-system')
    fireEvent.click(taskSystem)
    await waitFor(() =>
      expect(api.updatePreferences).toHaveBeenCalledWith({
        category: 'tasks',
        channel: 'system',
        enabled: true,
      })
    )

    await act(async () => {
      resolveImSettings?.({
        global: { enabled: false, sessionKey: 'session-1' },
        runtimeTaskSubscriptions: [],
      })
    })

    expect(taskSystem).toHaveAttribute('aria-checked', 'true')
    expect(readActiveNotificationPreferences().tasks.system).toBe(true)
  })
})
