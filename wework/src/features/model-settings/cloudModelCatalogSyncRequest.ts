export interface CloudModelCatalogSyncRequest {
  deviceId: string
  deviceName: string
  modelName: string
  sync: () => Promise<void>
}

interface PendingSync {
  id: number
  request: CloudModelCatalogSyncRequest
  resolve: (confirmed: boolean) => void
  syncing: boolean
  failure: { cause: unknown } | null
}

interface CloudModelCatalogSyncSnapshot {
  id: number
  deviceName: string
  modelName: string
  syncing: boolean
  failure: { cause: unknown } | null
}

/** Own explicit sync confirmations and keep already-confirmed work alive when its host closes. */
export function createCloudModelCatalogSyncQueue() {
  const listeners = new Set<() => void>()
  let queue: PendingSync[] = []
  let sequence = 0
  let snapshot: CloudModelCatalogSyncSnapshot | null = null
  const publish = () => {
    const current = queue[0]
    snapshot = current
      ? {
          id: current.id,
          deviceName: current.request.deviceName,
          modelName: current.request.modelName,
          syncing: current.syncing,
          failure: current.failure,
        }
      : null
    listeners.forEach(listener => listener())
  }
  const settle = (entry: PendingSync, confirmed: boolean) => {
    queue = queue.filter(candidate => candidate !== entry)
    entry.resolve(confirmed)
    publish()
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        const abandoned = queue.filter(entry => !entry.syncing)
        queue = queue.filter(entry => entry.syncing)
        for (const entry of abandoned) entry.resolve(false)
        publish()
      }
    },
    request(request: CloudModelCatalogSyncRequest): Promise<boolean> {
      if (!listeners.size) return Promise.resolve(false)
      return new Promise(resolve => {
        queue.push({
          id: ++sequence,
          request: { ...request },
          resolve,
          syncing: false,
          failure: null,
        })
        publish()
      })
    },
    cancel(id: number) {
      const entry = queue[0]
      if (entry?.id === id && !entry.syncing) settle(entry, false)
    },
    async confirm(id: number) {
      const entry = queue[0]
      if (entry?.id !== id || entry.syncing) return
      entry.syncing = true
      entry.failure = null
      publish()
      try {
        await entry.request.sync()
        settle(entry, true)
      } catch (cause) {
        entry.syncing = false
        entry.failure = { cause }
        if (listeners.size) publish()
        else settle(entry, false)
      }
    },
  }
}

export const cloudModelCatalogSyncQueue = createCloudModelCatalogSyncQueue()

export function requestCloudModelCatalogSync(
  request: CloudModelCatalogSyncRequest
): Promise<boolean> {
  return cloudModelCatalogSyncQueue.request(request)
}
