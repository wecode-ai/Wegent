import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { weworkTaskScheme } from '@/features/notifications/scheme'
import { isElectronRuntime } from '@/lib/runtime-environment'
import type { RuntimeTaskAddress } from '@/types/api'

export interface RuntimeTaskCompletionNotification {
  title: string
  body: string
  address?: RuntimeTaskAddress
  url?: string
  reply?: { interactionId: string; accountKey: string; placeholder: string }
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
  address,
  url = address ? weworkTaskScheme(address) : undefined,
  reply,
}: RuntimeTaskCompletionNotification): Promise<void> {
  if (!isElectronRuntime()) return

  const testState = systemNotificationTestState()
  if (testState && !reply) {
    testState.notifications.push({ title, body, address, url })
    return
  }

  try {
    await invokeDesktopHost<void>('notification.show', {
      title,
      body,
      ...(url ? { url } : {}),
      ...(reply ? { reply } : {}),
    })
  } catch (error) {
    console.error('[Wework] Failed to send system notification', error)
  }
}
