import { join } from 'node:path'
import { optionalText, type ReleaseStore } from './release-store.js'
import { restoreReleaseData } from './release-snapshot.js'

export async function settleReleaseBeforeStartup(
  store: ReleaseStore,
  dataDirectory: string,
  confirmRestore: () => Promise<boolean>,
  installerTakeover = false
): Promise<boolean> {
  const activation = await store.activation()
  if (!activation) return true
  const marker = async (name: string) =>
    (await optionalText(join(store.root, name))) === activation.token
  const attempted = installerTakeover || (await marker('attempted'))
  const healthy = attempted && (await marker('healthy'))
  if (!activation.rollbackRequested && healthy) {
    await store.confirm(activation.to)
    return true
  }
  if (
    !installerTakeover &&
    !activation.rollbackRequested &&
    !(attempted && (await marker('failed')))
  )
    return true
  if (
    activation.restoreRequired &&
    (activation.rollbackRequested || (await marker('data-opened')))
  ) {
    if (!activation.rollbackRequested && !(await confirmRestore())) return false
    await restoreReleaseData(
      dataDirectory,
      store.root,
      activation.snapshot,
      process.env.WEGENT_EXECUTOR_HOME?.trim() || dataDirectory
    )
  }
  await store.rollback({ installerTakeover })
  return true
}
