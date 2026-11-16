import { useCallback, useContext, useSyncExternalStore } from 'react'
import type { RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import { findRuntimeTask } from '@wegent/chat-core/runtime-task-lookup'
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

export function useRuntimeTaskLifecycleResolver(explicitStore?: RuntimeTaskLifecycleStore) {
  const contextualStore = useContext(RuntimeTaskLifecycleContext)
  const store = explicitStore ?? contextualStore
  if (!store) {
    throw new Error('RuntimeTaskLifecycleProvider is required')
  }
  const snapshot = useRuntimeTaskLifecycleStoreSnapshot(store)
  return useCallback(
    (address: RuntimeTaskAddress | null | undefined) => store.selectTask(snapshot, address),
    [snapshot, store]
  )
}

export function useRuntimeTaskLifecycle(
  address: RuntimeTaskAddress | null | undefined
): RuntimeTaskLifecycleSnapshot | null {
  return useRuntimeTaskLifecycleResolver()(address)
}

export function useRuntimeTaskSummaryResolver(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  explicitStore?: RuntimeTaskLifecycleStore
) {
  const resolve = useRuntimeTaskLifecycleResolver(explicitStore)
  return useCallback(
    (address: RuntimeTaskAddress | null | undefined) =>
      findRuntimeTask(runtimeWork, address) ?? resolve(address)?.task ?? null,
    [runtimeWork, resolve]
  )
}
