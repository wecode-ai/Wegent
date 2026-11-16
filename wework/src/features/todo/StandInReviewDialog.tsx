import { useId, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { useTranslation } from '@/hooks/useTranslation'

export function StandInReviewDialog({
  open,
  title,
  testId,
  busy = false,
  compact = false,
  onClose,
  children,
}: {
  open: boolean
  title: string
  testId: string
  busy?: boolean
  compact?: boolean
  onClose(): void
  children: ReactNode
}) {
  const { t } = useTranslation('common')
  const titleId = useId()
  const close = () => {
    if (!busy) onClose()
  }
  const ref = useDialogKeyboard<HTMLDivElement>(close, open, '[data-dialog-close]')
  if (!open) return null
  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/20 p-4"
      onClick={event => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        className={`flex max-h-[calc(100dvh-2rem)] w-full ${compact ? 'max-w-[520px]' : 'max-w-2xl'} flex-col overflow-hidden rounded-2xl border border-border bg-background text-text-primary shadow-lg`}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
          <h2 id={titleId} className="min-w-0 flex-1 text-lg font-medium">
            {title}
          </h2>
          <button
            type="button"
            data-dialog-close
            data-testid={`${testId}-close`}
            aria-label={t('standIn.close')}
            title={t('standIn.close')}
            disabled={busy}
            onClick={close}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-muted disabled:opacity-45 md:h-8 md:w-8"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto p-5">{children}</div>
      </div>
    </div>,
    document.body
  )
}
