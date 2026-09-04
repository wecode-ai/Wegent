import type {
  RuntimeDeviceWorkspace,
  RuntimeTaskSummary,
  RuntimeWorkListResponse,
} from '@/types/runtime'

export function adaptRuntimeWorkListResponse(
  response: unknown,
  deviceId: string,
  deviceName = 'Cloud Executor'
): RuntimeWorkListResponse {
  const record = recordValue(response)
  if (Array.isArray(record.projects) && Array.isArray(record.chats)) {
    return normalizeProjectedWork(
      record as unknown as RuntimeWorkListResponse,
      deviceId,
      deviceName
    )
  }

  const workspaces = Array.isArray(record.workspaces)
    ? record.workspaces
    : Object.entries(recordValue(record.workspaces)).map(([workspacePath, workspace]) => ({
        ...recordValue(workspace),
        workspacePath,
      }))
  const projects: RuntimeWorkListResponse['projects'] = []
  const projectsByKey = new Map<string, RuntimeWorkListResponse['projects'][number]>()
  const chats: RuntimeWorkListResponse['chats'] = []
  const localWorkspaceLabels = new Set<string>()
  let totalTasks = 0

  for (const rawWorkspace of workspaces) {
    const workspace = recordValue(rawWorkspace)
    const workspacePath = workspacePathValue(workspace)
    if (!workspacePath) continue
    const workspaceSource = stringValue(workspace.workspaceSource ?? workspace.workspace_source)
    if (!workspaceSource || workspaceSource === 'local') {
      localWorkspaceLabels.add(workspaceLabel(workspacePath, workspace.label))
    }
  }

  for (const rawWorkspace of workspaces) {
    const workspace = recordValue(rawWorkspace)
    const workspacePath = workspacePathValue(workspace)
    if (!workspacePath) continue
    const tasks = normalizeTasks(workspace.tasks, workspacePath)
    const workspaceKind =
      stringValue(workspace.workspaceKind ?? workspace.workspace_kind) ??
      (tasks.some(task => task.workspaceKind === 'chat') ? 'chat' : 'workspace')
    const label = workspaceLabel(workspacePath, workspace.label)
    const workspaceSource = stringValue(workspace.workspaceSource ?? workspace.workspace_source)
    const remoteHostId = stringValue(workspace.remoteHostId ?? workspace.remote_host_id)
    const workspaceDeviceId = workspaceSource === 'remote' && remoteHostId ? remoteHostId : deviceId
    if (tasks.length === 0 && workspaceSource === 'remote' && localWorkspaceLabels.has(label)) {
      continue
    }

    const deviceWorkspace: RuntimeDeviceWorkspace = {
      id: stableLocalId(`${workspaceDeviceId}\0${workspacePath}`),
      projectId: null,
      deviceId: workspaceDeviceId,
      deviceName: remoteHostId ?? deviceName,
      deviceStatus: workspaceDeviceId === deviceId ? 'online' : 'offline',
      available: workspaceDeviceId === deviceId,
      workspacePath,
      workspaceKind,
      worktreeId: stringValue(workspace.worktreeId ?? workspace.worktree_id),
      label,
      workspaceSource,
      remoteHostId,
      mapped: true,
      tasks,
    }
    totalTasks += tasks.length

    if (workspaceKind === 'chat') {
      chats.push(deviceWorkspace)
      continue
    }

    const projectKey =
      stringValue(workspace.projectKey ?? workspace.project_key) ?? `local:${workspacePath}`
    const existing = projectsByKey.get(projectKey)
    if (existing) {
      existing.deviceWorkspaces.push(deviceWorkspace)
      existing.totalTasks = (existing.totalTasks ?? 0) + tasks.length
      continue
    }
    const project = {
      project: {
        id: stableLocalId(`${deviceId}\0${projectKey}`),
        key: projectKey,
        name: label,
        stateDeviceId: deviceId,
      },
      deviceWorkspaces: [deviceWorkspace],
      totalTasks: tasks.length,
    }
    projectsByKey.set(projectKey, project)
    projects.push(project)
  }

  return { projects, chats, totalTasks }
}

function normalizeProjectedWork(
  work: RuntimeWorkListResponse,
  deviceId: string,
  deviceName: string
): RuntimeWorkListResponse {
  const normalizeWorkspace = (workspace: RuntimeDeviceWorkspace): RuntimeDeviceWorkspace => ({
    ...workspace,
    deviceId,
    deviceName: workspace.deviceName || deviceName,
    deviceStatus: workspace.deviceStatus || 'online',
    available: workspace.available !== false,
    tasks: normalizeTasks(workspace.tasks, workspace.workspacePath),
  })
  return {
    ...work,
    projects: work.projects.map(project => ({
      ...project,
      project: { ...project.project, stateDeviceId: project.project.stateDeviceId ?? deviceId },
      deviceWorkspaces: project.deviceWorkspaces.map(normalizeWorkspace),
    })),
    chats: work.chats.map(normalizeWorkspace),
  }
}

function normalizeTasks(value: unknown, fallbackWorkspacePath: string): RuntimeTaskSummary[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const task = recordValue(item)
    const taskId = idValue(task.taskId ?? task.task_id)
    if (!taskId) return []
    const workspacePath = workspacePathValue(task) ?? fallbackWorkspacePath
    const workspaceKind = stringValue(task.workspaceKind ?? task.workspace_kind)
    const worktreeId = stringValue(task.worktreeId ?? task.worktree_id)
    const threadId = stringValue(task.threadId ?? task.thread_id)
    return [
      {
        ...task,
        taskId,
        title: stringValue(task.title) ?? taskId,
        runtime: stringValue(task.runtime) ?? 'codex',
        workspacePath,
        ...(threadId ? { threadId } : {}),
        ...(workspaceKind ? { workspaceKind } : {}),
        ...(worktreeId ? { worktreeId } : {}),
        updatedAt: timestampValue(task.updatedAt ?? task.updated_at),
        createdAt: timestampValue(task.createdAt ?? task.created_at),
      } as RuntimeTaskSummary,
    ]
  })
}

function workspacePathValue(value: Record<string, unknown>): string | null {
  return stringValue(
    value.workspacePath ??
      value.workspace_path ??
      value.projectWorkspacePath ??
      value.project_workspace_path ??
      value.cwd ??
      value.path
  )
}

function workspaceLabel(workspacePath: string, value: unknown): string {
  return stringValue(value) ?? workspacePath.split('/').filter(Boolean).at(-1) ?? workspacePath
}

function stableLocalId(value: string): number {
  let hash = 0
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return (hash % 1_000_000_000) + 1
}

function timestampValue(value: unknown): string | number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : stringValue(value)
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function idValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return stringValue(value)
}

function recordValue(value: unknown): Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
