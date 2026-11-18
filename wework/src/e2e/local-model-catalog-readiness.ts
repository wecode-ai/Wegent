import { createLocalAppServices } from '@/api/local/localServices'
import { listLocalModelConfigs } from '@/features/model-settings/localModelSettings'

const CATALOG_READY_TIMEOUT_MS = 20_000
const CATALOG_READY_RETRY_MS = 100

export async function ensureLocalModelCatalogReady({
  timeoutMs = CATALOG_READY_TIMEOUT_MS,
}: { timeoutMs?: number } = {}): Promise<void> {
  // Fixture preparation owns catalog writes; the picker is a read-only consumer.
  const runtimeWorkApi = createLocalAppServices().runtimeWorkApi!
  const deadline = Date.now() + timeoutMs
  while (true) {
    await runtimeWorkApi.prepareRuntimeModel({ deviceId: 'local-device' })
    const pending = listLocalModelConfigs().filter(
      model => model.catalogEntry && !model.catalogReady
    )
    if (pending.length === 0) return
    if (Date.now() >= deadline) {
      throw new Error(
        `Local model catalog is not ready: ${pending.map(model => model.id).join(', ')}`
      )
    }
    // Provider revisions can arrive while startup reconciliation is running.
    // Wait for another pass so the control observes the settled catalog.
    await new Promise(resolve => setTimeout(resolve, CATALOG_READY_RETRY_MS))
  }
}
