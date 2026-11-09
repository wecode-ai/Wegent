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
type ExecutorBackendStatus = {
  configured?: boolean
  connected: boolean
  explicitly_disconnected?: boolean
} | null
let pendingRefresh: {
  apiBaseUrl: string
  revision: number
  promise: Promise<ExecutorBackendStatus>
} | null = null
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

export function refreshLocalExecutorCloudConnectionStatus(
  apiBaseUrl: string
): Promise<ExecutorBackendStatus> {
  if (pendingRefresh?.apiBaseUrl === apiBaseUrl && pendingRefresh.revision === refreshRevision) {
    return pendingRefresh.promise
  }
  const revision = ++refreshRevision
  const promise = readLocalExecutorCloudConnectionStatus(apiBaseUrl, revision)
  pendingRefresh = { apiBaseUrl, revision, promise }
  void promise.finally(() => {
    if (pendingRefresh?.promise === promise) pendingRefresh = null
  })
  return promise
}

async function readLocalExecutorCloudConnectionStatus(
  apiBaseUrl: string,
  revision: number
): Promise<ExecutorBackendStatus> {
  try {
    const response = await requestLocalExecutor<{
      configured?: boolean
      connected?: boolean
      explicitly_disconnected?: boolean
    }>('executor.backend.status')
    const connected = response.configured === true && response.connected === true
    if (revision !== refreshRevision) return null
    setLocalExecutorCloudConnectionStatus({ apiBaseUrl, connected })
    return {
      configured: response.configured,
      connected,
      ...(response.explicitly_disconnected === true ? { explicitly_disconnected: true } : {}),
    }
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
