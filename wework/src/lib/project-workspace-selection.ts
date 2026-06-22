import type {
  DeviceInfo,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeWorkListResponse,
} from '@/types/api'
import { isWeWorkExecutorVersionCompatible } from './device-capabilities'

export type ProjectWorkspaceOptionKind = 'empty' | 'single' | 'multi'

export interface ProjectWorkspaceOption {
  kind: ProjectWorkspaceOptionKind
  project: ProjectWithTasks
  workspaces: RuntimeDeviceWorkspace[]
  workspace: RuntimeDeviceWorkspace | null
  selectable: boolean
}

interface BuildProjectWorkspaceOptionsInput {
  projects: ProjectWithTasks[]
  devices: DeviceInfo[]
  runtimeWork: RuntimeWorkListResponse | null | undefined
}

function deviceById(devices: DeviceInfo[]) {
  return new Map(devices.map(device => [device.device_id, device]))
}

function runtimeWorkspacesByProjectId(runtimeWork: RuntimeWorkListResponse | null | undefined) {
  return new Map((runtimeWork?.projects ?? []).map(item => [item.project.id, item.deviceWorkspaces]))
}

export function isSelectableProjectWorkspace(
  workspace: RuntimeDeviceWorkspace | null | undefined,
  devices: DeviceInfo[] = []
): workspace is RuntimeDeviceWorkspace {
  if (!workspace || !workspace.id) return false
  if (!workspace.available) return false

  const device = deviceById(devices).get(workspace.deviceId)
  if (device && !isWeWorkExecutorVersionCompatible(device.executor_version)) {
    return false
  }

  const status = workspace.deviceStatus ?? device?.status
  return status === 'online' || status === 'busy'
}

export function buildProjectWorkspaceOptions({
  projects,
  devices,
  runtimeWork,
}: BuildProjectWorkspaceOptionsInput): ProjectWorkspaceOption[] {
  const workspacesByProjectId = runtimeWorkspacesByProjectId(runtimeWork)

  return projects.map(project => {
    const workspaces = workspacesByProjectId.get(project.id) ?? []
    if (workspaces.length === 0) {
      return {
        kind: 'empty',
        project,
        workspaces,
        workspace: null,
        selectable: false,
      }
    }

    if (workspaces.length === 1) {
      const workspace = workspaces[0]
      return {
        kind: 'single',
        project,
        workspaces,
        workspace,
        selectable: isSelectableProjectWorkspace(workspace, devices),
      }
    }

    return {
      kind: 'multi',
      project,
      workspaces,
      workspace: null,
      selectable: false,
    }
  })
}
