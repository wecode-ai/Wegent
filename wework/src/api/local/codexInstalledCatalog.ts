import { createRequestCache } from '@wegent/chat-core/request-cache'

export class ExpiredPluginInventoryRequest extends Error {
  constructor() {
    super('Plugin inventory changed while reading installed plugins')
    this.name = 'ExpiredPluginInventoryRequest'
  }
}

export interface InstalledCatalogScope {
  deviceId: string
  runtimeInstanceId?: string
  account: string | null
  revision: string
}

/** Share one identity and revision; callers may reuse a recent read when composing a catalog. */
export function createVersionedInstalledCatalog<T>(revision: () => string) {
  let identity: string | undefined
  let epoch = 0
  const cache = createRequestCache(() => epoch)

  const invalidate = () => {
    identity = undefined
    epoch += 1
    cache.invalidate()
  }

  const read = (scope: InstalledCatalogScope, load: () => Promise<T>, maxAgeMs = 0): Promise<T> => {
    if (scope.revision !== revision()) return Promise.reject(new ExpiredPluginInventoryRequest())
    const key = JSON.stringify([
      scope.deviceId,
      scope.runtimeInstanceId,
      scope.account,
      scope.revision,
    ])
    if (identity !== key) {
      invalidate()
      identity = key
    }
    const admittedEpoch = epoch
    const assertCurrent = () => {
      if (admittedEpoch !== epoch || scope.revision !== revision())
        throw new ExpiredPluginInventoryRequest()
    }
    return cache.get(
      'plugin/installed',
      async () => {
        assertCurrent()
        const result = await load()
        assertCurrent()
        return result
      },
      maxAgeMs
    )
  }

  return { read, invalidate }
}
