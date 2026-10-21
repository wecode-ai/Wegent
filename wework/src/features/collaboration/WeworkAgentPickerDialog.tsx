import { X } from 'lucide-react'
import { createPortal } from 'react-dom'
import type { ProjectAgentConfigurationHost } from '@wegent/collaboration'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'

export function WeworkAgentPickerDialog({
  busy,
  children,
  closeLabel,
  description,
  onClose,
  testIds,
  title,
}: Parameters<ProjectAgentConfigurationHost['renderDialog']>[0]) {
  const dialogRef = useDialogKeyboard<HTMLElement>(
    () => {
      if (!busy) onClose()
    },
    true,
    'input[type="search"]'
  )
  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/[0.14] p-3 md:p-6"
      data-testid={testIds.backdrop}
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <section
        ref={dialogRef}
        aria-labelledby="wework-project-agent-dialog-title"
        aria-describedby="wework-project-agent-dialog-description"
        aria-modal="true"
        className="flex max-h-[90dvh] w-full max-w-[520px] flex-col overflow-hidden rounded-[20px] border border-border bg-popover text-text-primary shadow-xl"
        data-testid={testIds.dialog}
        role="dialog"
      >
        <header className="flex items-start justify-between gap-4 px-5 pb-4 pt-5">
          <div className="min-w-0 space-y-1">
            <h2
              className="text-heading-sm font-medium text-text-primary"
              id="wework-project-agent-dialog-title"
            >
              {title}
            </h2>
            <p
              id="wework-project-agent-dialog-description"
              className="text-sm leading-5 text-text-muted"
            >
              {description}
            </p>
          </div>
          <button
            aria-label={closeLabel}
            className="flex h-11 w-11 shrink-0 md:h-8 md:w-8 items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-text-primary disabled:pointer-events-none disabled:opacity-40"
            data-testid={testIds.close}
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </header>
        <div className="flex min-h-0 flex-col">{children}</div>
      </section>
    </div>,
    document.body
  )
}
