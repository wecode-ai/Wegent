import type {
  createLocalCodexPluginApi,
  LocalCodexHomeMigrationStatus,
} from '@/api/local/codexPlugins'

const DISMISSED_STORAGE_KEY = 'wework.plugins.codexMigrationDismissed'
interface Snapshot {
  status: LocalCodexHomeMigrationStatus | null
  checked: boolean
  checking: boolean
  isInitializing: boolean
  error: { cause: unknown } | null
}

/** The actual directory status and explicit initialization receipt own startup state. */
export function createCodexHomeInitializationSource(
  api: ReturnType<typeof createLocalCodexPluginApi>,
  skip: boolean
) {
  let snapshot: Snapshot = {
    status: null,
    checked: skip,
    checking: !skip,
    isInitializing: false,
    error: null,
  }
  let readRevision = 0
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<Snapshot>) => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of listeners) listener()
  }
  async function readStatus() {
    if (skip || snapshot.isInitializing) return
    const revision = ++readRevision
    publish({ checking: true, error: null })
    try {
      const status = await api.codexHomeMigrationStatus()
      if (revision !== readRevision || !listeners.size) return
      publish({
        status: status.shouldPromptMigration ? status : null,
        checked: true,
        checking: false,
        error: null,
      })
    } catch (cause) {
      if (revision !== readRevision || !listeners.size) return
      console.warn('[Wework Codex init] status check failed', cause)
      publish({ status: null, checked: true, checking: false, error: { cause } })
    }
  }
  return {
    getSnapshot: () => snapshot,
    refreshStatus: readStatus,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) void readStatus()
      return () => {
        listeners.delete(listener)
        if (!listeners.size) readRevision += 1
      }
    },
    async initialize(migrateNativeHome: boolean) {
      if (snapshot.isInitializing || snapshot.checking || !snapshot.checked || !snapshot.status)
        return
      readRevision += 1
      console.warn('[Wework Codex init] initialization requested', { migrateNativeHome })
      publish({ isInitializing: true, error: null })
      try {
        await api.initializeCodexHome({ migrateNativeHome, remoteAppsEnabled: true })
        console.warn('[Wework Codex init] initialization finished')
        try {
          if (typeof window !== 'undefined') window.localStorage.setItem(DISMISSED_STORAGE_KEY, '1')
        } catch (cause) {
          console.warn('[Wework Codex init] dismissal preference could not be saved', cause)
        }
        publish({ status: null, checked: true, error: null })
      } catch (cause) {
        console.warn('[Wework Codex init] initialization failed', cause)
        publish({ error: { cause } })
      } finally {
        publish({ isInitializing: false })
      }
    },
  }
}
