import { installResizeObserverDiagnostics } from './resize-observer-diagnostics'
import { getDesktopE2ERuntimeConfig } from './runtime-config'
import { getConversationDiagnosticsSnapshot } from '@wegent/collaboration/conversation/conversationDiagnostics'

function captureEnabled(): boolean {
  if (typeof window === 'undefined' || getDesktopE2ERuntimeConfig().disabled) return false
  return (
    import.meta.env.VITE_WEWORK_E2E === 'true' || Boolean(getDesktopE2ERuntimeConfig().controlUrl)
  )
}

export function reportE2EDiagnostic(type: string, details: Record<string, unknown>): void {
  if (!captureEnabled()) return
  try {
    console.info('[wework-e2e-diagnostic]', JSON.stringify({ type, details }))
  } catch (error) {
    reportE2EError('diagnostic-serialization-failed', error)
  }
}

export function reportE2EError(type: string, error: unknown, diagnostics?: unknown): void {
  if (!captureEnabled()) return
  console.error(
    '[wework-e2e-error]',
    JSON.stringify({
      type,
      ...(diagnostics ? { diagnostics } : {}),
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      ...(error && typeof error === 'object'
        ? Object.fromEntries(
            ['code', 'status', 'errorCode', 'retryable']
              .filter(key => key in error)
              .map(key => [key, (error as Record<string, unknown>)[key]])
              .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
          )
        : {}),
    })
  )
}

export function installE2EErrorCapture(target: Window = window): () => void {
  const resize =
    !getDesktopE2ERuntimeConfig().disabled &&
    (import.meta.env.VITE_WEWORK_E2E === 'true' || getDesktopE2ERuntimeConfig().controlUrl)
      ? installResizeObserverDiagnostics(target)
      : undefined
  const onError = (event: ErrorEvent) =>
    reportE2EError(
      'uncaught-exception',
      event.error ?? event.message,
      event.message?.includes('ResizeObserver loop')
        ? {
            ...resize?.snapshot({ inspectCurrentGeometry: true }),
            conversation: getConversationDiagnosticsSnapshot(),
          }
        : undefined
    )
  const onRejection = (event: PromiseRejectionEvent) =>
    reportE2EError('unhandled-rejection', event.reason)
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    resize?.stop()
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}

if (
  typeof window !== 'undefined' &&
  (import.meta.env.VITE_WEWORK_E2E === 'true' || getDesktopE2ERuntimeConfig().controlUrl)
) {
  installE2EErrorCapture()
}
