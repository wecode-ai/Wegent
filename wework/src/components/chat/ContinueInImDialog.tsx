import { X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { IMPrivateSession } from '@/types/api'

interface ContinueInImDialogProps {
  open: boolean
  loading: boolean
  submitting: boolean
  sessions: IMPrivateSession[]
  onClose: () => void
  onSubmit: (sessionIds: number[]) => Promise<void>
}

export function ContinueInImDialog({
  open,
  loading,
  submitting,
  sessions,
  onClose,
  onSubmit,
}: ContinueInImDialogProps) {
  if (!open) {
    return null
  }

  return (
    <ContinueInImDialogContent
      loading={loading}
      submitting={submitting}
      sessions={sessions}
      onClose={onClose}
      onSubmit={onSubmit}
    />
  )
}

type ContinueInImDialogContentProps = Omit<ContinueInImDialogProps, 'open'>

function ContinueInImDialogContent({
  loading,
  submitting,
  sessions,
  onClose,
  onSubmit,
}: ContinueInImDialogContentProps) {
  const { t } = useTranslation('common')
  const dialogRef = useRef<HTMLElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<number>>(new Set())
  const validSessionIds = useMemo(() => new Set(sessions.map(session => session.id)), [sessions])
  const selectedIds = useMemo(
    () => Array.from(selectedSessionIds).filter(id => validSessionIds.has(id)),
    [selectedSessionIds, validSessionIds]
  )

  useEffect(() => {
    closeButtonRef.current?.focus()
  }, [])

  const toggleSession = (sessionId: number) => {
    setSelectedSessionIds(current => {
      const next = new Set(current)
      if (next.has(sessionId)) {
        next.delete(sessionId)
      } else {
        next.add(sessionId)
      }
      return next
    })
  }

  const handleSubmit = () => {
    void onSubmit(selectedIds)
  }

  const closeIfAllowed = () => {
    if (!submitting) {
      onClose()
    }
  }

  const getFocusableElements = () => {
    if (!dialogRef.current) return []

    return Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter(element => !element.hasAttribute('aria-hidden'))
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      closeIfAllowed()
      return
    }

    if (event.key !== 'Tab') {
      return
    }

    const focusableElements = getFocusableElements()
    if (focusableElements.length === 0) {
      event.preventDefault()
      return
    }

    const firstElement = focusableElements[0]
    const lastElement = focusableElements[focusableElements.length - 1]

    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault()
      lastElement.focus()
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault()
      firstElement.focus()
    }
  }

  return createPortal(
    <div
      data-testid="continue-im-dialog-overlay"
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/30 px-4 py-6"
      onClick={closeIfAllowed}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="continue-im-dialog-title"
        className="flex max-h-[min(82dvh,40rem)] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border bg-background text-text-primary shadow-[0_18px_60px_rgba(0,0,0,0.22)]"
        onClick={event => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <header className="flex min-h-14 items-center gap-3 border-b border-border px-4">
          <h2 id="continue-im-dialog-title" className="min-w-0 flex-1 text-lg font-semibold">
            {t('workbench.continue_im_title')}
          </h2>
          <button
            ref={closeButtonRef}
            type="button"
            data-testid="continue-im-close-button"
            className="flex h-11 min-w-[44px] items-center justify-center rounded-lg text-text-secondary hover:bg-surface hover:text-text-primary"
            aria-label={t('workbench.continue_im_close')}
            onClick={onClose}
            disabled={submitting}
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {loading ? (
            <div
              data-testid="continue-im-loading"
              className="flex min-h-28 items-center justify-center text-sm text-text-secondary"
            >
              {t('workbench.continue_im_loading')}
            </div>
          ) : sessions.length === 0 ? (
            <div
              data-testid="continue-im-empty-guide"
              className="rounded-lg border border-dashed border-border bg-surface px-4 py-6 text-sm leading-6 text-text-secondary"
            >
              {t('workbench.continue_im_empty_guide')}
            </div>
          ) : (
            <div className="space-y-2">
              {sessions.map(session => {
                const selected = selectedSessionIds.has(session.id)
                return (
                  <button
                    key={session.id}
                    type="button"
                    data-testid={`continue-im-session-${session.id}`}
                    className={cn(
                      'flex min-h-11 w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors',
                      selected
                        ? 'border-primary bg-primary/10'
                        : 'border-border bg-surface hover:border-primary/60'
                    )}
                    aria-pressed={selected}
                    onClick={() => toggleSession(session.id)}
                    disabled={submitting}
                  >
                    <span
                      className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded border',
                        selected ? 'border-primary bg-primary' : 'border-border bg-background'
                      )}
                      aria-hidden="true"
                    >
                      {selected && <span className="h-2 w-2 rounded-full bg-white" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium text-text-primary">
                          {session.display_name}
                        </span>
                        {session.channel_label && (
                          <span className="shrink-0 rounded border border-border/70 bg-base px-1.5 py-0.5 text-[10px] font-medium leading-none text-text-muted">
                            {session.channel_label}
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-xs text-text-muted">
                        {session.mode === 'task'
                          ? t('workbench.continue_im_session_task_mode')
                          : t('workbench.continue_im_session_chat_mode')}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            data-testid="continue-im-cancel-button"
            className="h-11 min-w-[44px] rounded-lg border border-border px-4 text-sm font-medium text-text-secondary hover:bg-surface hover:text-text-primary"
            onClick={onClose}
            disabled={submitting}
          >
            {t('workbench.continue_im_cancel')}
          </button>
          <button
            type="button"
            data-testid="continue-im-submit-button"
            className="h-11 min-w-[44px] rounded-lg bg-primary px-4 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
            onClick={handleSubmit}
            disabled={loading || submitting || selectedIds.length === 0}
          >
            {submitting ? t('workbench.continue_im_submitting') : t('workbench.continue_im_submit')}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  )
}
