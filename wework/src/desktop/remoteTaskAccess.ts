import { requestDshExecutor } from '@/api/dsh/executorTransport'

export interface RemoteTaskAccessSettings {
  enabled: boolean
}

export function getRemoteTaskAccess(): Promise<RemoteTaskAccessSettings> {
  return requestDshExecutor('executor.remote_task_access.get', {})
}

export function setRemoteTaskAccess(enabled: boolean): Promise<RemoteTaskAccessSettings> {
  return requestDshExecutor('executor.remote_task_access.update', { enabled })
}
