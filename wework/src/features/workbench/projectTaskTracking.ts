import type { CloudLoopItem, TaskExecutionStatus } from '@/api/deliveries'
import { publishProjectSpaceTaskContextChanged } from '@/features/todo/projectSpaceSelection'
import type { RuntimeTaskAddress } from '@/types/api'
import type { RuntimeTaskLifecycleSnapshot } from './runtimeTaskLifecycle'
import { runtimeTaskTrackingExecutionStatus } from './runtimeTaskLifecycle/projection'
import type { WorkbenchServices } from './workbenchServices'

const projectStoreByRuntimeTask = new Map<string, 'backend' | 'local'>()

function runtimeTaskKey(address: RuntimeTaskAddress) {
  return `${address.deviceId}:${address.taskId}`
}

export function rememberProjectTaskStore(
  address: RuntimeTaskAddress,
  projectStore: 'backend' | 'local'
) {
  const key = runtimeTaskKey(address)
  if (projectStoreByRuntimeTask.get(key) === projectStore) return false
  projectStoreByRuntimeTask.set(key, projectStore)
  return true
}

export function runtimeTaskTrackingStatus(
  lifecycle: RuntimeTaskLifecycleSnapshot
): TaskExecutionStatus | null {
  return runtimeTaskTrackingExecutionStatus(lifecycle)
}

export function projectTaskTrackingApi(services: WorkbenchServices, address: RuntimeTaskAddress) {
  const apis = services.projectSpaceApis
  if (!apis) return null
  const handle = address.runtimeHandle
  const origin =
    handle?.origin && typeof handle.origin === 'object'
      ? (handle.origin as Record<string, unknown>)
      : null
  const projectStore =
    handle?.projectStore ??
    handle?.project_store ??
    origin?.projectStore ??
    origin?.project_store ??
    projectStoreByRuntimeTask.get(runtimeTaskKey(address))
  const location =
    projectStore === 'backend'
      ? 'cloud'
      : projectStore === 'local'
        ? 'local'
        : apis.defaultLocation === 'cloud'
          ? 'cloud'
          : 'local'
  return apis[location] ?? null
}

export async function reconcileProjectTaskTrackingStatus(
  services: WorkbenchServices,
  address: RuntimeTaskAddress,
  executionStatus: TaskExecutionStatus
): Promise<CloudLoopItem | null> {
  const api = projectTaskTrackingApi(services, address)
  if (!api) return null
  const item = await api.updateTaskTrackingStatus(address, executionStatus)
  if (item) publishProjectSpaceTaskContextChanged(address)
  return item
}
