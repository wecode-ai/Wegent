import { Loader2 } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { useDialogKeyboard, useFocusRequest } from '@wegent/collaboration/dom-events'
import { createPortal } from 'react-dom'
import { useTranslation } from '@/hooks/useTranslation'
import { cloudModelCatalogSyncQueue } from './cloudModelCatalogSyncRequest'

export function CloudModelCatalogSyncDialogHost() {
  const { t } = useTranslation('common')
  const current = useSyncExternalStore(
    cloudModelCatalogSyncQueue.subscribe,
    cloudModelCatalogSyncQueue.getSnapshot
  )
  const cancel = () => {
    if (current) cloudModelCatalogSyncQueue.cancel(current.id)
  }
  const dialogRef = useDialogKeyboard<HTMLDivElement>(
    cancel,
    current !== null,
    '[data-testid="cloud-model-catalog-sync-cancel-button"]'
  )
  useFocusRequest(dialogRef, current?.id, {
    enabled: current !== null,
    selector: '[data-testid="cloud-model-catalog-sync-cancel-button"]',
  })
  if (!current) return null
  const { syncing, failure } = current
  const error = failure
    ? failure.cause instanceof Error
      ? failure.cause.message
      : t('workbench.cloud_model_catalog_sync_failed')
    : null

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloud-model-catalog-sync-title"
        data-testid="cloud-model-catalog-sync-dialog"
        className="w-full max-w-[420px] rounded-xl border border-border bg-popover p-5 shadow-xl"
        tabIndex={-1}
      >
        <h2 id="cloud-model-catalog-sync-title" className="heading-small text-text-primary">
          {t('workbench.cloud_model_catalog_sync_title')}
        </h2>
        <p className="mt-2 text-sm leading-5 text-text-secondary">
          {t('workbench.cloud_model_catalog_sync_description', {
            device: current.deviceName,
            model: current.modelName,
          })}
        </p>
        {error && (
          <p
            role="alert"
            data-testid="cloud-model-catalog-sync-error"
            className="mt-3 text-sm text-destructive wework:text-red-500"
          >
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="cloud-model-catalog-sync-cancel-button"
            onClick={cancel}
            disabled={syncing}
            className="h-8 rounded-md px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50"
          >
            {t('workbench.cloud_model_catalog_sync_cancel')}
          </button>
          <button
            type="button"
            data-testid="cloud-model-catalog-sync-confirm-button"
            onClick={() => void cloudModelCatalogSyncQueue.confirm(current.id)}
            disabled={syncing}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-text-primary px-3 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
          >
            {syncing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('workbench.cloud_model_catalog_sync_confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
