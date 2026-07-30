import { Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '@/hooks/useTranslation'
import {
  CLOUD_MODEL_CATALOG_SYNC_EVENT,
  type PendingCloudModelCatalogSync,
} from './cloudModelCatalogSyncRequest'

export function CloudModelCatalogSyncDialogHost() {
  const { t } = useTranslation('common')
  const [queue, setQueue] = useState<PendingCloudModelCatalogSync[]>([])
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const current = queue[0] ?? null

  useEffect(() => {
    const handleRequest = (event: Event) => {
      const request = (event as CustomEvent<PendingCloudModelCatalogSync>).detail
      if (!request) return
      setError(null)
      setQueue(previous => [...previous, request])
    }
    window.addEventListener(CLOUD_MODEL_CATALOG_SYNC_EVENT, handleRequest)
    return () => window.removeEventListener(CLOUD_MODEL_CATALOG_SYNC_EVENT, handleRequest)
  }, [])

  if (!current) return null

  const settle = (confirmed: boolean) => {
    current.resolve(confirmed)
    setError(null)
    setQueue(previous => previous.slice(1))
  }

  const handleSync = async () => {
    setSyncing(true)
    setError(null)
    try {
      await current.sync()
      settle(true)
    } catch (syncError) {
      setError(
        syncError instanceof Error
          ? syncError.message
          : t('workbench.cloud_model_catalog_sync_failed')
      )
    } finally {
      setSyncing(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloud-model-catalog-sync-title"
        data-testid="cloud-model-catalog-sync-dialog"
        className="w-full max-w-[420px] rounded-xl border border-border bg-popover p-5 shadow-xl"
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
            className="mt-3 text-sm text-red-500"
          >
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            data-testid="cloud-model-catalog-sync-cancel-button"
            onClick={() => settle(false)}
            disabled={syncing}
            className="h-8 rounded-md px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary disabled:opacity-50"
          >
            {t('workbench.cloud_model_catalog_sync_cancel')}
          </button>
          <button
            type="button"
            data-testid="cloud-model-catalog-sync-confirm-button"
            onClick={() => void handleSync()}
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
