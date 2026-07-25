import { useContext, useMemo, useSyncExternalStore } from 'react'
import type { RuntimeTaskAddress } from '@/types/api'
import { RuntimeTaskLifecycleContext } from './internalContext'
import { RuntimeTaskLifecycleStore, selectRuntimeTaskLifecycle } from './RuntimeTaskLifecycleStore'
import type { RuntimeTaskLifecycleSnapshot, RuntimeTaskLifecycleStoreSnapshot } from './types'

export function useRuntimeTaskLifecycleStore(): RuntimeTaskLifecycleStore {
  const store = useContext(RuntimeTaskLifecycleContext)
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
  const snapshot = useRuntimeTaskLifecycleStoreSnapshot()
  return useMemo(() => selectRuntimeTaskLifecycle(snapshot, address), [address, snapshot])
}
