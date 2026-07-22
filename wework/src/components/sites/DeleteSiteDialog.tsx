import { useEffect, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import type { SiteProject } from '@/api/sites'
import { useTranslation } from '@/hooks/useTranslation'

interface DeleteSiteDialogProps {
  site: SiteProject
  loading: boolean
  error: string | null
  returnFocusContainer: HTMLElement | null
  onCancel: () => void
  onConfirm: () => void
}

export function DeleteSiteDialog({
  site,
  loading,
  error,
  returnFocusContainer,
  onCancel,
  onConfirm,
}: DeleteSiteDialogProps) {
  const { t } = useTranslation('sites')
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const confirmButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const wasLoading = useRef(false)

  useEffect(() => {
    cancelButtonRef.current?.focus()
    return () => {
      const returnFocusButton =
        returnFocusContainer?.querySelector<HTMLButtonElement>('button:not([disabled])')
      if (returnFocusButton?.isConnected) returnFocusButton.focus()
    }
  }, [returnFocusContainer])

  useEffect(() => {
    if (loading) {
      wasLoading.current = true
      dialogRef.current?.focus()
    } else if (wasLoading.current) {
      wasLoading.current = false
      confirmButtonRef.current?.focus()
    }
  }, [loading])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !loading) onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [loading, onCancel])

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !dialogRef.current) return

    const focusableElements = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter(element => !element.hasAttribute('aria-hidden'))
    if (focusableElements.length === 0) {
      event.preventDefault()
      dialogRef.current.focus()
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

  return (
    <div
      data-testid="site-delete-dialog-overlay"
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/40 px-4"
      onClick={event => {
        if (!loading && event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="site-delete-dialog-title"
        aria-describedby="site-delete-dialog-description"
        tabIndex={-1}
        data-testid="site-delete-dialog"
        className="w-full max-w-[420px] rounded-lg border border-border bg-popover p-5 shadow-[0_18px_50px_rgba(0,0,0,0.28)]"
        onClick={event => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-red-500/10 text-red-500">
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="site-delete-dialog-title" className="text-sm font-semibold text-text-primary">
              {t('delete_title', '删除站点？')}
            </h2>
            <p
              id="site-delete-dialog-description"
              className="mt-1.5 text-xs leading-5 text-text-secondary"
            >
              {t('delete_description', {
                name: site.title,
                defaultValue:
                  '将删除“{{name}}”的站点项目；存在关联资源时服务会拒绝删除。本操作不会删除本地目录。',
              })}
            </p>
            {error && (
              <p className="mt-2 text-xs leading-5 text-red-500" role="alert">
                {error}
              </p>
            )}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelButtonRef}
            type="button"
            data-testid="site-delete-cancel-button"
            onClick={onCancel}
            disabled={loading}
            className="h-11 rounded-md px-3 text-sm text-text-secondary transition-colors hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 md:h-8"
          >
            {t('cancel', '取消')}
          </button>
          <button
            ref={confirmButtonRef}
            type="button"
            data-testid="site-delete-confirm-button"
            onClick={onConfirm}
            disabled={loading}
            className="inline-flex h-11 items-center gap-1.5 rounded-md bg-red-600 px-3 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50 md:h-8"
          >
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {loading ? t('deleting', '删除中') : t('confirm_delete', '删除')}
          </button>
        </div>
      </div>
    </div>
  )
}
