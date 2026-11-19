import { useTranslation } from '@/hooks/useTranslation'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Loader2, Trash2, X } from 'lucide-react'

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
      <DialogSurface
        onClose={() => {
          if (!loading) onCancel()
        }}
        render={
          <div
            aria-labelledby="browser-clear-data-dialog-title"
            data-testid="browser-clear-data-dialog"
            className="w-full max-w-[430px] rounded-2xl border border-border bg-popover p-5 shadow-[0_20px_60px_rgba(0,0,0,0.28)]"
          />
        }
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
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="browser-clear-data-dialog-close"
            aria-label={t('common.close', '关闭')}
            disabled={loading}
            onClick={onCancel}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </ControlButton>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <ControlButton
            variant="ghost"
            size="sm"
            type="button"
            data-testid="browser-clear-data-cancel"
            disabled={loading}
            onClick={onCancel}
          >
            {t('common.cancel', '取消')}
          </ControlButton>
          <ControlButton
            type="button"
            data-testid="browser-clear-data-confirm"
            disabled={loading}
            onClick={onConfirm}
            variant="destructive"
            size="sm"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
            {t('workbench.browser_settings_clear_action')}
          </ControlButton>
        </div>
      </DialogSurface>
    </div>
  )
}
