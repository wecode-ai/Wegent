import type {
  createNotificationsApi,
  WeworkNotificationCategory,
  WeworkNotificationPreferences,
  WeworkInbox,
} from '@/api/notifications'
import type { createRuntimeWorkApi } from '@/api/runtimeWork'
import {
  cacheNotificationPreferences,
  readCachedNotificationPreferences,
  mergeNotificationPreferences,
  migrateLegacyTaskSystemNotification,
} from './notificationPreferences'
interface Snapshot {
  preferences: WeworkNotificationPreferences
  inboxes: Record<WeworkNotificationCategory, WeworkInbox | null>
  error: string | null
  busy: boolean
}
type Change<T> = T | ((current: T) => T)
interface Input {
  api: ReturnType<typeof createNotificationsApi> | null
  runtimeApi: ReturnType<typeof createRuntimeWorkApi> | null
  paused: boolean
}
const CLOUD_CATEGORIES: WeworkNotificationCategory[] = ['collaboration', 'general']
/** One account owns inbox reads, preferences and request invalidation. */
export function createNotificationCenterFeed(accountKey: string) {
  let snapshot: Snapshot = {
    preferences: readCachedNotificationPreferences(accountKey),
    inboxes: { collaboration: null, general: null },
    error: null,
    busy: false,
  }
  let api: Input['api'] = null
  let runtimeApi: Input['runtimeApi'] = null
  let paused = false
  let started = false
  let observation = 0
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let preferenceTimer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const requestId = { current: 0 }
  const preferenceRequestId = { current: 0 }
  function publish(patch: Partial<Snapshot>) {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  const setPreferences = (change: Change<Snapshot['preferences']>) =>
    publish({ preferences: typeof change === 'function' ? change(snapshot.preferences) : change })
  const setInboxes = (change: Change<Snapshot['inboxes']>) =>
    publish({ inboxes: typeof change === 'function' ? change(snapshot.inboxes) : change })
  const setError = (error: Snapshot['error']) => publish({ error })
  const setBusy = (busy: boolean) => publish({ busy })
  const fetchPreferences = async () => {
    if (!listeners.size) return
    const id = ++preferenceRequestId.current
    try {
      await migrateLegacyTaskSystemNotification(accountKey, async () => {
        if (api) {
          await api.updatePreferences({
            category: 'tasks',
            channel: 'system',
            enabled: true,
          })
        }
        if (id !== preferenceRequestId.current || !listeners.size) {
          throw new Error('Stale notification preference migration')
        }
        const current = readCachedNotificationPreferences(accountKey)
        const migrated = {
          ...current,
          tasks: { ...current.tasks, system: true },
        }
        cacheNotificationPreferences(accountKey, migrated)
        setPreferences(migrated)
      })
    } catch (cause) {
      if (id !== preferenceRequestId.current) return
      console.error('[Wework] Failed to migrate legacy task notification setting', cause)
    }
    if (!api || !runtimeApi || id !== preferenceRequestId.current) return

    const next = await api.getPreferences()
    let taskIm: boolean | null | undefined
    try {
      const imSettings = await runtimeApi.getImNotificationSettings()
      taskIm = imSettings.global.enabled
    } catch (cause) {
      console.error('[Wework] Failed to load task IM notification settings', cause)
    }
    if (id !== preferenceRequestId.current) return
    setPreferences(current => {
      const merged = {
        ...mergeNotificationPreferences({ ...next, stand_in: next.stand_in ?? current.stand_in }),
        tasks: {
          ...next.tasks,
          im: taskIm === undefined ? current.tasks.im : taskIm,
        },
      }
      cacheNotificationPreferences(accountKey, merged)
      return merged
    })
  }
  const refresh = () => {
    const client = api
    if (!client || !listeners.size) return Promise.resolve()
    const id = ++requestId.current
    return Promise.all(
      CLOUD_CATEGORIES.map(async cloudCategory => {
        try {
          const inbox = await client.list(0, cloudCategory)
          if (id === requestId.current)
            setInboxes(current => ({ ...current, [cloudCategory]: inbox }))
          return null
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          if (id === requestId.current) setError(message)
          return message
        }
      })
    ).then(errors => {
      if (id === requestId.current) setError(errors.find(error => error !== null) ?? null)
    })
  }

  const refreshPreferences = async () => {
    const expected = preferenceRequestId.current + 1
    try {
      await fetchPreferences()
    } catch (cause) {
      if (expected === preferenceRequestId.current && listeners.size)
        setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return {
    getSnapshot: () => snapshot,
    cachePreferences(preferences: WeworkNotificationPreferences) {
      if (listeners.size) cacheNotificationPreferences(accountKey, preferences)
    },
    refresh,
    refreshPreferences,
    setPreferences,
    setInboxes,
    setError,
    setBusy,
    invalidateRequests: () => {
      requestId.current += 1
    },
    invalidatePreferences: () => {
      preferenceRequestId.current += 1
    },
    subscribe(listener: () => void, next: Input) {
      const revision = ++observation
      listeners.add(listener)
      const apiChanged = api !== next.api || runtimeApi !== next.runtimeApi
      const pauseChanged = paused !== next.paused
      api = next.api
      runtimeApi = next.runtimeApi
      paused = next.paused
      if (!started || apiChanged) {
        preferenceRequestId.current += 1
        clearTimeout(preferenceTimer)
        if (!started) {
          const current = readCachedNotificationPreferences(accountKey)
          setPreferences(current)
          cacheNotificationPreferences(accountKey, current)
        }
        preferenceTimer = setTimeout(() => {
          void refreshPreferences()
        }, 0)
      }
      if (!started || apiChanged || pauseChanged) void refresh()
      if (!started) {
        started = true
        pollTimer = setInterval(() => {
          if (!paused) void refresh()
        }, 15000)
      }
      return () => {
        listeners.delete(listener)
        requestId.current += 1
        queueMicrotask(() => {
          if (listeners.size || observation !== revision) return
          preferenceRequestId.current += 1
          clearTimeout(preferenceTimer)
          clearInterval(pollTimer)
          started = false
        })
      }
    },
  }
}
