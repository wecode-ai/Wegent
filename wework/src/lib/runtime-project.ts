import type {
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeProjectRef,
  RuntimeProjectWork,
  RuntimeWorkListResponse,
} from '@/types/api'

export function runtimeProjectKey(project: RuntimeProjectRef): string {
  return project.key || (project.id != null ? `legacy:${project.id}` : project.name)
}

export function runtimeProjectWorkKey(projectWork: RuntimeProjectWork): string {
  const stateDeviceId = projectWork.project.stateDeviceId?.trim() ?? ''
  return `${stateDeviceId}\0${runtimeProjectKey(projectWork.project)}`
}

export function normalizeRuntimeWorkspacePath(path: string): string {
  const trimmedPath = path.trim()
  if (trimmedPath === '/') return trimmedPath
  return trimmedPath.replace(/\/+$/, '')
}

export function standaloneRuntimeProjectKey(workspacePath: string): string {
  return normalizeRuntimeWorkspacePath(workspacePath)
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

export function resolveRuntimeTaskProjects(
  projects: ProjectWithTasks[],
  runtimeWork: RuntimeWorkListResponse | null | undefined
): ProjectWithTasks[] {
  const resolved = new Map(projects.map(project => [project.id, project]))

  for (const runtimeProject of runtimeWork?.projects ?? []) {
    const project = runtimeProjectToProject(runtimeProject)
    const existing = resolved.get(project.id)
    resolved.set(project.id, {
      ...existing,
      ...project,
      description: project.description ?? existing?.description,
      color: project.color ?? existing?.color,
      config: project.config ?? existing?.config,
      tasks: existing?.tasks ?? [],
    })
  }

  return [...resolved.values()]
}
