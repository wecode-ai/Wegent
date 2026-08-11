import { useEffect } from 'react'
import type {
  RuntimeIMNotificationPresenceResponse,
  RuntimeIMNotificationPresenceUpdateRequest,
} from '@/types/api'
import { isMainWindowFocused, subscribeMainWindowFocus } from '@/tauri/windowFocus'
import { isSystemSessionLocked, subscribeSystemSessionLock } from '@/tauri/systemLock'

const CLIENT_ID_STORAGE_KEY = 'wework:im-notification-presence-client-id'
export const IM_NOTIFICATION_PRESENCE_HEARTBEAT_MS = 30_000

type PresenceUpdater = (
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

export function useAwayImNotificationPresence({
  enabled,
  updatePresence,
}: {
  enabled: boolean
  updatePresence?: PresenceUpdater
}) {
  useEffect(() => {
    if (!enabled || !updatePresence) return

    const clientId = getImNotificationPresenceClientId()
    let focused = isMainWindowFocused()
    let systemLocked = isSystemSessionLocked()
    let lastQueuedAway: boolean | null = null
    let queue = Promise.resolve()

    const enqueue = (force = false) => {
      const away = isAwayForImNotifications(focused, document.visibilityState, systemLocked)
      if (!force && away === lastQueuedAway) return
      lastQueuedAway = away
      queue = queue
        .catch(() => undefined)
        .then(() => updatePresence({ clientId, away }))
        .then(() => undefined)
        .catch(error => {
          console.warn('[Wework] Failed to synchronize away IM notification presence', error)
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
      unsubscribeFocus()
      unsubscribeSystemLock()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pagehide', handlePageHide)
      window.clearInterval(heartbeat)
    }
  }, [enabled, updatePresence])
}
