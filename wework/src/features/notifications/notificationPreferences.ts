import type { WeworkNotificationPreferences } from '@/api/notifications'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from '@/lib/runtime-environment'

export const NOTIFICATION_PREFERENCES_CHANGED_EVENT = 'wework:notification-preferences-changed'
export const OPEN_NOTIFICATION_SETTINGS_EVENT = 'wework:open-notification-settings'
const ACTIVE_NOTIFICATION_PREFERENCES_KEY = 'wework.notification-preferences:active'
const LEGACY_TASK_SYSTEM_MIGRATION_PREFIX =
  'wework.notification-preferences:legacy-task-system-migrated'

export const defaultNotificationPreferences: WeworkNotificationPreferences = {
  tasks: { in_app: true, system: false, im: null },
  collaboration: { in_app: true, system: true, im: true },
  general: { in_app: true, system: null, im: true },
}

function storageKey(accountKey: string): string {
  return `wework.notification-preferences:${accountKey}`
}

export async function migrateLegacyTaskSystemNotification(
  accountKey: string,
  enableTaskSystemNotification: () => Promise<unknown>
): Promise<void> {
  if (!isElectronRuntime()) return
  const migrationKey = `${LEGACY_TASK_SYSTEM_MIGRATION_PREFIX}:${accountKey}`
  if (localStorage.getItem(migrationKey) === '1') return

  const legacy = await invokeDesktopHost<Record<string, unknown>>('preferences.get')
  if (legacy.taskCompletionNotificationsEnabled === true) {
    await enableTaskSystemNotification()
  }
  localStorage.setItem(migrationKey, '1')
}

export function readCachedNotificationPreferences(
  accountKey: string
): WeworkNotificationPreferences {
  try {
    const raw = localStorage.getItem(storageKey(accountKey))
    if (!raw) return defaultNotificationPreferences
    const parsed = JSON.parse(raw) as Partial<WeworkNotificationPreferences>
    return {
      tasks: { ...defaultNotificationPreferences.tasks, ...parsed.tasks },
      collaboration: {
        ...defaultNotificationPreferences.collaboration,
        ...parsed.collaboration,
      },
      general: { ...defaultNotificationPreferences.general, ...parsed.general },
    }
  } catch {
    return defaultNotificationPreferences
  }
}

export function cacheNotificationPreferences(
  accountKey: string,
  preferences: WeworkNotificationPreferences
): void {
  localStorage.setItem(storageKey(accountKey), JSON.stringify(preferences))
  localStorage.setItem(ACTIVE_NOTIFICATION_PREFERENCES_KEY, JSON.stringify(preferences))
  window.dispatchEvent(
    new CustomEvent(NOTIFICATION_PREFERENCES_CHANGED_EVENT, {
      detail: { accountKey, preferences },
    })
  )
}

export function readActiveNotificationPreferences(): WeworkNotificationPreferences {
  try {
    const raw = localStorage.getItem(ACTIVE_NOTIFICATION_PREFERENCES_KEY)
    if (!raw) return defaultNotificationPreferences
    const parsed = JSON.parse(raw) as WeworkNotificationPreferences
    return {
      tasks: { ...defaultNotificationPreferences.tasks, ...parsed.tasks },
      collaboration: {
        ...defaultNotificationPreferences.collaboration,
        ...parsed.collaboration,
      },
      general: { ...defaultNotificationPreferences.general, ...parsed.general },
    }
  } catch {
    return defaultNotificationPreferences
  }
}
