import { createLocalAppServices } from '@/api/local/localServices'
import { listLocalModelConfigs } from '@/features/model-settings/localModelSettings'
import { waitForDesktopE2ELocalModelSeed } from './automation'

export async function ensureLocalModelCatalogReady(): Promise<void> {
  // Reconnection precedes fixture migration after reload; reconcile its final snapshot.
  await waitForDesktopE2ELocalModelSeed()
  // Fixture preparation owns catalog writes; the picker is a read-only consumer.
  await createLocalAppServices().runtimeWorkApi!.prepareRuntimeModel({ deviceId: 'local-device' })
  const pending = listLocalModelConfigs().filter(model => model.catalogEntry && !model.catalogReady)
  if (pending.length > 0) {
    throw new Error(
      `Local model catalog is not ready: ${pending.map(model => model.id).join(', ')}`
    )
  }
}
