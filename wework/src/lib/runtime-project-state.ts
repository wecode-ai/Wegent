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
  localStateDeviceId: string | null | undefined
): RuntimeRemoteProjectRegistration[] {
  if (!runtimeWork || !localStateDeviceId) return []

  const registrations = new Map<string, RuntimeRemoteProjectRegistration>()
  runtimeWork.projects.forEach(projectWork => {
    const workspace = getRemoteProjectWorkspace(projectWork, localStateDeviceId)
    if (!workspace) return
    const hostId = workspace.remoteHostId?.trim() || workspace.deviceId.trim()
    const stateKey = projectWork.project.sidebarStateKey?.trim()
    const id = stateKey || createRemoteProjectStateId(hostId, projectWork.project.key)
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
  localStateDeviceId: string | null | undefined
): RuntimeProjectActivateRequest | null {
  if (!runtimeWork || !projectId || !localStateDeviceId) return null
  const projectWork = runtimeWork.projects.find(
    item => runtimeProjectUiId(item.project) === projectId
  )
  if (!projectWork) return null
  const workspace = projectWork.deviceWorkspaces[0]
  if (!workspace) return null
  const remoteWorkspace = getRemoteProjectWorkspace(projectWork, localStateDeviceId)
  const remoteHostId = remoteWorkspace
    ? remoteWorkspace.remoteHostId?.trim() || remoteWorkspace.deviceId.trim()
    : null
  return {
    deviceId: localStateDeviceId,
    projectKey: remoteHostId
      ? projectWork.project.sidebarStateKey?.trim() ||
        createRemoteProjectStateId(remoteHostId, projectWork.project.key)
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

function getRemoteProjectWorkspace(projectWork: RuntimeProjectWork, localStateDeviceId: string) {
  return (
    projectWork.deviceWorkspaces.find(workspace => Boolean(workspace.remoteHostId?.trim())) ??
    projectWork.deviceWorkspaces.find(
      workspace => workspace.deviceId.trim() !== localStateDeviceId
    ) ??
    null
  )
}

function createRemoteProjectStateId(hostId: string, projectKey: string): string {
  return `wegent-remote:${encodeURIComponent(hostId)}:${encodeURIComponent(projectKey)}`
}
