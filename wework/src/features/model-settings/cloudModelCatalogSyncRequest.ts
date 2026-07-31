export const CLOUD_MODEL_CATALOG_SYNC_EVENT = 'wework:cloud-model-catalog-sync-requested'

export interface CloudModelCatalogSyncRequest {
  deviceId: string
  deviceName: string
  modelName: string
  sync: () => Promise<void>
}

export interface PendingCloudModelCatalogSync extends CloudModelCatalogSyncRequest {
  resolve: (confirmed: boolean) => void
}

export function requestCloudModelCatalogSync(
  request: CloudModelCatalogSyncRequest
): Promise<boolean> {
  return new Promise(resolve => {
    window.dispatchEvent(
      new CustomEvent<PendingCloudModelCatalogSync>(CLOUD_MODEL_CATALOG_SYNC_EVENT, {
        detail: { ...request, resolve },
      })
    )
  })
}
