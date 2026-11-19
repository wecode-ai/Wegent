import { createAsyncResource } from '@wegent/chat-core/async-resource'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { ArchivedConversationItem } from '@/types/api'
import { listArchivedLocalHarnessSessions } from '@/lib/local-terminal'
import { itemAddressKey, localHarnessArchivedItem } from './archivedConversationItems'
import {
  hasArchivedBulkDeletedKey,
  hasArchivedCleanupFailedKey,
  subscribeArchivedBulkDeleteDeleted,
  subscribeArchivedCleanupError,
} from './archivedConversationsSettingsState'

interface ArchivedSnapshot {
  items: ArchivedConversationItem[]
  loading: boolean
  failure: { cause: unknown } | null
}

/** Keep independent archive sources visible while the page owns its reads and cleanup subscriptions. */
export function createArchivedConversationsResource(
  api: NonNullable<WorkbenchServices['runtimeWorkApi']>
) {
  const listeners = new Set<() => void>()
  const hidden = new Set<string>()
  let version = 0
  let runtimeItems: ArchivedConversationItem[] = [],
    harnessItems: ArchivedConversationItem[] = []
  let state: ArchivedSnapshot = { items: [], loading: true, failure: null }
  let stopQuery: (() => void) | undefined,
    stopDeleted: (() => void) | undefined,
    stopCleanup: (() => void) | undefined
  const publish = (patch: Partial<ArchivedSnapshot>) => {
    const next = { ...state, ...patch }
    state = {
      ...next,
      items: next.items.filter(
        item =>
          !hidden.has(itemAddressKey(item)) && !hasArchivedBulkDeletedKey(itemAddressKey(item))
      ),
    }
    listeners.forEach(listener => listener())
  }
  const readRuntime = async () => [...(await api.listArchivedConversations()).items]
  const readHarness = async () =>
    (await listArchivedLocalHarnessSessions()).map(localHarnessArchivedItem)
  const query = createAsyncResource('settings/archived-conversations', async signal => {
    let failure: ArchivedSnapshot['failure'] = null
    await Promise.allSettled([
      (async () => {
        try {
          const items = await readRuntime()
          if (signal.aborted) return
          runtimeItems = items
        } catch (cause) {
          if (signal.aborted) return
          failure = { cause }
        }
        if (!signal.aborted) publish({ items: [...runtimeItems, ...harnessItems], failure })
      })(),
      (async () => {
        try {
          const items = await readHarness()
          if (signal.aborted) return
          harnessItems = items
        } catch (cause) {
          if (signal.aborted) return
          failure = { cause }
        }
        if (!signal.aborted) publish({ items: [...runtimeItems, ...harnessItems], failure })
      })(),
    ])
    return { items: [...runtimeItems, ...harnessItems], failure }
  })
  const publishQuery = () => {
    const current = query.getSnapshot()
    if (current.status === 'loading') {
      version += 1
      publish({ loading: true, failure: null })
    } else if (current.status === 'ready' && current.data)
      publish({ ...current.data, loading: false })
    else if (current.status === 'error')
      publish({ loading: false, failure: { cause: current.error } })
  }
  return {
    getSnapshot: () => state,
    isActive: () => listeners.size > 0,
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) {
        stopDeleted = subscribeArchivedBulkDeleteDeleted(() => publish({}))
        stopCleanup = subscribeArchivedCleanupError(error => {
          if (!error) return
          for (const key of hidden) if (hasArchivedCleanupFailedKey(key)) hidden.delete(key)
          void query.reload()
        })
        stopQuery = query.subscribe(publishQuery)
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          stopDeleted?.()
          stopDeleted = undefined
          stopCleanup?.()
          stopCleanup = undefined
          stopQuery?.()
          stopQuery = undefined
        }
      }
    },
    reload: () => query.reload(),
    removeItem(item: ArchivedConversationItem) {
      if (!listeners.size) return
      version += 1
      hidden.add(itemAddressKey(item))
      publish({})
    },
    async fetchAll() {
      const startedVersion = version
      const [runtime, harness] = await Promise.all([readRuntime(), readHarness()])
      return { runtime, harness, items: [...runtime, ...harness], version: startedVersion }
    },
    applyVerifiedItems(
      items: ArchivedConversationItem[],
      verified: {
        runtime: ArchivedConversationItem[]
        harness: ArchivedConversationItem[]
        version: number
      }
    ) {
      if (!listeners.size || verified.version !== version) return
      version += 1
      const retained = new Set(items.map(itemAddressKey))
      runtimeItems = verified.runtime.filter(item => retained.has(itemAddressKey(item)))
      harnessItems = verified.harness.filter(item => retained.has(itemAddressKey(item)))
      query.update(() => ({ items, failure: null }))
    },
  }
}
