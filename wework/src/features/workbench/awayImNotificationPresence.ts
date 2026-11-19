import type {
  RuntimeIMNotificationPresenceResponse,
  RuntimeIMNotificationPresenceUpdateRequest,
} from '@/types/api'
import { isMainWindowFocused, subscribeMainWindowFocus } from '@/desktop/windowFocus'
import { isSystemSessionLocked, subscribeSystemSessionLock } from '@/desktop/systemLock'

const CLIENT_ID_STORAGE_KEY = 'wework:im-notification-presence-client-id'
export const IM_NOTIFICATION_PRESENCE_HEARTBEAT_MS = 30_000

export type PresenceUpdater = (
  data: RuntimeIMNotificationPresenceUpdateRequest
) => Promise<RuntimeIMNotificationPresenceResponse>

function randomClientId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.()
  if (randomUuid) return `wework-${randomUuid}`
  return `wework-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function getImNotificationPresenceClientId(): string {
  try {
    const existing = globalThis.localStorage?.getItem(CLIENT_ID_STORAGE_KEY)?.trim()
    if (existing) return existing
    const created = randomClientId()
    globalThis.localStorage?.setItem(CLIENT_ID_STORAGE_KEY, created)
    return created
  } catch {
    return randomClientId()
  }
}

export function isAwayForImNotifications(
  focused: boolean,
  visibilityState: DocumentVisibilityState,
  systemLocked: boolean
): boolean {
  return systemLocked || !focused || visibilityState !== 'visible'
}

const presencePublications = new Map<string, Promise<void>>()

/** Observe the main window's presence and serialize reports within its authenticated scope. */
export function startAwayImNotificationPresence(
  scopeKey: string,
  updatePresence: PresenceUpdater
): () => void {
  const clientId = getImNotificationPresenceClientId()
  let focused = isMainWindowFocused()
  let systemLocked = isSystemSessionLocked()
  let lastQueuedAway: boolean | null = null
  let active = true

  const enqueue = (force = false) => {
    if (!active) return
    const away = isAwayForImNotifications(focused, document.visibilityState, systemLocked)
    if (!force && away === lastQueuedAway) return
    lastQueuedAway = away
    const queue = (presencePublications.get(scopeKey) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => updatePresence({ clientId, away }))
      .then(() => undefined)
      .catch(error => {
        console.warn('[Wework] Failed to synchronize away IM notification presence', error)
      })
    presencePublications.set(scopeKey, queue)
    void queue.finally(() => {
      if (presencePublications.get(scopeKey) === queue) presencePublications.delete(scopeKey)
    })
  }

  const unsubscribeFocus = subscribeMainWindowFocus(nextFocused => {
    focused = nextFocused
    enqueue()
  })
  const unsubscribeSystemLock = subscribeSystemSessionLock(nextLocked => {
    systemLocked = nextLocked
    enqueue()
  })
  const handleVisibilityChange = () => enqueue()
  const handlePageHide = () => {
    focused = false
    enqueue()
  }
  document.addEventListener('visibilitychange', handleVisibilityChange)
  window.addEventListener('pagehide', handlePageHide)
  enqueue(true)
  const heartbeat = window.setInterval(() => enqueue(true), IM_NOTIFICATION_PRESENCE_HEARTBEAT_MS)

  return () => {
    active = false
    unsubscribeFocus()
    unsubscribeSystemLock()
    document.removeEventListener('visibilitychange', handleVisibilityChange)
    window.removeEventListener('pagehide', handlePageHide)
    window.clearInterval(heartbeat)
  }
}
