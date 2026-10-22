import {
  buildRuntimeRemoteProjectStateId,
  parseRuntimeRemoteProjectStateId,
  getRuntimeProjectSyncTarget,
  runtimeProjectSyncTargetKey,
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
import {
  assertLocalRuntimeSidebarIdentity,
  getLocalRuntimeSourceIdentity,
  type LocalRuntimeSidebarIdentity,
} from './local-runtime-sidebar-identity'

export function isDeviceRuntimeProject(project?: RuntimeProjectRef | null): boolean {
  return project?.source === 'local_project' || project?.source === 'remote_project'
}

export function getRuntimeProjectOwner(projectWork: RuntimeProjectWork) {
  const { project, deviceWorkspaces } = projectWork
  const workspace = deviceWorkspaces[0]
  const sidebarIdentity = parseRuntimeRemoteProjectStateId(
    project.sidebarStateKey || project.key || ''
  )
  const deviceId =
    project.ownerDeviceId?.trim() ||
    workspace?.remoteHostId?.trim() ||
    sidebarIdentity?.hostId ||
    workspace?.deviceId?.trim() ||
    project.stateDeviceId?.trim() ||
    ''
  const unresolvedRemoteAlias =
    project.source === 'remote_project' &&
    project.sidebarStateKey &&
    project.key === (project.sidebarStateKey || project.key)
  return {
    deviceId,
    projectKey:
      project.ownerProjectKey?.trim() ||
      sidebarIdentity?.projectKey ||
      (unresolvedRemoteAlias ? '' : project.key || ''),
  }
}

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
  options: {
    devices?: DeviceInfo[]
    excludedTargets?: RuntimeProjectSyncTarget[]
    localSidebarIdentity?: LocalRuntimeSidebarIdentity
  } = {}
): RuntimeRemoteProjectRegistration[] {
  if (!runtimeWork || !localStateDeviceId) return []

  const devices = createWorkbenchDeviceResolver(options.devices ?? [])
  const targetKey = (target: RuntimeProjectSyncTarget) => {
    return runtimeProjectSyncTargetKey(target, devices, options.localSidebarIdentity)
  }
  const excluded = new Set((options.excludedTargets ?? []).map(targetKey))
  const registrations = new Map<string, RuntimeRemoteProjectRegistration>()
  runtimeWork.projects.forEach(projectWork => {
    if (
      !projectWork.deviceWorkspaces.length &&
      (projectWork.project.source === 'remote_project' || projectWork.project.kind === 'remote')
    ) {
      throw new Error(`remote-project-workspace-unavailable:${projectWork.project.key}`)
    }
    const localSource = getLocalRuntimeSourceIdentity(projectWork.project)
    if (localSource && options.localSidebarIdentity) {
      assertLocalRuntimeSidebarIdentity(localSource, options.localSidebarIdentity)
    }
    const workspace = getRemoteProjectWorkspace(
      projectWork,
      localStateDeviceId,
      devices,
      options.localSidebarIdentity
    )
    if (!workspace) return
    const target = getRuntimeProjectSyncTarget(projectWork)
    if (excluded.has(targetKey(target))) return
    const owner = getRuntimeProjectOwner(projectWork)
    devices.resolve(owner.deviceId)
    const hostId = owner.deviceId
    const stateKey = projectWork.project.sidebarStateKey?.trim()
    const id = stateKey || buildRuntimeRemoteProjectStateId(hostId, owner.projectKey)
    registrations.set(id, {
      id,
      hostId,
      remotePath: projectWork.project.roots?.[0]?.path || workspace.workspacePath,
      label: projectWork.project.name,
      projectKey: owner.projectKey || null,
      roots: projectWork.project.roots?.map(root => root.path) ?? [workspace.workspacePath],
      defaultProjectSpace: projectWork.project.defaultProjectSpace ?? null,
      aiSettings: projectWork.project.aiSettings ?? null,
    })
  })
  return [...registrations.values()]
}

export function getRuntimeProjectActivation(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  projectId: number | null | undefined,
  localStateDeviceId: string | null | undefined,
  devices: DeviceInfo[] = [],
  localSidebarIdentity?: LocalRuntimeSidebarIdentity
): RuntimeProjectActivateRequest | null {
  if (!runtimeWork || !projectId || !localStateDeviceId) return null
  const projectWork = runtimeWork.projects.find(
    item => runtimeProjectUiId(item.project) === projectId
  )
  if (!projectWork) return null
  const localSource = getLocalRuntimeSourceIdentity(projectWork.project)
  if (localSource && localSidebarIdentity) {
    assertLocalRuntimeSidebarIdentity(localSource, localSidebarIdentity)
  }
  const workspace = projectWork.deviceWorkspaces[0]
  if (!workspace) return null
  const remoteWorkspace = getRemoteProjectWorkspace(
    projectWork,
    localStateDeviceId,
    createWorkbenchDeviceResolver(devices),
    localSidebarIdentity ?? localSource
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
  devices: WorkbenchDeviceResolver,
  localSidebarIdentity?: LocalRuntimeSidebarIdentity
) {
  const localIdentityKey = localSidebarIdentity
    ? `runtime:${localSidebarIdentity.runtimeInstanceId}`
    : devices.identityKey(localStateDeviceId)
  return (
    projectWork.deviceWorkspaces.find(workspace => {
      const deviceId = workspace.remoteHostId?.trim() || workspace.deviceId
      const localSource = getLocalRuntimeSourceIdentity(workspace)
      if (
        localSidebarIdentity &&
        localSource &&
        deviceId === localSidebarIdentity.deviceId &&
        !workspace.remoteHostId &&
        workspace.workspaceSource !== 'remote' &&
        projectWork.project.source !== 'remote_project'
      ) {
        assertLocalRuntimeSidebarIdentity(localSource, localSidebarIdentity)
        return false
      }
      return devices.identityKey(deviceId) !== localIdentityKey
    }) ?? null
  )
}
