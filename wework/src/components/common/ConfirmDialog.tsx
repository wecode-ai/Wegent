import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'

interface ConfirmDialogProps {
  open: boolean
  title: string
  description: string
  cancelLabel: string
  confirmLabel: string
  confirmTestId: string
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
  destructive = false,
  pending = false,
  onClose,
  onConfirm,
}: ConfirmDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEscapeKey(() => {
    if (open && !pending) onClose()
  })

  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement as HTMLElement | null
    const frame = window.requestAnimationFrame(() => cancelButtonRef.current?.focus())
    return () => {
      window.cancelAnimationFrame(frame)
      previousFocusRef.current?.focus()
      previousFocusRef.current = null
    }
  }, [open])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${confirmTestId}-title`}
        className="w-full max-w-[420px] rounded-[20px] border border-border bg-popover p-5 text-text-primary shadow-lg"
        onKeyDown={event => {
          if (event.key !== 'Tab') return
          const focusable = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
            ) ?? []
          )
          if (focusable.length === 0) return
          const currentIndex = focusable.indexOf(document.activeElement as HTMLElement)
          const nextIndex = event.shiftKey
            ? currentIndex <= 0
              ? focusable.length - 1
              : currentIndex - 1
            : currentIndex === focusable.length - 1
              ? 0
              : currentIndex + 1
          event.preventDefault()
          focusable[nextIndex]?.focus()
        }}
      >
        <h2 id={`${confirmTestId}-title`} className="text-lg font-medium">
          {title}
        </h2>
        <p className="mt-2 text-sm leading-5 text-text-secondary">{description}</p>
        <div className="mt-6 flex justify-end gap-2">
          <button
            ref={cancelButtonRef}
            type="button"
            data-testid={`${confirmTestId}-cancel-button`}
            disabled={pending}
            onClick={onClose}
            className="h-8 rounded-lg border border-border px-3 text-sm text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45"
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
                ? 'h-8 rounded-lg bg-red-600 px-3 text-sm text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-45'
                : 'h-8 rounded-lg bg-text-primary px-3 text-sm text-background hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-45'
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
