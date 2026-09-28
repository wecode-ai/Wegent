import type { ComposerCatalogStore } from './useComposerCatalog'

/** A host/task-scoped catalog, never a process-wide cache of another device's apps. */
export function createComposerCatalogStore<App>(): ComposerCatalogStore<App> {
  let apps: App[] = []
  const listeners = new Set<() => void>()
  const replace = (next: App[]) => {
    if (apps === next) return
    apps = next
    listeners.forEach(listener => listener())
  }
  return {
    get: () => apps,
    readSnapshot: () => apps,
    publish: replace,
    replace,
    subscribe: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    suppressSync: () => false,
  }
}
