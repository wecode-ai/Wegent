import type { LocalConnectorAuthTarget } from '@/api/local/localConnectorAuth'

interface PendingLocalAuth {
  target: LocalConnectorAuthTarget
  purpose: 'install' | 'manage'
  title: string
  description?: string
  resolve(): void
  reject(error: Error): void
}
export const marketplaceUninstallOperationKey = (id: string | number) =>
  JSON.stringify(['marketplace-uninstall', String(id)])

export function createPluginWorkspaceOperations(key: string) {
  let snapshot: {
    installingMarketplacePluginIds: Set<string | number>
    uninstallingPluginIds: Set<string>
    updatingPluginPolicyIds: Set<string | number>
    connectorActionSlug: string | null
    connectorAuthRevision: number
    pendingLocalConnectorAuth: PendingLocalAuth | null
  } = {
    installingMarketplacePluginIds: new Set(),
    uninstallingPluginIds: new Set(),
    updatingPluginPolicyIds: new Set(),
    connectorActionSlug: null,
    connectorAuthRevision: 0,
    pendingLocalConnectorAuth: null,
  }
  const preparing = new Set<string | number>()
  const observers = new Set<() => void>()
  let generation = 0
  const publish = (patch: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...patch }
    observers.forEach(listener => listener())
  }
  return {
    key,
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      observers.add(listener)
      return () => {
        observers.delete(listener)
        queueMicrotask(() => {
          if (!observers.size) {
            generation += 1
            preparing.clear()
            snapshot.pendingLocalConnectorAuth?.reject(new Error('Plugin scope changed'))
            publish({
              installingMarketplacePluginIds: new Set(),
              uninstallingPluginIds: new Set(),
              updatingPluginPolicyIds: new Set(),
              connectorActionSlug: null,
            })
          }
        })
      }
    },
    isPreparing: (id: string | number) => preparing.has(id),
    reservePreparation(id: string | number) {
      preparing.add(id)
    },
    releasePreparation(id: string | number) {
      preparing.delete(id)
    },
    beginInstall(id: string | number) {
      publish({
        installingMarketplacePluginIds: new Set(snapshot.installingMarketplacePluginIds).add(id),
      })
    },
    finishInstall(id: string | number) {
      const next = new Set(snapshot.installingMarketplacePluginIds)
      next.delete(id)
      publish({ installingMarketplacePluginIds: next })
    },
    beginUninstall(id: string | number, marketplaceItemId?: string | number) {
      const next = new Set(snapshot.uninstallingPluginIds).add(String(id))
      if (marketplaceItemId !== undefined)
        next.add(marketplaceUninstallOperationKey(marketplaceItemId))
      publish({ uninstallingPluginIds: next })
    },
    finishUninstall(id: string | number, marketplaceItemId?: string | number) {
      const next = new Set(snapshot.uninstallingPluginIds)
      next.delete(String(id))
      if (marketplaceItemId !== undefined)
        next.delete(marketplaceUninstallOperationKey(marketplaceItemId))
      publish({ uninstallingPluginIds: next })
    },
    beginPolicy(id: string | number) {
      publish({ updatingPluginPolicyIds: new Set(snapshot.updatingPluginPolicyIds).add(id) })
    },
    finishPolicy(id: string | number) {
      const next = new Set(snapshot.updatingPluginPolicyIds)
      next.delete(id)
      publish({ updatingPluginPolicyIds: next })
    },
    beginConnector(slug: string) {
      if (snapshot.connectorActionSlug !== null) return null
      const token = ++generation
      publish({
        connectorActionSlug: slug,
        connectorAuthRevision: snapshot.connectorAuthRevision + 1,
      })
      return token
    },
    finishConnector(token: number) {
      if (token !== generation) return
      publish({
        connectorActionSlug: null,
        connectorAuthRevision: snapshot.connectorAuthRevision + 1,
      })
    },
    promptLocalAuth(input: Omit<PendingLocalAuth, 'resolve' | 'reject'>) {
      return new Promise<void>((resolve, reject) => {
        snapshot.pendingLocalConnectorAuth?.reject(new Error('Connector authorization superseded'))
        const pending: PendingLocalAuth = {
          ...input,
          resolve() {
            if (snapshot.pendingLocalConnectorAuth === pending)
              publish({ pendingLocalConnectorAuth: null })
            resolve()
          },
          reject(error) {
            if (snapshot.pendingLocalConnectorAuth === pending)
              publish({ pendingLocalConnectorAuth: null })
            reject(error)
          },
        }
        publish({ pendingLocalConnectorAuth: pending })
      })
    },
    dismissLocalAuth(pending: PendingLocalAuth | null) {
      if (pending && snapshot.pendingLocalConnectorAuth === pending)
        publish({ pendingLocalConnectorAuth: null })
    },
  }
}
