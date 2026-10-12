import {
  buildRuntimeRemoteProjectStateId,
  getRuntimeProjectSyncTarget,
  runtimeProjectTargetKey,
  type RuntimeProjectSyncTarget,
} from './runtime-project-identity'
import { createWorkbenchDeviceResolver, type WorkbenchDeviceResolver } from './workbench-device'
import type {
  DeviceInfo,
  RuntimeProjectActivateRequest,
  RuntimeProjectRef,
  RuntimeProjectReorderRequest,
  RuntimeProjectWork,
  RuntimeRemoteProjectRegistration,
  RuntimeWorkListResponse,
} from '@/types/api'
import { runtimeProjectUiId } from './runtime-project'

export function getLocalRuntimeStateDeviceId(devices: DeviceInfo[]): string | null {
  const localDevices = devices.filter(device => device.device_type === 'local')
  return (
    localDevices.find(device => device.status === 'online' || device.status === 'busy')
      ?.device_id ??
    localDevices[0]?.device_id ??
    null
  )
}

export function getRuntimeProjectSidebarStateKey(project: RuntimeProjectRef): string {
  return project.sidebarStateKey?.trim() || project.key
}

export function getRuntimeRemoteProjectRegistrations(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  localStateDeviceId: string | null | undefined,
  options: { devices?: DeviceInfo[]; excludedTargets?: RuntimeProjectSyncTarget[] } = {}
): RuntimeRemoteProjectRegistration[] {
  if (!runtimeWork || !localStateDeviceId) return []

  const devices = createWorkbenchDeviceResolver(options.devices ?? [])
  const excluded = new Set(
    (options.excludedTargets ?? []).map(target =>
      runtimeProjectTargetKey(target.deviceId, target.projectKey, devices)
    )
  )
  const registrations = new Map<string, RuntimeRemoteProjectRegistration>()
  runtimeWork.projects.forEach(projectWork => {
    const target = getRuntimeProjectSyncTarget(projectWork)
    if (excluded.has(runtimeProjectTargetKey(target.deviceId, target.projectKey, devices))) return
    const workspace = getRemoteProjectWorkspace(projectWork, localStateDeviceId, devices)
    if (!workspace) return
    const hostId = workspace.remoteHostId?.trim() || workspace.deviceId.trim()
    const stateKey = projectWork.project.sidebarStateKey?.trim()
    const id = stateKey || buildRuntimeRemoteProjectStateId(hostId, projectWork.project.key)
    registrations.set(id, {
      id,
      hostId,
      remotePath: workspace.workspacePath,
      label: projectWork.project.name,
    })
  })
  return [...registrations.values()]
}

export function getRuntimeProjectActivation(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  projectId: number | null | undefined,
  localStateDeviceId: string | null | undefined,
  devices: DeviceInfo[] = []
): RuntimeProjectActivateRequest | null {
  if (!runtimeWork || !projectId || !localStateDeviceId) return null
  const projectWork = runtimeWork.projects.find(
    item => runtimeProjectUiId(item.project) === projectId
  )
  if (!projectWork) return null
  const workspace = projectWork.deviceWorkspaces[0]
  if (!workspace) return null
  const remoteWorkspace = getRemoteProjectWorkspace(
    projectWork,
    localStateDeviceId,
    createWorkbenchDeviceResolver(devices)
  )
  const remoteHostId = remoteWorkspace
    ? remoteWorkspace.remoteHostId?.trim() || remoteWorkspace.deviceId.trim()
    : null
  return {
    deviceId: localStateDeviceId,
    projectKey: remoteHostId
      ? projectWork.project.sidebarStateKey?.trim() ||
        buildRuntimeRemoteProjectStateId(remoteHostId, projectWork.project.key)
      : getRuntimeProjectSidebarStateKey(projectWork.project),
    workspacePath: remoteWorkspace?.workspacePath ?? workspace.workspacePath,
    ...(remoteHostId ? { remoteHostId } : {}),
  }
}

export function getRuntimeProjectReorderRequest(
  movedProjectWork: RuntimeProjectWork,
  beforeProjectWork: RuntimeProjectWork | null | undefined,
  localStateDeviceId: string | null | undefined
): RuntimeProjectReorderRequest | null {
  const deviceId =
    localStateDeviceId ??
    movedProjectWork.project.stateDeviceId ??
    movedProjectWork.deviceWorkspaces[0]?.deviceId
  if (!deviceId) return null

  return {
    deviceId,
    projectKey: getRuntimeProjectSidebarStateKey(movedProjectWork.project),
    beforeProjectKey: beforeProjectWork
      ? getRuntimeProjectSidebarStateKey(beforeProjectWork.project)
      : null,
    insertAtEnd: !beforeProjectWork,
  }
}

export function findActiveRuntimeProjectId(
  runtimeWork: RuntimeWorkListResponse | null | undefined
): number | null {
  const activeProjects = runtimeWork?.projects.filter(item => item.project.active) ?? []
  const project = activeProjects.find(item => item.project.kind === 'remote') ?? activeProjects[0]
  return project ? runtimeProjectUiId(project.project) : null
}

function getRemoteProjectWorkspace(
  projectWork: RuntimeProjectWork,
  localStateDeviceId: string,
  devices: WorkbenchDeviceResolver
) {
  return (
    projectWork.deviceWorkspaces.find(
      workspace =>
        devices.identityKey(workspace.remoteHostId?.trim() || workspace.deviceId) !==
        devices.identityKey(localStateDeviceId)
    ) ?? null
  )
}
