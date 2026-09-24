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
  action?: string
  idempotencyKey?: string
  issueId?: string
  dispatchTaskId?: string
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
export type WeworkNotificationPreferenceCategory = 'tasks' | WeworkNotificationCategory
export type WeworkNotificationChannel = 'in_app' | 'system' | 'im'

export interface WeworkNotificationChannelPreference {
  in_app: boolean
  system: boolean | null
  im: boolean | null
}

export interface WeworkNotificationPreferences {
  tasks: WeworkNotificationChannelPreference
  collaboration: WeworkNotificationChannelPreference
  general: WeworkNotificationChannelPreference
}

export interface WeworkNotificationPreferenceUpdate {
  category: WeworkNotificationPreferenceCategory
  channel: WeworkNotificationChannel
  enabled: boolean
}

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
    getPreferences: (): Promise<WeworkNotificationPreferences> => client.get(`${path}/preferences`),
    updatePreferences: (
      data: WeworkNotificationPreferenceUpdate
    ): Promise<WeworkNotificationPreferences> => client.put(`${path}/preferences`, data),
  }
}
