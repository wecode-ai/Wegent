import { expect, test, vi } from 'vitest'
import { createNotificationCenterFeed } from './notificationCenterFeed'

test('refresh leaves the idle notification snapshot unchanged until the inbox changes', async () => {
  let unreadCount = 0
  const api = {
    list: vi.fn(async () => ({ items: [], unread_count: unreadCount, next_offset: null })),
    read: vi.fn(),
    readAll: vi.fn(),
    getPreferences: vi.fn(),
    updatePreferences: vi.fn(),
  }
  const feed = createNotificationCenterFeed('notification-refresh')
  const listener = vi.fn()
  const unsubscribe = feed.subscribe(listener, { api, runtimeApi: null, paused: false })
  try {
    await feed.refresh()
    const previous = feed.getSnapshot()
    listener.mockClear()

    await feed.refresh()
    expect(feed.getSnapshot()).toBe(previous)
    expect(listener).not.toHaveBeenCalled()

    unreadCount = 1
    await feed.refresh()
    expect(feed.getSnapshot().inboxes.general?.unread_count).toBe(1)
    expect(listener).toHaveBeenCalled()
  } finally {
    unsubscribe()
  }
})
