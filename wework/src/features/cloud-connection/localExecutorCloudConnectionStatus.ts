import { useSyncExternalStore } from 'react'
import { requestLocalExecutor } from '@/desktop/localExecutor'

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

export async function refreshLocalExecutorCloudConnectionStatus(
  apiBaseUrl: string
): Promise<boolean> {
  try {
    const response = await requestLocalExecutor<{
      configured?: boolean
      connected?: boolean
    }>('executor.backend.status')
    const connected = response.configured === true && response.connected === true
    setLocalExecutorCloudConnectionStatus({ apiBaseUrl, connected })
    return connected
  } catch {
    setLocalExecutorCloudConnectionStatus({ apiBaseUrl, connected: false })
    return false
  }
}

export function resetLocalExecutorCloudConnectionStatus(): void {
  status = EMPTY_STATUS
  for (const listener of listeners) listener()
}
