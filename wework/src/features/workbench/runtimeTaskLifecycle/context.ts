import { useContext, useSyncExternalStore } from 'react'
import type { RuntimeTaskAddress } from '@/types/api'
import { RuntimeTaskLifecycleContext, RuntimeTaskLifecycleWriterContext } from './internalContext'
import { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'
import type { RuntimeTaskLifecycleSnapshot, RuntimeTaskLifecycleStoreSnapshot } from './types'

export function useRuntimeTaskLifecycleStore(): RuntimeTaskLifecycleStore {
  const store = useContext(RuntimeTaskLifecycleWriterContext)
  if (!store) {
    throw new Error('RuntimeTaskLifecycleProvider is required')
  }
  return store
}

export function useRuntimeTaskLifecycleStoreSnapshot(
  explicitStore?: RuntimeTaskLifecycleStore
): RuntimeTaskLifecycleStoreSnapshot {
  const contextualStore = useContext(RuntimeTaskLifecycleContext)
  const store = explicitStore ?? contextualStore
  if (!store) {
    throw new Error('RuntimeTaskLifecycleProvider is required')
  }
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

export function useRuntimeTaskLifecycle(
  address: RuntimeTaskAddress | null | undefined
): RuntimeTaskLifecycleSnapshot | null {
  const store = useContext(RuntimeTaskLifecycleContext)
  if (!store) {
    throw new Error('RuntimeTaskLifecycleProvider is required')
  }
  const snapshot = useRuntimeTaskLifecycleStoreSnapshot(store)
  return store.selectTask(snapshot, address)
}
