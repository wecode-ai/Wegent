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
