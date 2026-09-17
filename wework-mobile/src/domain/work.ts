import type {
  ConversationItem,
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeTaskSummary,
  RuntimeWorkListResponse,
} from '@/types/runtime'
import { runtimeTaskKey } from './runtimeTaskLifecycle'

const EMPTY_RUNNING_PROJECTION = new Map<string, boolean>()

export function flattenConversations(
  work: RuntimeWorkListResponse,
  runningByTask: ReadonlyMap<string, boolean> = EMPTY_RUNNING_PROJECTION
): ConversationItem[] {
  const items: ConversationItem[] = []
  for (const project of work.projects) {
    for (const workspace of project.deviceWorkspaces) {
      items.push(...workspaceConversations(workspace, project.project.name, runningByTask))
    }
  }
  for (const workspace of work.chats) {
    items.push(...workspaceConversations(workspace, null, runningByTask))
  }
  return items.sort((left, right) => right.updatedAt - left.updatedAt)
}

export function allWorkspaces(work: RuntimeWorkListResponse): RuntimeDeviceWorkspace[] {
  const projectWorkspaces = work.projects.flatMap(project => project.deviceWorkspaces)
  return [...projectWorkspaces, ...work.chats]
}

export function mergeRuntimeWorkForDevices(
  workByDevice: Readonly<Record<string, RuntimeWorkListResponse>>,
  deviceIds: readonly string[]
): RuntimeWorkListResponse {
  const projectsByKey = new Map<string, RuntimeWorkListResponse['projects'][number]>()
  const chatsByKey = new Map<string, RuntimeDeviceWorkspace>()

  for (const deviceId of deviceIds) {
    const work = workByDevice[deviceId]
    if (!work) continue
    for (const projectWork of work.projects) {
      const existing = projectsByKey.get(projectWork.project.key)
      if (!existing) {
        projectsByKey.set(projectWork.project.key, {
          ...projectWork,
          project: { ...projectWork.project },
          deviceWorkspaces: mergeWorkspaces([], projectWork.deviceWorkspaces),
        })
        continue
      }
      existing.deviceWorkspaces = mergeWorkspaces(
        existing.deviceWorkspaces,
        projectWork.deviceWorkspaces
      )
    }
    for (const workspace of work.chats) {
      const key = workspaceKey(workspace)
      const existing = chatsByKey.get(key)
      if (!existing || (!existing.available && workspace.available)) chatsByKey.set(key, workspace)
    }
  }

  const projects = [...projectsByKey.values()].map(project => ({
    ...project,
    totalTasks: project.deviceWorkspaces.reduce(
      (total, workspace) => total + workspace.tasks.length,
      0
    ),
  }))
  const chats = [...chatsByKey.values()]
  return {
    projects,
    chats,
    totalTasks:
      projects.reduce((total, project) => total + (project.totalTasks ?? 0), 0) +
      chats.reduce((total, workspace) => total + workspace.tasks.length, 0),
  }
}

export function runtimeWorkForDevices(
  workByDevice: Readonly<Record<string, RuntimeWorkListResponse>>,
  deviceIds: readonly string[]
): Record<string, RuntimeWorkListResponse> {
  const selectedWork: Record<string, RuntimeWorkListResponse> = {}
  for (const deviceId of deviceIds) {
    const work = workByDevice[deviceId]
    if (work) selectedWork[deviceId] = work
  }
  return selectedWork
}

function mergeWorkspaces(
  current: readonly RuntimeDeviceWorkspace[],
  incoming: readonly RuntimeDeviceWorkspace[]
): RuntimeDeviceWorkspace[] {
  const merged = new Map(current.map(workspace => [workspaceKey(workspace), workspace]))
  for (const workspace of incoming) {
    const key = workspaceKey(workspace)
    const existing = merged.get(key)
    if (!existing || (!existing.available && workspace.available)) merged.set(key, workspace)
  }
  return [...merged.values()]
}

function workspaceKey(workspace: RuntimeDeviceWorkspace): string {
  return `${workspace.deviceId}\0${workspace.workspacePath}`
}

export function runtimeWorkContainsTask(
  work: RuntimeWorkListResponse,
  address: Pick<RuntimeTaskAddress, 'deviceId' | 'taskId'>
): boolean {
  return allWorkspaces(work).some(
    workspace =>
      workspace.deviceId === address.deviceId &&
      workspace.tasks.some(task => task.taskId === address.taskId)
  )
}

export function taskAddress(
  workspace: RuntimeDeviceWorkspace,
  task: RuntimeTaskSummary
): RuntimeTaskAddress {
  return {
    deviceId: workspace.deviceId,
    taskId: task.taskId,
    runtime: task.runtime,
    workspacePath: task.workspacePath || workspace.workspacePath,
    workspaceKind: task.workspaceKind ?? workspace.workspaceKind,
  }
}

function workspaceConversations(
  workspace: RuntimeDeviceWorkspace,
  projectName: string | null,
  runningByTask: ReadonlyMap<string, boolean>
): ConversationItem[] {
  return workspace.tasks.map(task => {
    const address = taskAddress(workspace, task)
    return {
      address,
      title: task.title || '新会话',
      deviceName: workspace.deviceName,
      projectName,
      updatedAt: timestamp(task.updatedAt ?? task.createdAt),
      running: runningByTask.get(runtimeTaskKey(address)) ?? Boolean(task.running),
    }
  })
}

function timestamp(value: string | number | null | undefined): number {
  if (typeof value === 'number') return value
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}
