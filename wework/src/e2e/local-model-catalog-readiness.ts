import { createLocalAppServices } from '@/api/local/localServices'
import { listLocalModelConfigs } from '@/features/model-settings/localModelSettings'

export async function ensureLocalModelCatalogReady(): Promise<void> {
  // Use the same reconciliation promise as the picker, including its app-server restart.
  await createLocalAppServices().modelApi.listModels()
  const pending = listLocalModelConfigs().filter(model => model.catalogEntry && !model.catalogReady)
  if (pending.length > 0) {
    throw new Error(
      `Local model catalog is not ready: ${pending.map(model => model.id).join(', ')}`
    )
  }
}
