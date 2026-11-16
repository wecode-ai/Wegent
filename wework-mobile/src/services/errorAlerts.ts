import { Alert, Platform, type AlertButton } from 'react-native'
import { describeMobileError, redactErrorDetails } from '@/domain/errorPresentation'

interface ErrorAlertOptions {
  title?: string
  retryLabel?: string
  onRetry?: () => void | Promise<unknown>
  onDismiss?: () => void
}

interface QueuedAlert {
  key: string
  open: (done: () => void) => void
  cancelled: boolean
}

const queue: QueuedAlert[] = []
let active: QueuedAlert | undefined

function nextAlert(): void {
  if (active) return
  const item = queue.shift()
  if (!item) return
  if (item.cancelled) {
    nextAlert()
    return
  }
  active = item
  item.open(() => {
    active = undefined
    nextAlert()
  })
}

export async function copyErrorDetails(details: string): Promise<void> {
  try {
    const clipboard = await import('expo-clipboard')
    await clipboard.setStringAsync(redactErrorDetails(details))
  } catch (cause) {
    showErrorAlert(cause, { title: '无法复制错误详情' })
  }
}

/** Confirmations share the platform-owned queue so alerts cannot cover one another. */
export function confirmNativeAction(
  title: string,
  message: string,
  options: { confirmLabel: string; destructive?: boolean; onConfirm: () => void | Promise<void> }
): void {
  queue.push({
    key: `confirmation:${title}`,
    cancelled: false,
    open: done => {
      let closed = false
      const close = () => {
        if (closed) return false
        closed = true
        done()
        return true
      }
      Alert.alert(
        title,
        message,
        [
          { text: '取消', style: 'cancel', onPress: close },
          {
            text: options.confirmLabel,
            style: options.destructive ? 'destructive' : 'default',
            onPress: () => {
              if (!close()) return
              void Promise.resolve()
                .then(options.onConfirm)
                .catch(cause => showErrorAlert(cause))
            },
          },
        ],
        { cancelable: true, onDismiss: close }
      )
    },
  })
  nextAlert()
}

/** UIKit / Android own dialog appearance, button layout, scaling and accessibility. */
export function showErrorAlert(cause: unknown, options: ErrorAlertOptions = {}): () => void {
  const error = describeMobileError(cause, options.title)
  const key = JSON.stringify(error)
  // Only stateless duplicates can share an acknowledgement. Recovery callbacks
  // may belong to different tasks/accounts and must retain their own ownership.
  if (
    !options.onDismiss &&
    !options.onRetry &&
    [active, ...queue].some(item => item && !item.cancelled && item.key === key)
  )
    return () => {}
  const item: QueuedAlert = {
    key,
    cancelled: false,
    open: done => {
      let dismissed = false
      const close = () => {
        if (dismissed) return
        dismissed = true
        if (!item.cancelled) options.onDismiss?.()
        done()
      }
      const dismissButton: AlertButton = {
        text: '关闭',
        style: 'cancel',
        isPreferred: !options.onRetry,
        onPress: close,
      }
      const detailsButton: AlertButton | undefined = error.details
        ? {
            text: '复制详情',
            onPress: () => {
              close()
              void copyErrorDetails(error.details!)
            },
          }
        : undefined
      const retryButton: AlertButton | undefined = options.onRetry
        ? {
            text: options.retryLabel ?? '重试',
            isPreferred: true,
            onPress: () => {
              const retry = !item.cancelled ? options.onRetry : undefined
              close()
              if (retry)
                void Promise.resolve()
                  .then(retry)
                  .catch(cause => {
                    showErrorAlert(cause, options)
                  })
            },
          }
        : undefined
      // Android maps buttons positionally to neutral, negative, then positive.
      const ordered =
        Platform.OS === 'android'
          ? [detailsButton, dismissButton, retryButton]
          : [dismissButton, detailsButton, retryButton]
      const buttons = ordered.filter((button): button is AlertButton => Boolean(button))
      Alert.alert(error.title, error.message, buttons, { cancelable: true, onDismiss: close })
    },
  }
  queue.push(item)
  nextAlert()
  return () => {
    item.cancelled = true
  }
}
