import type { RuntimeDeviceWorkspace, RuntimeProjectWork } from '@/types/api'
import { normalizeRuntimeWorkspacePath } from './runtime-project'
import type { WorkbenchDeviceResolver } from './workbench-device'
import {
  getLocalRuntimeSourceIdentity,
  qualifyLocalRuntimeSource,
  assertLocalRuntimeSidebarIdentity,
  type LocalRuntimeSidebarIdentity,
} from './local-runtime-sidebar-identity'

export interface RuntimeProjectReference {
  stateKey: string
  stateDeviceId: string | null
  hostId: string
  projectKey: string | null
  workspacePath: string
}

export interface RuntimeProjectSyncTarget {
  deviceId: string
  projectKey: string
}

export function getRuntimeProjectSyncTarget(work: RuntimeProjectWork): RuntimeProjectSyncTarget {
  const reference = getRuntimeProjectReference(work)
  if (reference) {
    if (reference.projectKey) {
      return { deviceId: reference.hostId, projectKey: reference.projectKey }
    }
    const target = {
      deviceId: reference.stateDeviceId ?? reference.hostId,
      projectKey: reference.stateKey,
    }
    const localSource = getLocalRuntimeSourceIdentity(work.project)
    return localSource?.deviceId === target.deviceId
      ? qualifyLocalRuntimeSource(target, localSource)
      : target
  }
  const target = {
    deviceId: work.project.stateDeviceId ?? work.deviceWorkspaces[0]?.deviceId ?? '',
    projectKey: work.project.key,
  }
  const localSource = getLocalRuntimeSourceIdentity(work.project)
  return localSource?.deviceId === target.deviceId
    ? qualifyLocalRuntimeSource(target, localSource)
    : target
}

export function buildRuntimeRemoteProjectStateId(hostId: string, projectKey: string): string {
  return `wegent-remote:${encodeURIComponent(hostId)}:${encodeURIComponent(projectKey)}`
}

export function parseRuntimeRemoteProjectStateId(
  stateId: string
): { hostId: string; projectKey: string } | null {
  const prefix = 'wegent-remote:'
  if (!stateId.startsWith(prefix)) return null
  const encodedIdentity = stateId.slice(prefix.length)
  const separatorIndex = encodedIdentity.indexOf(':')
  if (separatorIndex <= 0 || separatorIndex === encodedIdentity.length - 1) return null
  try {
    const hostId = decodeURIComponent(encodedIdentity.slice(0, separatorIndex)).trim()
    const projectKey = decodeURIComponent(encodedIdentity.slice(separatorIndex + 1)).trim()
    return hostId && projectKey ? { hostId, projectKey } : null
  } catch {
    return null
  }
}

/** A persisted sidebar entry refers to a project; it does not own its runtime tasks. */
export function getRuntimeProjectReference(
  work: RuntimeProjectWork
): RuntimeProjectReference | null {
  if (work.project.source !== 'remote_project') return null
  const workspace = work.deviceWorkspaces[0]
  if (!workspace) return null
  const stateKey = work.project.sidebarStateKey?.trim() || work.project.key
  const target = parseRuntimeRemoteProjectStateId(stateKey)
  return {
    stateKey,
    stateDeviceId: work.project.stateDeviceId ?? null,
    hostId: workspace.remoteHostId?.trim() || target?.hostId || workspace.deviceId,
    projectKey:
      work.project.ownerProjectKey?.trim() ||
      (work.project.key !== stateKey ? work.project.key : (target?.projectKey ?? null)),
    workspacePath: workspace.workspacePath,
  }
}

export function runtimeProjectTargetKey(
  deviceId: string,
  projectKey: string,
  devices: WorkbenchDeviceResolver,
  localIdentity?: LocalRuntimeSidebarIdentity
): string {
  const identityKey =
    localIdentity?.deviceId === deviceId.trim()
      ? `runtime:${localIdentity.runtimeInstanceId}`
      : devices.identityKey(deviceId)
  return JSON.stringify([identityKey, projectKey])
}

export function getRuntimeProjectLocalOwnerIdentity(
  projectWork: RuntimeProjectWork,
  ownerDeviceId: string
): LocalRuntimeSidebarIdentity | undefined {
  const source = getLocalRuntimeSourceIdentity(projectWork.project)
  return projectWork.project.source !== 'remote_project' &&
    projectWork.project.kind !== 'remote' &&
    source?.deviceId === ownerDeviceId &&
    !projectWork.deviceWorkspaces.some(
      workspace => workspace.remoteHostId || workspace.workspaceSource === 'remote'
    )
    ? source
    : undefined
}

export function runtimeProjectSyncTargetKey(
  target: RuntimeProjectSyncTarget,
  devices: WorkbenchDeviceResolver,
  localIdentity?: LocalRuntimeSidebarIdentity
): string {
  const localSource = getLocalRuntimeSourceIdentity(target)
  if (localSource && localIdentity) assertLocalRuntimeSidebarIdentity(localSource, localIdentity)
  return runtimeProjectTargetKey(target.deviceId, target.projectKey, devices, localSource)
}

export function runtimeWorkspaceLocationKey(
  workspace: Pick<RuntimeDeviceWorkspace, 'deviceId' | 'workspacePath'>,
  devices: WorkbenchDeviceResolver
): string {
  return runtimeProjectTargetKey(
    workspace.deviceId,
    normalizeRuntimeWorkspacePath(workspace.workspacePath),
    devices,
    getLocalRuntimeSourceIdentity(workspace)
  )
}

export function isRuntimeDirectoryProject(work: RuntimeProjectWork): boolean {
  if (work.project.source === 'local_project') return false
  if (work.project.source === 'legacy_root') return true
  return work.deviceWorkspaces.some(workspace => {
    const path = normalizeRuntimeWorkspacePath(workspace.workspacePath)
    return work.project.key === path || work.project.key === `local:${path}`
  })
}
