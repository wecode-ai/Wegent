import type { HttpClient } from './http'

/** The structured detail a notification carries about what it points at. */
export interface WeworkNotificationPayload {
  projectId?: string
  projectName?: string
  itemId?: string
  itemKey?: string
  itemTitle?: string
  itemStatus?: string
  itemPriority?: string
  itemDueAt?: string
  actorName?: string
  commentId?: string
  commentPreview?: string
  replyPreview?: string
  status?: string
  executionId?: string
}

export interface WeworkNotification {
  id: string
  kind: string
  title: string
  body: string
  url: string | null
  payload: WeworkNotificationPayload
  created_at: string
  read_at: string | null
}

export interface WeworkInbox {
  items: WeworkNotification[]
  unread_count: number
  next_offset: number | null
}

export type WeworkNotificationCategory = 'collaboration' | 'general'

export function createNotificationsApi(client: HttpClient) {
  const path = '/v1/wework-notifications'
  return {
    list: (offset = 0, category?: WeworkNotificationCategory): Promise<WeworkInbox> =>
      client.get(
        `${path}?offset=${offset}${category ? `&category=${encodeURIComponent(category)}` : ''}`
      ),
    read: (id: string): Promise<WeworkNotification> =>
      client.post(`${path}/${encodeURIComponent(id)}/read`, {}),
    readAll: (): Promise<void> => client.post(`${path}/read-all`, {}),
  }
}
