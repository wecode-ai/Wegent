import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import {
  isDefaultWorkItemProject,
  type ProjectSpaceTaskContextApi,
} from '@/features/todo/projectSpaceSelection'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { type LocalWorkItem } from '@/features/todo/todoModel'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  RuntimeAdditionalContext,
  RuntimeProjectSpaceRef,
  RuntimeTaskAddress,
  RuntimeTaskCreateRequest,
} from '@/types/api'
export interface PendingTodoBinding {
  paneKey: string
  project: CloudProject
  item: CloudLoopItem | null
  target: RuntimeTaskAddress | null
  description: string
}
export interface PendingAutoJoinResolution {
  target: RuntimeTaskAddress | null
  description: string
}
export interface CloudSubmissionContext {
  additionalContext: RuntimeAdditionalContext | undefined
  cloudProjectId: string | undefined
  origin: RuntimeTaskCreateRequest['origin']
  onRuntimeTaskCreated: (address: RuntimeTaskAddress) => void
}
export interface UseWorkbenchCloudProjectContextOptions {
  active: boolean
  currentRuntimeTask: RuntimeTaskAddress | null
  currentProjectId?: number
  defaultProjectSpace: RuntimeProjectSpaceRef | null
  paneKey: string
  runtimeTaskDescription?: string
  runtimeTaskTitle: string | null
  services?: WorkbenchServices
  userId?: number
}
export interface TaskBoardAssociationState {
  project: CloudProject
  items: CloudLoopItem[]
  loading: boolean
  pending: boolean
}
export interface BoundProjectSpaceContextUpdate {
  task: RuntimeTaskAddress
  project: CloudProject
  item: CloudLoopItem
}
export function runtimeTaskKey(address: RuntimeTaskAddress): string {
  return `${address.deviceId}:${address.taskId}`
}
export function runtimeTaskAddressForBinding(
  identity: RuntimeTaskAddress,
  current: RuntimeTaskAddress | null
): RuntimeTaskAddress {
  return current?.deviceId === identity.deviceId && current.taskId === identity.taskId
    ? current
    : identity
}
export function executionAddressFromContext(
  task: RuntimeTaskAddress,
  context: Awaited<ReturnType<ProjectSpaceTaskContextApi['findCloudContextForTask']>>
): RuntimeTaskAddress | null {
  const execution = context.executionContext
  const modelSelection = context.modelSelection
  if (!execution && !modelSelection) return null
  return {
    ...task,
    ...(execution?.runtime ? { runtime: execution.runtime } : {}),
    ...(execution?.threadId ? { threadId: execution.threadId } : {}),
    ...(execution?.workspacePath ? { workspacePath: execution.workspacePath } : {}),
    ...(execution?.workspaceKind ? { workspaceKind: execution.workspaceKind } : {}),
    ...(execution?.worktreeId ? { worktreeId: execution.worktreeId } : {}),
    ...(modelSelection
      ? {
          runtimeHandle: {
            ...(task.runtimeHandle ?? {}),
            modelSelection,
          },
        }
      : {}),
  }
}
export function cloudLoopItemStatusLabel(
  status: CloudLoopItem['status'],
  t: ReturnType<typeof useTranslation>['t']
): string {
  switch (status) {
    case 'inbox':
      return t('workbench.cloud_todo_status_inbox', '收集箱')
    case 'pending':
      return t('workbench.cloud_todo_status_pending', '待处理')
    case 'in_progress':
      return t('workbench.cloud_todo_status_in_progress', '进行中')
    case 'in_review':
      return t('workbench.cloud_todo_status_in_review', '待评审')
    case 'completed':
      return t('workbench.cloud_todo_status_completed', '已完成')
  }
  return ''
}
export function cloudItemAsLocalWorkItem(
  item: CloudLoopItem,
  runtimeTask: RuntimeTaskAddress
): Omit<LocalWorkItem, 'projectId'> {
  return {
    id: item.id,
    title: item.title,
    objective: '',
    description: item.description,
    state:
      item.status === 'completed'
        ? 'completed'
        : item.status === 'in_review'
          ? 'review'
          : item.status === 'in_progress'
            ? 'started'
            : 'backlog',
    assignee: item.assignee_user_id
      ? { type: 'human', id: String(item.assignee_user_id) }
      : { type: 'unassigned' },
    collaborators: [],
    blocker: '',
    nextAction: '',
    priority: item.priority === 'medium' ? 'normal' : item.priority,
    attachments: [],
    runtimeRefs: [runtimeTask],
    events: [],
    sortOrder: item.sort_order,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  }
}
export function cloudProjectAdditionalContext(
  project: CloudProject | null,
  item: CloudLoopItem | null
): RuntimeAdditionalContext | undefined {
  if (!projectHasModelContext(project, item)) return undefined
  const projectReference = `cloud://projects/${project.id}`
  const todoReference = item ? `${projectReference}/todos/${item.id}` : null
  const scope = item
    ? [
        `Current cloud project: ${project.name} (id=${project.id}).`,
        `Current task: ${item.id} — ${item.title}.`,
        item.description ? `Task description: ${item.description}` : null,
        `Current task reference: ${todoReference}.`,
      ]
    : [
        `Current cloud project: ${project.name} (id=${project.id}).`,
        'No specific task is selected.',
        `Current project reference: ${projectReference}.`,
      ]
  return {
    cloudCollaboration: {
      kind: 'application',
      value: [
        ...scope.filter((line): line is string => Boolean(line)),
        'When the user refers to “this project” or “this task”, use this current cloud context.',
        'Use the wework_space tools to inspect the current Issue and its attachments when needed. Do not ask for an id that is already provided here.',
      ].join('\n'),
    },
  }
}
export function projectHasModelContext(
  project: CloudProject | null,
  item: CloudLoopItem | null
): project is CloudProject {
  if (!project) return false
  if (!isDefaultWorkItemProject(project)) return true
  return Boolean(item?.has_additional_context)
}
export function runtimeContextIdentity(task: RuntimeTaskAddress | null) {
  return task
    ? JSON.stringify([
        task.deviceId,
        task.taskId,
        task.projectSession?.projectId,
        task.projectSession?.issueId,
      ])
    : null
}

export function runtimeContextAddress(address: RuntimeTaskAddress): RuntimeTaskAddress {
  return {
    deviceId: address.deviceId,
    taskId: address.taskId,
    ...(address.projectSession ? { projectSession: address.projectSession } : {}),
  }
}
