import { DialogSurface } from '../controls/DialogSurface'
import { Button as ControlButton } from '../markdown/Button'
import type { DialogFinalFocus } from '@ui-sdk/react/dialog'
import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { useCollaborationPortalTheme } from '../theme'

interface ConfirmDialogProps {
  open: boolean
  title: string
  description: ReactNode
  cancelLabel: string
  confirmLabel: string
  confirmTestId: string
  dialogTestId?: string
  cancelTestId?: string
  destructive?: boolean
  focusCancel?: boolean
  pending?: boolean
  confirmDisabled?: boolean
  overlayClassName?: string
  finalFocus?: DialogFinalFocus
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
  focusCancel = false,
  pending = false,
  confirmDisabled = false,
  overlayClassName = 'z-modal',
  finalFocus,
  onClose,
  onConfirm,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const theme = useCollaborationPortalTheme()

  if (!open) return null

  return createPortal(
    <div
      {...theme}
      className={`${theme.className} fixed inset-0 flex items-center justify-center bg-black/35 p-4 ${overlayClassName}`}
    >
      <DialogSurface
        kind="alertdialog"
        onClose={() => {
          if (!pending) onClose()
        }}
        active={open}
        initialFocus={destructive || focusCancel ? 'button:first-of-type' : 'button:last-of-type'}
        finalFocus={finalFocus}
        render={
          <div
            ref={dialogRef}
            data-testid={dialogTestId}
            aria-labelledby={`${confirmTestId}-title`}
            aria-describedby={`${confirmTestId}-description`}
            className="flex max-h-[calc(100dvh-2rem)] w-full max-w-[420px] flex-col rounded-[20px] border border-border bg-popover p-5 text-text-primary shadow-lg"
          />
        }
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
          <ControlButton
            variant="outline"
            size="sm"
            type="button"
            data-testid={cancelTestId ?? `${confirmTestId}-cancel-button`}
            disabled={pending}
            onClick={onClose}
          >
            {cancelLabel}
          </ControlButton>
          <ControlButton
            variant={destructive ? 'destructive' : 'primary'}
            size="sm"
            type="button"
            data-testid={confirmTestId}
            disabled={pending || confirmDisabled}
            onClick={onConfirm}
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
          </ControlButton>
        </div>
      </DialogSurface>
    </div>,
    document.body
  )
}
