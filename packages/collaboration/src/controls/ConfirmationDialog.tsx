import { useCallback, useRef, useState, type ReactNode } from 'react'
import { useFocusRequest } from '../dom-events'
import { Button as ControlButton } from '../markdown/Button'
import { DialogSurface } from './DialogSurface'

export function ConfirmationDialog({
  title,
  subject,
  description,
  labels,
  testIdPrefix,
  onConfirm,
  onClose,
}: {
  title: string
  subject: ReactNode
  description: ReactNode
  labels: { cancel: string; confirm: string; pending: string; failed: string }
  testIdPrefix: string
  onConfirm(): Promise<void>
  onClose(): void
}) {
  const lock = useRef(false)
  const dialog = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirmButton = useRef<HTMLButtonElement>(null)
  const attachBackdrop = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useFocusRequest(confirmButton, error ?? undefined, { enabled: !pending && Boolean(error) })
  const confirm = async () => {
    if (lock.current) return
    lock.current = true
    dialog.current?.focus()
    setPending(true)
    setError(null)
    try {
      await onConfirm()
      if (mounted.current) onClose()
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : labels.failed)
    } finally {
      lock.current = false
      if (mounted.current) setPending(false)
    }
  }
  return (
    <div ref={attachBackdrop} className="collaboration-resource-dialog-backdrop fixed inset-0 z-modal flex items-center justify-center bg-black/35 p-4">
      <DialogSurface
        kind="alertdialog"
        onClose={() => {
          if (!lock.current) onClose()
        }}
        initialFocus={`[data-testid="${testIdPrefix}-cancel"]`}
        render={
          <div
            ref={dialog}
            aria-label={title}
            aria-busy={pending}
            tabIndex={-1}
            data-testid={`${testIdPrefix}-dialog`}
            className="w-full max-w-md rounded-2xl border border-border bg-background p-6 text-text-primary shadow-lg"
          />
        }
      >
        <h2 className="text-lg font-medium">{title}</h2>
        <p className="mt-3 break-words font-medium">{subject}</p>
        <p className="mt-2 text-sm text-text-secondary">{description}</p>
        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <ControlButton
            variant="unstyled"
            type="button"
            disabled={pending}
            className="min-h-11 rounded-lg px-4 text-sm hover:bg-muted disabled:opacity-50 md:min-h-8"
            data-testid={`${testIdPrefix}-cancel`}
            onClick={onClose}
          >
            {labels.cancel}
          </ControlButton>
          <ControlButton
            variant="primary"
            size="sm"
            type="button"
            disabled={pending}
            className="min-h-11 rounded-lg bg-text-primary px-4 text-sm text-background disabled:opacity-50 md:min-h-8"
            ref={confirmButton}
            data-testid={`${testIdPrefix}-confirm`}
            onClick={() => void confirm()}
          >
            {pending ? labels.pending : labels.confirm}
          </ControlButton>
        </div>
      </DialogSurface>
    </div>
  )
}
