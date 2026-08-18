import { isTauriRuntime } from '@/lib/runtime-environment'

export interface RuntimeTaskCompletionNotification {
  title: string
  body: string
}

interface SystemNotificationTestState {
  notifications: RuntimeTaskCompletionNotification[]
}

function systemNotificationTestState(): SystemNotificationTestState | null {
  if (import.meta.env.VITE_WEWORK_E2E !== 'true') return null
  const root = globalThis as typeof globalThis & {
    __WEWORK_E2E_SYSTEM_NOTIFICATIONS__?: SystemNotificationTestState
  }
  root.__WEWORK_E2E_SYSTEM_NOTIFICATIONS__ ??= { notifications: [] }
  return root.__WEWORK_E2E_SYSTEM_NOTIFICATIONS__
}

export async function sendSystemNotification({
  title,
  body,
}: RuntimeTaskCompletionNotification): Promise<void> {
  if (!isTauriRuntime()) return

  const testState = systemNotificationTestState()
  if (testState) {
    testState.notifications.push({ title, body })
    return
  }

  try {
    const notification = await import('@tauri-apps/plugin-notification')
    let granted = await notification.isPermissionGranted()
    if (!granted) {
      const permission = await notification.requestPermission()
      granted = permission === 'granted'
    }
    if (!granted) return

    notification.sendNotification({ title, body })
  } catch (error) {
    console.error('[Wework] Failed to send system notification', error)
  }
}
