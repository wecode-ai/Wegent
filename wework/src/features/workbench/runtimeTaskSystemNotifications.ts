import { isTauriRuntime } from '@/lib/runtime-environment'

export interface RuntimeTaskCompletionNotification {
  title: string
  body: string
}

export async function sendRuntimeTaskCompletionNotification({
  title,
  body,
}: RuntimeTaskCompletionNotification): Promise<void> {
  if (!isTauriRuntime()) return

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
    console.error('[Wework] Failed to send task completion notification', error)
  }
}
