import { Loader2 } from 'lucide-react'
import { createPortal } from 'react-dom'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'

interface ConfirmDialogProps {
  open: boolean
  title: string
  description: string
  cancelLabel: string
  confirmLabel: string
  confirmTestId: string
  dialogTestId?: string
  cancelTestId?: string
  destructive?: boolean
  pending?: boolean
  onClose: () => void
  onConfirm: () => void
}

export function ConfirmDialog({
  open,
  title,
  description,
  cancelLabel,
  confirmLabel,
  confirmTestId,
  dialogTestId,
  cancelTestId,
  destructive = false,
  pending = false,
  onClose,
  onConfirm,
}: ConfirmDialogProps) {
  const dialogRef = useDialogKeyboard<HTMLDivElement>(
    () => {
      if (!pending) onClose()
    },
    open,
    destructive ? 'button:first-of-type' : 'button:last-of-type'
  )

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 p-4">
      <div
        ref={dialogRef}
        data-testid={dialogTestId}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${confirmTestId}-title`}
        aria-describedby={`${confirmTestId}-description`}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-[420px] flex-col rounded-[20px] border border-border bg-popover p-5 text-text-primary shadow-lg"
      >
        <h2 id={`${confirmTestId}-title`} className="shrink-0 break-words text-lg font-medium">
          {title}
        </h2>
        <p
          id={`${confirmTestId}-description`}
          className="mt-2 min-h-0 overflow-y-auto break-words text-sm leading-5 text-text-secondary"
        >
          {description}
        </p>
        <div className="mt-6 flex shrink-0 flex-wrap justify-end gap-2">
          <button
            type="button"
            data-testid={cancelTestId ?? `${confirmTestId}-cancel-button`}
            disabled={pending}
            onClick={onClose}
            className="min-h-11 rounded-lg border border-border px-3 text-sm text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45 md:min-h-8"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            data-testid={confirmTestId}
            disabled={pending}
            onClick={onConfirm}
            className={
              destructive
                ? 'min-h-11 rounded-lg bg-red-600 px-3 text-sm text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-45 md:min-h-8'
                : 'min-h-11 rounded-lg bg-text-primary px-3 text-sm text-background hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-45 md:min-h-8'
            }
          >
            <span className="inline-flex items-center gap-1.5">
              {pending ? (
                <Loader2
                  className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : null}
              {confirmLabel}
            </span>
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
