import type {
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeProjectRef,
  RuntimeProjectWork,
} from '@/types/api'

export function runtimeProjectKey(project: RuntimeProjectRef): string {
  return project.key || (project.id != null ? `legacy:${project.id}` : project.name)
}

export function runtimeProjectWorkKey(projectWork: RuntimeProjectWork): string {
  const stateDeviceId = projectWork.project.stateDeviceId?.trim() ?? ''
  return `${stateDeviceId}\0${runtimeProjectKey(projectWork.project)}`
}

export function runtimeProjectUiId(project: RuntimeProjectRef): number {
  if (project.id != null) return project.id

  const key = `${project.stateDeviceId?.trim() ?? ''}\0${runtimeProjectKey(project)}`
  let hash = 0
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0
  }
  return (hash % 1_000_000_000) + 1
}

function preferredRuntimeWorkspace(
  workspaces: RuntimeDeviceWorkspace[]
): RuntimeDeviceWorkspace | null {
  return (
    workspaces.find(workspace => workspace.available && workspace.workspaceKind !== 'chat') ??
    workspaces.find(workspace => workspace.workspaceKind !== 'chat') ??
    workspaces[0] ??
    null
  )
}

export function runtimeProjectToProject(projectWork: RuntimeProjectWork): ProjectWithTasks {
  const workspace = preferredRuntimeWorkspace(projectWork.deviceWorkspaces)
  const workspacePath = workspace?.workspacePath?.trim()
  const deviceId = workspace?.deviceId?.trim()

  return {
    id: runtimeProjectUiId(projectWork.project),
    name: projectWork.project.name,
    description: projectWork.project.description,
    color: projectWork.project.color,
    config:
      workspacePath && deviceId
        ? {
            mode: 'workspace',
            execution: {
              targetType: 'local',
              deviceId,
            },
            workspace: {
              source: 'local_path',
              localPath: workspacePath,
            },
          }
        : undefined,
    tasks: [],
  }
}
