import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { createTrayTaskMenuId } from '@/desktop/trayTaskMenuId'
import { isElectronRuntime } from '@/lib/runtime-environment'
import type { RuntimeTaskAddress } from '@/types/api'

export interface RuntimeTaskCompletionNotification {
  title: string
  body: string
  address?: RuntimeTaskAddress
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
}: RuntimeTaskCompletionNotification): Promise<void> {
  if (!isElectronRuntime()) return

  const testState = systemNotificationTestState()
  if (testState) {
    testState.notifications.push({ title, body, address })
    return
  }

  try {
    await invokeDesktopHost<void>('notification.show', {
      title,
      body,
      ...(address ? { taskAddressId: createTrayTaskMenuId(address) } : {}),
    })
  } catch (error) {
    console.error('[Wework] Failed to send system notification', error)
  }
}
