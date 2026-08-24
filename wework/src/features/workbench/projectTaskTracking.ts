import type { RuntimeTaskAddress } from '@/types/api'
import type { WorkbenchServices } from './workbenchServices'

export function projectTaskTrackingApi(services: WorkbenchServices, address: RuntimeTaskAddress) {
  const apis = services.projectSpaceApis
  if (!apis) return null
  const handle = address.runtimeHandle
  const origin =
    handle?.origin && typeof handle.origin === 'object'
      ? (handle.origin as Record<string, unknown>)
      : null
  const projectStore =
    handle?.projectStore ?? handle?.project_store ?? origin?.projectStore ?? origin?.project_store
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
