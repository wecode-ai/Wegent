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

const api = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), readAll: vi.fn() }))
const navigation = vi.hoisted(() => ({ navigateTo: vi.fn() }))
const taskState = vi.hoisted(() => ({ reminders: null as unknown }))
vi.mock('@/api/notifications', () => ({ createNotificationsApi: () => api }))
vi.mock('@/desktop/trayNavigation', () => ({ syncNotificationUnreadCount: vi.fn() }))
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
const viewWithTask = (value = connection) => (
  <NotificationTaskSourceProvider>
    <NotificationTaskSourceBridge id="task-tab" active />
    {view(value)}
  </NotificationTaskSourceProvider>
)

beforeEach(() => {
  vi.clearAllMocks()
  api.list.mockImplementation((_offset, category) =>
    Promise.resolve(
      category === 'general'
        ? { items: [entry], unread_count: 1, next_offset: null }
        : { items: [], unread_count: 0, next_offset: null }
    )
  )
  api.read.mockResolvedValue({ ...entry, read_at: '2026-09-07T01:00:00+00:00' })
  api.readAll.mockResolvedValue(undefined)
  taskState.reminders = {
    items: [task],
    unreadTaskKeys: new Set([task.key]),
    markRuntimeTaskRead,
  }
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
    const review = { ...entry, id: 'review-1', kind: 'human_work', title: 'Review' }
    api.list.mockImplementation((offset, category) =>
      Promise.resolve(
        category === 'collaboration'
          ? offset === 0
            ? { items: [assignment], unread_count: 2, next_offset: 1 }
            : { items: [review], unread_count: 2, next_offset: null }
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
    expect(await screen.findByTestId('wework-notification-review-1')).toBeVisible()
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
})
