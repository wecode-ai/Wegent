interface Entry {
  value?: unknown
  loadedAt?: number
  pending?: Promise<unknown>
}

const clients = new WeakMap<object, ReturnType<typeof createRequestCache>>()

/** Share identical reads and invalidation across API adapters using one transport. */
export function getClientRequestCache(client: { getCacheScope?(): unknown }) {
  let cache = clients.get(client)
  if (!cache) {
    cache = createRequestCache(() => client.getCacheScope?.())
    clients.set(client, cache)
  }
  return cache
}

/** Successful reads belong to one client session; failures are never cached. */
export function createRequestCache(scope: () => unknown = () => undefined) {
  const entries = new Map<string, Entry>()
  let currentScope = scope()

  function synchronize() {
    const nextScope = scope()
    if (nextScope !== currentScope) {
      entries.clear()
      currentScope = nextScope
    }
  }

  return {
    get<T>(key: string, load: () => Promise<T>, maxAgeMs = 60_000): Promise<T> {
      synchronize()
      const previous = entries.get(key)
      if (previous?.pending) return previous.pending as Promise<T>
      if (previous?.loadedAt !== undefined && Date.now() - previous.loadedAt < maxAgeMs) {
        return Promise.resolve(previous.value as T)
      }
      const entry: Entry = { value: previous?.value }
      entries.set(key, entry)
      const pending = Promise.resolve()
        .then(load)
        .then(
          value => {
            synchronize()
            if (entries.get(key) === entry) {
              entry.value = value
              entry.loadedAt = Date.now()
              entry.pending = undefined
            }
            return value
          },
          error => {
            if (entries.get(key) === entry) entries.delete(key)
            throw error
          }
        )
      entry.pending = pending
      return pending
    },
    invalidate(prefix = '') {
      synchronize()
      for (const key of entries.keys()) {
        if (key.startsWith(prefix)) entries.delete(key)
      }
    },
  }
}
