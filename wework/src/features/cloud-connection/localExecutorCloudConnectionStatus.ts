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
let refreshRevision = 0
const listeners = new Set<() => void>()

export function setLocalExecutorCloudConnectionStatus(
  next: Omit<LocalExecutorCloudConnectionStatus, 'revision'>
): void {
  refreshRevision += 1
  status = { ...next, revision: status.revision + 1 }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getLocalExecutorCloudConnectionStatus(): LocalExecutorCloudConnectionStatus {
  return status
}

export function useLocalExecutorCloudConnectionStatus(): LocalExecutorCloudConnectionStatus {
  return useSyncExternalStore(
    subscribe,
    getLocalExecutorCloudConnectionStatus,
    getLocalExecutorCloudConnectionStatus
  )
}

export async function refreshLocalExecutorCloudConnectionStatus(
  apiBaseUrl: string
): Promise<{ configured?: boolean; connected: boolean } | null> {
  const revision = ++refreshRevision
  try {
    const response = await requestLocalExecutor<{
      configured?: boolean
      connected?: boolean
    }>('executor.backend.status')
    const connected = response.configured === true && response.connected === true
    if (revision !== refreshRevision) return null
    setLocalExecutorCloudConnectionStatus({ apiBaseUrl, connected })
    return { configured: response.configured, connected }
  } catch {
    if (revision === refreshRevision) {
      setLocalExecutorCloudConnectionStatus({ apiBaseUrl, connected: false })
    }
    return null
  }
}

export function resetLocalExecutorCloudConnectionStatus(): void {
  refreshRevision += 1
  status = EMPTY_STATUS
  for (const listener of listeners) listener()
}
