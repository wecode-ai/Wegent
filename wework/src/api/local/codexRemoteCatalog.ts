import { createRequestCache } from '@wegent/chat-core/request-cache'
import { raceWithTimeout } from '@/lib/promise-timeout'

export const REMOTE_PLUGIN_CATALOG_FRESH_MS = 60_000

/** Catalog metadata has its own lifetime, independent of installation mutations. */
export function createSharedRemotePluginCatalog<T>() {
  let identity: string | undefined
  let epoch = 0
  let pending: { force: boolean; promise: Promise<T> } | undefined
  const cache = createRequestCache(() => epoch)

  const invalidate = () => {
    epoch += 1
    pending = undefined
    cache.invalidate()
  }

  const read = (scope: string, force: boolean, load: () => Promise<T>): Promise<T> => {
    if (identity !== scope) {
      invalidate()
      identity = scope
    }
    if (pending && (!force || pending.force)) return pending.promise
    if (force) invalidate()
    const revision = epoch
    const promise = cache
      .get(
        'official-catalog',
        () => {
          if (epoch !== revision) throw new Error('Plugin catalog scope changed')
          return raceWithTimeout(load(), 30_000, () => new Error('Remote plugin catalog timed out'))
        },
        force ? 0 : REMOTE_PLUGIN_CATALOG_FRESH_MS
      )
      .then(result => {
        if (epoch !== revision) throw new Error('Plugin catalog scope changed')
        return result
      })
    const entry = { force, promise }
    pending = entry
    const settled = () => {
      if (pending === entry) pending = undefined
    }
    void promise.then(settled, settled)
    return promise
  }

  return { read, invalidate }
}
