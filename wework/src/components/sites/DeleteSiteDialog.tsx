import { useEffect, useRef } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import type { Site } from '@/api/sites'
import { useTranslation } from '@/hooks/useTranslation'

interface DeleteSiteDialogProps {
  site: Site
  loading: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}

export function DeleteSiteDialog({
  site,
  loading,
  error,
  onCancel,
  onConfirm,
}: DeleteSiteDialogProps) {
  const { t } = useTranslation('sites')
  const cancelButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelButtonRef.current?.focus()
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !loading) onCancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [loading, onCancel])

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/40 px-4"
      onClick={event => {
        if (!loading && event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="site-delete-dialog-title"
        aria-describedby="site-delete-dialog-description"
        data-testid="site-delete-dialog"
        className="w-full max-w-[420px] rounded-lg border border-border bg-popover p-5 shadow-[0_18px_50px_rgba(0,0,0,0.28)]"
        onClick={event => event.stopPropagation()}
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
                name: site.name,
                defaultValue: '将删除“{{name}}”的站点登记和公网入口，但不会删除本地目录。',
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
            className="h-8 rounded-md px-3 text-sm text-text-secondary transition-colors hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid="site-delete-confirm-button"
            onClick={onConfirm}
            disabled={loading}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-red-600 px-3 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {loading ? t('deleting', '删除中') : t('confirm_delete', '删除')}
          </button>
        </div>
      </div>
    </div>
  )
}
