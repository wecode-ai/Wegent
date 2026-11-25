import { useCallback, useContext, useSyncExternalStore } from 'react'
import type { RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import { findRuntimeTask } from '@wegent/chat-core/runtime-task-lookup'
import { subscribeIdleResource } from '@wegent/chat-core/async-resource'
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
  explicitStore?: RuntimeTaskLifecycleStore,
  enabled = true
): RuntimeTaskLifecycleStoreSnapshot {
  const contextualStore = useContext(RuntimeTaskLifecycleContext)
  const store = explicitStore ?? contextualStore
  if (!store) {
    throw new Error('RuntimeTaskLifecycleProvider is required')
  }
  return useSyncExternalStore(
    enabled ? store.subscribe : subscribeIdleResource,
    store.getSnapshot,
    store.getSnapshot
  )
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

export function useRuntimeTaskSidebarSnapshot() {
  const store = useContext(RuntimeTaskLifecycleContext)
  if (!store) throw new Error('RuntimeTaskLifecycleProvider is required')
  return useSyncExternalStore(store.subscribe, store.getSidebarSnapshot, store.getSidebarSnapshot)
}

export function useRuntimeTaskLifecycle(
  address: RuntimeTaskAddress | null | undefined
): RuntimeTaskLifecycleSnapshot | null {
  const store = useContext(RuntimeTaskLifecycleContext)
  if (!store) throw new Error('RuntimeTaskLifecycleProvider is required')
  const getSnapshot = useCallback(
    () => store.selectTask(store.getSnapshot(), address),
    [address, store]
  )
  const subscribe = useCallback(
    (listener: () => void) =>
      address ? store.subscribeTask(address, listener) : subscribeIdleResource(),
    [address, store]
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useRuntimeTaskSummaryResolver(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  explicitStore?: RuntimeTaskLifecycleStore
) {
  const contextualStore = useContext(RuntimeTaskLifecycleContext)
  const store = explicitStore ?? contextualStore
  if (!store) throw new Error('RuntimeTaskLifecycleProvider is required')
  return useCallback(
    (address: RuntimeTaskAddress | null | undefined) =>
      findRuntimeTask(runtimeWork, address) ??
      store.selectTask(store.getSnapshot(), address)?.task ??
      null,
    [runtimeWork, store]
  )
}
