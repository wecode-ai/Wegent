import { createLocalAppServices } from '@/api/local/localServices'
import { listLocalModelConfigs } from '@/features/model-settings/localModelSettings'

export async function ensureLocalModelCatalogReady(): Promise<void> {
  // Fixture preparation owns catalog writes; the picker is a read-only consumer.
  await createLocalAppServices().runtimeWorkApi!.prepareRuntimeModel({ deviceId: 'local-device' })
  const pending = listLocalModelConfigs().filter(model => model.catalogEntry && !model.catalogReady)
  if (pending.length > 0) {
    throw new Error(
      `Local model catalog is not ready: ${pending.map(model => model.id).join(', ')}`
    )
  }
}
