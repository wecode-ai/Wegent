import { useCallback, useContext, useSyncExternalStore } from 'react'
import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/with-selector'
import type { RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/api'
import { findRuntimeTask } from '@wegent/chat-core/runtime-task-lookup'
import { RuntimeTaskLifecycleContext, RuntimeTaskLifecycleWriterContext } from './internalContext'
import { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'
import type {
  RuntimeTaskLifecycleSnapshot,
  RuntimeTaskLifecycleStoreSnapshot,
  RuntimeTaskSidebarStatus,
} from './types'

export function useRuntimeTaskLifecycleStore(): RuntimeTaskLifecycleStore {
  const store = useContext(RuntimeTaskLifecycleWriterContext)
  if (!store) {
    throw new Error('RuntimeTaskLifecycleProvider is required')
  }
  return store
}

function useLifecycleReadStore(explicitStore?: RuntimeTaskLifecycleStore) {
  const contextualStore = useContext(RuntimeTaskLifecycleContext)
  const store = explicitStore ?? contextualStore
  if (!store) {
    throw new Error('RuntimeTaskLifecycleProvider is required')
  }
  return store
}

export function useRuntimeTaskLifecycleStoreSnapshot(
  explicitStore?: RuntimeTaskLifecycleStore
): RuntimeTaskLifecycleStoreSnapshot {
  const store = useLifecycleReadStore(explicitStore)
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

export function useRuntimeTaskSidebarStatus(): RuntimeTaskSidebarStatus {
  const store = useLifecycleReadStore()
  return useSyncExternalStore(store.subscribe, store.getSidebarStatus, store.getSidebarStatus)
}

export function useRuntimeTaskLifecycleResolver(explicitStore?: RuntimeTaskLifecycleStore) {
  const store = useLifecycleReadStore(explicitStore)
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  return useCallback(
    (address: RuntimeTaskAddress | null | undefined) => store.selectTask(snapshot, address),
    [snapshot, store]
  )
}

function useRuntimeTaskSnapshotSource(address: RuntimeTaskAddress | null | undefined) {
  const store = useLifecycleReadStore()
  const taskId = address?.taskId
  const subscribe = useCallback(
    (listener: () => void) => (taskId == null ? () => {} : store.subscribeTask(taskId, listener)),
    [store, taskId]
  )
  const getSnapshot = useCallback(
    () => store.selectTask(store.getSnapshot(), address),
    [address, store]
  )
  return { subscribe, getSnapshot }
}

export function useRuntimeTaskLifecycle(
  address: RuntimeTaskAddress | null | undefined
): RuntimeTaskLifecycleSnapshot | null {
  const { subscribe, getSnapshot } = useRuntimeTaskSnapshotSource(address)
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useRuntimeTaskLifecycleSelection<T>(
  address: RuntimeTaskAddress | null | undefined,
  select: (snapshot: RuntimeTaskLifecycleSnapshot | null) => T,
  isEqual: (left: T, right: T) => boolean
): T {
  const { subscribe, getSnapshot } = useRuntimeTaskSnapshotSource(address)
  return useSyncExternalStoreWithSelector(subscribe, getSnapshot, getSnapshot, select, isEqual)
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
