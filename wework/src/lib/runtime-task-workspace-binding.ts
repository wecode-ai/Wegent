import { normalizeRuntimeWorkspacePath, runtimeProjectUiId } from '@/lib/runtime-project'
import type {
  RuntimeDeviceWorkspace,
  RuntimeTaskCreateRequest,
  RuntimeWorkListResponse,
} from '@/types/api'

export type RuntimeTaskWorkspaceBinding = Pick<
  RuntimeTaskCreateRequest,
  | 'projectId'
  | 'deviceWorkspaceId'
  | 'deviceId'
  | 'runtimeProjectKey'
  | 'runtimeProjectName'
  | 'runtimeWorkspaceRoots'
>

interface ResolveRuntimeTaskWorkspaceBindingInput {
  runtimeWork: RuntimeWorkListResponse | null | undefined
  projectUiId: number | null | undefined
  deviceWorkspaceId?: number | null
}

function executionDeviceId(workspace: RuntimeDeviceWorkspace): string {
  const remoteHostId = workspace.remoteHostId?.trim()
  return workspace.workspaceSource === 'remote' && remoteHostId ? remoteHostId : workspace.deviceId
}

function selectedWorkspace(
  workspaces: RuntimeDeviceWorkspace[],
  deviceWorkspaceId?: number | null
): RuntimeDeviceWorkspace | null {
  const available = workspaces.filter(workspace => workspace.available)
  if (deviceWorkspaceId != null) {
    return available.find(workspace => workspace.id === deviceWorkspaceId) ?? null
  }
  return available.length === 1 ? available[0] : null
}

function normalizedRuntimeWorkspaceRoots(roots: { path: string }[] | null | undefined): string[] {
  return [
    ...new Set((roots ?? []).map(root => normalizeRuntimeWorkspacePath(root.path)).filter(Boolean)),
  ]
}

export function resolveRuntimeTaskWorkspaceBinding({
  runtimeWork,
  projectUiId,
  deviceWorkspaceId,
}: ResolveRuntimeTaskWorkspaceBindingInput): RuntimeTaskWorkspaceBinding | null {
  if (projectUiId == null) return null
  const projectWork = runtimeWork?.projects.find(
    item => runtimeProjectUiId(item.project) === projectUiId
  )
  if (!projectWork) return null

  const workspace = selectedWorkspace(projectWork.deviceWorkspaces, deviceWorkspaceId)
  if (!workspace) return null

  const isDeviceProject =
    projectWork.project.source === 'local_project' ||
    projectWork.project.source === 'remote_project'
  const backendProjectId =
    workspace.projectId ?? (!isDeviceProject ? projectWork.project.id : undefined)
  if (backendProjectId != null) {
    return {
      projectId: backendProjectId,
      ...(workspace.id != null ? { deviceWorkspaceId: workspace.id } : {}),
    }
  }

  const runtimeProjectKey = projectWork.project.key?.trim()
  if (!runtimeProjectKey) return null
  return {
    deviceId: executionDeviceId(workspace),
    runtimeProjectKey,
    runtimeProjectName: projectWork.project.name,
    runtimeWorkspaceRoots: normalizedRuntimeWorkspaceRoots(projectWork.project.roots),
  }
}

export function runtimeTaskProjectUiId(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  request: RuntimeTaskCreateRequest | null | undefined
): number | null {
  if (!request) return null

  if (request.projectId != null) {
    const projectWork = runtimeWork?.projects.find(item =>
      item.deviceWorkspaces.some(
        workspace =>
          workspace.projectId === request.projectId &&
          (request.deviceWorkspaceId == null || workspace.id === request.deviceWorkspaceId)
      )
    )
    if (projectWork) return runtimeProjectUiId(projectWork.project)
  }

  const runtimeProjectKey = request.runtimeProjectKey?.trim()
  const deviceId = request.deviceId?.trim()
  if (!runtimeProjectKey || !deviceId) return null
  const projectWork = runtimeWork?.projects.find(
    item =>
      item.project.key === runtimeProjectKey &&
      item.deviceWorkspaces.some(workspace => executionDeviceId(workspace) === deviceId)
  )
  return projectWork ? runtimeProjectUiId(projectWork.project) : null
}

export function withoutRuntimeTaskWorkspaceBinding(
  request: RuntimeTaskCreateRequest
): RuntimeTaskCreateRequest {
  const taskIntent = { ...request }
  delete taskIntent.projectId
  delete taskIntent.deviceWorkspaceId
  delete taskIntent.deviceId
  delete taskIntent.workspacePath
  delete taskIntent.runtimeProjectKey
  delete taskIntent.runtimeProjectName
  delete taskIntent.runtimeWorkspaceRoots
  return taskIntent
}
