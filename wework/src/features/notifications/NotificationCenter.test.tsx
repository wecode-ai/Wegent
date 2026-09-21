import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CloudConnectionContext,
  type CloudConnectionContextValue,
} from '@/features/cloud-connection/CloudConnectionContext'
import { NotificationCenter } from './NotificationCenter'

const api = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), readAll: vi.fn() }))
vi.mock('@/api/notifications', () => ({ createNotificationsApi: () => api }))
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

beforeEach(() => {
  vi.clearAllMocks()
  api.list.mockResolvedValue({ items: [entry], unread_count: 1, next_offset: null })
  api.read.mockResolvedValue({ ...entry, read_at: '2026-09-07T01:00:00+00:00' })
  api.readAll.mockResolvedValue(undefined)
})

describe('notification center', () => {
  it('marks a general notification read while keeping its content open without navigation', async () => {
    const general = { ...entry, url: null, body: '你好' }
    api.list.mockResolvedValue({ items: [general], unread_count: 1, next_offset: null })
    api.read.mockResolvedValue({ ...general, read_at: '2026-09-08T01:00:00+00:00' })
    const open = vi.fn()
    window.addEventListener('wework-open-scheme', open)
    render(view())
    await screen.findByTestId('wework-notifications-unread')
    fireEvent.click(screen.getByTestId('wework-notifications-button'))
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
    fireEvent.click(await screen.findByTestId('wework-notification-n1'))
    expect(await screen.findByRole('alert')).toHaveTextContent('offline')
    expect(screen.getByTestId('wework-notification-n1')).toBeVisible()
  })

  it('refreshes on a live event and clears inbox content when the account changes', async () => {
    const rendered = render(view())
    await screen.findByTestId('wework-notifications-unread')
    await act(async () => window.dispatchEvent(new Event('wework-notifications-changed')))
    expect(api.list).toHaveBeenCalledTimes(2)
    api.list.mockResolvedValue({ items: [], unread_count: 0, next_offset: null })
    rendered.rerender(view({ ...connection, user: { ...connection.user!, id: 2 } }))
    fireEvent.click(screen.getByTestId('wework-notifications-button'))
    expect(await screen.findByText('notifications.empty')).toBeVisible()
    expect(screen.queryByText(entry.title)).not.toBeInTheDocument()
  })

  it('exposes the entry while disconnected without requesting a private inbox', () => {
    render(<NotificationCenter />)
    expect(screen.getByTestId('wework-notifications-button')).toBeDisabled()
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
    const summary = await screen.findByTestId('wework-notification-summary-n1')
    expect(summary).toHaveTextContent('test-pro')
    expect(summary).toHaveTextContent('WEG-12')
    expect(summary).toHaveTextContent('进行中')
    expect(summary).toHaveTextContent('todo.priority')
    expect(screen.getByText('notifications.in_reply_to')).toBeVisible()
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
    const row = await screen.findByTestId('wework-notification-n1')
    expect(row).toHaveTextContent('admin 把「修复登录」分配给了你')
    expect(screen.getByTestId('wework-notification-summary-n1')).toHaveTextContent('test-pro')
    expect(screen.queryByTestId('wework-notification-body-n1')).toBeNull()
  })
})
