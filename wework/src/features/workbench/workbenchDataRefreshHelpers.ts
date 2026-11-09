import type { CloudRuntimeState } from '@/types/workbench'
import type { ExecutorClient } from '@/api/executorAccess'
import type {
  DeviceInfo,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
} from '@/types/api'
import { getPreferredStandaloneDeviceId } from '@/lib/device-selection'
import { isCloudDevice, isRemoteDevice } from '@/lib/device-capabilities'
import { normalizeRuntimeWorkspacePath, runtimeProjectUiId } from '@/lib/runtime-project'
import {
  EMPTY_CLOUD_RUNTIME_STATE,
  clearCloudRuntimeSync,
  readCachedDeviceList,
} from './workbenchCloudStatus'
import { getRuntimeTaskRouteKey, removeRuntimeTasks } from './workbenchRuntimeHelpers'

export interface CloudBackgroundRequest {
  controller: AbortController
  refreshDevices: boolean
  workRefreshQueued: boolean
}

export interface CloudBackgroundRefreshOptions {
  projects: ProjectWithTasks[]
  standaloneDeviceId: string | null
  standaloneWorkspacePath?: string | null
  trigger?: 'bootstrap' | 'manual-refresh' | 'device-event'
  refreshDevices?: boolean
  isCancelled?: () => boolean
}

export function queueWorkRefreshAfterInventory(
  request: CloudBackgroundRequest | null,
  refreshDevices: boolean
): boolean {
  if (refreshDevices || !request?.refreshDevices || request.controller.signal.aborted) return false
  // Finish inventory discovery, then coalesce work events into one fresh read.
  request.workRefreshQueued = true
  return true
}

export async function loadDevicesForRefresh(
  executorClient: ExecutorClient,
  cacheScope: string,
  options?: { useCacheFallback?: boolean }
): Promise<DeviceInfo[]> {
  let devices: DeviceInfo[]
  try {
    devices = await executorClient.commands.listDevices()
  } catch (error) {
    if (options?.useCacheFallback === false) throw error
    const cachedDevices = readCachedDeviceList(cacheScope)
    if (cachedDevices.length === 0) throw error
    devices = cachedDevices
  }
  return devices
}

/**
 * Resolve the standalone device after a device or runtime-work refresh.
 *
 * While a standalone workspace is open its device must be preserved verbatim:
 * the workspace may belong to a cloud or remote device that the standalone-task
 * preference intentionally excludes. Re-picking a local device here would
 * render a phantom local project row next to the real remote workspace.
 */
export function resolveStandaloneDeviceIdForRefresh(
  devices: DeviceInfo[],
  standaloneDeviceId: string | null | undefined,
  standaloneWorkspacePath: string | null | undefined
): string | null {
  if (standaloneWorkspacePath && standaloneDeviceId) {
    return standaloneDeviceId
  }
  return getPreferredStandaloneDeviceId(devices, standaloneDeviceId)
}

export function localDeviceSnapshot(devices: DeviceInfo[]): DeviceInfo[] {
  return devices.filter(device => !isCloudDevice(device) && !isRemoteDevice(device))
}

export function createCloudRuntimeStateWithCache(
  runtimeWork: RuntimeWorkListResponse
): CloudRuntimeState {
  if (runtimeWork.projects.length === 0 && runtimeWork.chats.length === 0) {
    return EMPTY_CLOUD_RUNTIME_STATE
  }
  return {
    availability: 'stale',
    current: null,
    lastGood: {
      revision: 0,
      devices: [],
      runtimeWork,
      teams: [],
      fetchedAt: null,
      checks: {
        teams: { status: 'idle', updatedAt: null, error: null },
        devices: { status: 'idle', updatedAt: null, error: null },
        runtimeWork: { status: 'stale', updatedAt: null, error: null },
      },
    },
    inFlightRevision: null,
    lastTrigger: null,
    nextRevision: 1,
  }
}

export function removeRuntimeTasksFromCloudState(
  state: CloudRuntimeState,
  addresses: RuntimeTaskAddress[]
): CloudRuntimeState {
  const removeFromSnapshot = (snapshot: CloudRuntimeState['current']) =>
    snapshot
      ? {
          ...snapshot,
          runtimeWork: removeRuntimeTasks(snapshot.runtimeWork, addresses),
        }
      : null
  return clearCloudRuntimeSync({
    ...state,
    current: removeFromSnapshot(state.current),
    lastGood: removeFromSnapshot(state.lastGood),
  })
}

export function removeRuntimeProjectFromCloudState(
  state: CloudRuntimeState,
  projectId: number,
  workspace?: { deviceId: string; workspacePath: string }
): CloudRuntimeState {
  const removeFromSnapshot = (snapshot: CloudRuntimeState['current']) =>
    snapshot
      ? {
          ...snapshot,
          runtimeWork: removeRuntimeProject(snapshot.runtimeWork, projectId, workspace),
        }
      : null
  return {
    ...state,
    availability:
      state.inFlightRevision == null ? state.availability : state.lastGood ? 'stale' : 'idle',
    current: removeFromSnapshot(state.current),
    lastGood: removeFromSnapshot(state.lastGood),
  }
}

export function mergeRuntimeTaskAddresses(
  current: RuntimeTaskAddress[],
  incoming: RuntimeTaskAddress[]
): RuntimeTaskAddress[] {
  const addresses = new Map(current.map(address => [getRuntimeTaskRouteKey(address), address]))
  incoming.forEach(address => addresses.set(getRuntimeTaskRouteKey(address), address))
  return [...addresses.values()]
}

export function removeRuntimeProject(
  runtimeWork: RuntimeWorkListResponse,
  projectId: number,
  workspace?: { deviceId: string; workspacePath: string }
): RuntimeWorkListResponse {
  const normalizedDeviceId = workspace?.deviceId.trim()
  const normalizedWorkspacePath = workspace
    ? normalizeRuntimeWorkspacePath(workspace.workspacePath)
    : null
  const matchesRemovedWorkspace = (candidate: RuntimeDeviceWorkspace) =>
    Boolean(
      normalizedDeviceId &&
      normalizedWorkspacePath &&
      candidate.deviceId.trim() === normalizedDeviceId &&
      normalizeRuntimeWorkspacePath(candidate.workspacePath) === normalizedWorkspacePath
    )
  const projects = runtimeWork.projects.filter(project => {
    if (runtimeProjectUiId(project.project) === projectId) return false
    if (!normalizedWorkspacePath) return true
    return !project.deviceWorkspaces.some(
      candidate =>
        normalizeRuntimeWorkspacePath(candidate.workspacePath) === normalizedWorkspacePath
    )
  })
  const chats =
    normalizedDeviceId && normalizedWorkspacePath
      ? runtimeWork.chats.filter(chat => !matchesRemovedWorkspace(chat))
      : runtimeWork.chats
  const totalTasks =
    projects.reduce(
      (projectTotal, project) =>
        projectTotal +
        project.deviceWorkspaces.reduce(
          (workspaceTotal, workspace) => workspaceTotal + workspace.tasks.length,
          0
        ),
      0
    ) + chats.reduce((workspaceTotal, workspace) => workspaceTotal + workspace.tasks.length, 0)
  return { ...runtimeWork, projects, chats, totalTasks }
}
