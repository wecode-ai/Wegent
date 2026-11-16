import { useEffect, useRef } from 'react'
import { showErrorAlert } from '@/services/errorAlerts'

/** State-driven failures share the same presenter as imperative operation failures. */
export function NativeErrorAlert({
  error,
  title,
  retryLabel,
  onDismiss,
  onRetry,
}: {
  error: unknown
  title?: string
  retryLabel?: string
  onDismiss: () => void
  onRetry?: () => void | Promise<unknown>
}) {
  const current = useRef({ error, onDismiss, onRetry })
  const retryable = Boolean(onRetry)
  current.current = { error, onDismiss, onRetry }
  useEffect(() => {
    if (!error) return
    return showErrorAlert(error, {
      title,
      retryLabel,
      onDismiss: () => {
        if (current.current.error === error) current.current.onDismiss()
      },
      onRetry: onRetry ? () => current.current.onRetry?.() : undefined,
    })
  }, [error, title, retryLabel, retryable])
  return null
}
