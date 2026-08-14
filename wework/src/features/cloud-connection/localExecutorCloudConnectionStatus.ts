import { useSyncExternalStore } from 'react'

export interface LocalExecutorCloudConnectionStatus {
  apiBaseUrl: string
  connected: boolean
  revision: number
}

const EMPTY_STATUS: LocalExecutorCloudConnectionStatus = {
  apiBaseUrl: '',
  connected: false,
  revision: 0,
}

let status = EMPTY_STATUS
const listeners = new Set<() => void>()

export function setLocalExecutorCloudConnectionStatus(
  next: Omit<LocalExecutorCloudConnectionStatus, 'revision'>
): void {
  status = { ...next, revision: status.revision + 1 }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): LocalExecutorCloudConnectionStatus {
  return status
}

export function useLocalExecutorCloudConnectionStatus(): LocalExecutorCloudConnectionStatus {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function resetLocalExecutorCloudConnectionStatus(): void {
  status = EMPTY_STATUS
  for (const listener of listeners) listener()
}
