import { useTranslation } from '@/hooks/useTranslation'
import { useFocusRequest } from '@wegent/collaboration/dom-events'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { Button } from '@wegent/collaboration/markdown/Button'
import { Loader2 } from 'lucide-react'
import { useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { cloudModelCatalogSyncQueue } from './cloudModelCatalogSyncRequest'

export function CloudModelCatalogSyncDialogHost() {
  const { t } = useTranslation('common')
  const current = useSyncExternalStore(
    cloudModelCatalogSyncQueue.subscribe,
    cloudModelCatalogSyncQueue.getSnapshot
  )
  const cancelButton = useRef<HTMLButtonElement>(null)
  useFocusRequest(cancelButton, current?.id, { enabled: Boolean(current), preventScroll: true })
  const cancel = () => {
    if (current) cloudModelCatalogSyncQueue.cancel(current.id)
  }
  if (!current) return null
  const { syncing, failure } = current
  const error = failure
    ? failure.cause instanceof Error
      ? failure.cause.message
      : t('workbench.cloud_model_catalog_sync_failed')
    : null

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4">
      <DialogSurface
        onClose={() => {
          if (!syncing) cancel()
        }}
        initialFocus='[data-testid="cloud-model-catalog-sync-cancel-button"]'
        render={
          <div
            aria-labelledby="cloud-model-catalog-sync-title"
            data-testid="cloud-model-catalog-sync-dialog"
            className="w-full max-w-[420px] rounded-xl border border-border bg-popover p-5 shadow-xl"
          />
        }
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
          <Button
            ref={cancelButton}
            type="button"
            data-testid="cloud-model-catalog-sync-cancel-button"
            onClick={cancel}
            disabled={syncing}
            variant="ghost"
            size="sm"
          >
            {t('workbench.cloud_model_catalog_sync_cancel')}
          </Button>
          <Button
            type="button"
            data-testid="cloud-model-catalog-sync-confirm-button"
            onClick={() => void cloudModelCatalogSyncQueue.confirm(current.id)}
            disabled={syncing}
            variant="primary"
            size="sm"
          >
            {syncing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {t('workbench.cloud_model_catalog_sync_confirm')}
          </Button>
        </div>
      </DialogSurface>
    </div>,
    document.body
  )
}
