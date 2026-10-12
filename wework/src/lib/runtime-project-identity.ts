import type { RuntimeDeviceWorkspace, RuntimeProjectWork } from '@/types/api'
import { normalizeRuntimeWorkspacePath } from './runtime-project'
import type { WorkbenchDeviceResolver } from './workbench-device'

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
    return reference.projectKey
      ? { deviceId: reference.hostId, projectKey: reference.projectKey }
      : { deviceId: reference.stateDeviceId ?? reference.hostId, projectKey: reference.stateKey }
  }
  return {
    deviceId: work.project.stateDeviceId ?? work.deviceWorkspaces[0]?.deviceId ?? '',
    projectKey: work.project.key,
  }
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
  devices: WorkbenchDeviceResolver
): string {
  return JSON.stringify([devices.identityKey(deviceId), projectKey])
}

export function runtimeWorkspaceLocationKey(
  workspace: Pick<RuntimeDeviceWorkspace, 'deviceId' | 'workspacePath'>,
  devices: WorkbenchDeviceResolver
): string {
  return runtimeProjectTargetKey(
    workspace.deviceId,
    normalizeRuntimeWorkspacePath(workspace.workspacePath),
    devices
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
