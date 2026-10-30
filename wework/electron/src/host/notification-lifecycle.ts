export interface ElectronNotificationHandle {
  once(event: 'click' | 'close' | 'failed' | 'reply', listener: (...args: unknown[]) => void): void
  show(): void
}

// Electron's native delegate does not retain the JavaScript notification wrapper.
const pendingNotifications = new Set<ElectronNotificationHandle>()

export function showRetainedNotification(
  notification: ElectronNotificationHandle,
  onClick?: () => void,
  onReply?: (reply: string) => void
): void {
  const release = () => pendingNotifications.delete(notification)
  pendingNotifications.add(notification)
  notification.once('click', () => {
    release()
    onClick?.()
  })
  notification.once('close', release)
  if (onReply)
    notification.once('reply', event => {
      release()
      const text = event && typeof event === 'object' && 'reply' in event ? event.reply : undefined
      if (typeof text === 'string' && text.trim()) onReply(text.trim())
    })
  notification.once('failed', (_event, error) => {
    release()
    console.error('[notification] Failed to deliver native notification', error)
  })
  try {
    notification.show()
  } catch (error) {
    release()
    throw error
  }
}
