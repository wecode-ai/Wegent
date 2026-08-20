import { Loader2, Trash2, X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

export function ClearBrowserDataDialog({
  loading,
  onCancel,
  onConfirm,
}: {
  loading: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation('common')

  return (
    <div
      data-testid="browser-clear-data-dialog-backdrop"
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
      onClick={event => {
        if (!loading && event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="browser-clear-data-dialog-title"
        data-testid="browser-clear-data-dialog"
        className="w-full max-w-[430px] rounded-2xl border border-border bg-popover p-5 shadow-[0_20px_60px_rgba(0,0,0,0.28)]"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              id="browser-clear-data-dialog-title"
              className="text-base font-semibold text-text-primary"
            >
              {t('workbench.browser_settings_clear_dialog_title')}
            </h2>
            <p className="mt-2 text-sm leading-5 text-text-secondary">
              {t('workbench.browser_settings_clear_dialog_description')}
            </p>
          </div>
          <button
            type="button"
            data-testid="browser-clear-data-dialog-close"
            aria-label={t('common.close', '关闭')}
            disabled={loading}
            onClick={onCancel}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="browser-clear-data-cancel"
            disabled={loading}
            onClick={onCancel}
            className="h-8 rounded-md bg-muted px-3 text-sm font-medium text-text-primary hover:bg-hover disabled:opacity-50"
          >
            {t('common.cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid="browser-clear-data-confirm"
            disabled={loading}
            onClick={onConfirm}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-red-500 px-3 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            {t('workbench.browser_settings_clear_action')}
          </button>
        </div>
      </div>
    </div>
  )
}
