import { createRequestCache } from '@wegent/chat-core/request-cache'
import { ExpiredPluginInventoryRequest } from './codexInstalledCatalog'

export interface PluginDetailReadOptions {
  version?: string
  refresh?: boolean
}

/** Reuse presentation data within one verified account/device/mutation scope. */
export function createPluginDetailCache<T>() {
  let identity: string | undefined
  let epoch = 0
  const cache = createRequestCache(() => epoch)
  const revisions = new Map<string, number>()
  const pending = new Map<string, { force: boolean; promise: Promise<T> }>()
  const invalidate = () => {
    epoch += 1
    cache.invalidate()
    revisions.clear()
    pending.clear()
  }
  const read = (scope: string, key: string, load: () => Promise<T>, force = false) => {
    if (identity !== scope) {
      invalidate()
      identity = scope
    }
    const previous = pending.get(key)
    if (previous && (!force || previous.force)) return previous.promise
    if (force) {
      cache.invalidate(key)
      revisions.set(key, (revisions.get(key) ?? 0) + 1)
    }
    const admittedEpoch = epoch
    const revision = revisions.get(key)
    const promise = cache.get(
      key,
      async () => {
        const result = await load()
        if (epoch !== admittedEpoch || revisions.get(key) !== revision)
          throw new ExpiredPluginInventoryRequest()
        return result
      },
      60_000
    )
    const entry = { force, promise }
    pending.set(key, entry)
    const settled = () => {
      if (pending.get(key) === entry) pending.delete(key)
    }
    void promise.then(settled, settled)
    return promise
  }
  return { read, invalidate }
}
