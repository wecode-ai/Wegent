import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import {
  findProjectSpaceContextForTask,
  isDefaultWorkItemProject,
  publishProjectSpaceTaskBindingChanged,
  projectSpaceRef,
  type ProjectSpaceTaskContextApi,
} from '@/features/todo/projectSpaceSelection'
import { rememberProjectTaskStore } from '@/features/workbench/projectTaskTracking'
import type { LocalWorkItem } from '@/features/todo/todoModel'
import type { RuntimeAdditionalContext, RuntimeTaskAddress } from '@/types/api'
import type { useTranslation } from '@/hooks/useTranslation'

interface PendingTodoBinding {
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

const pendingTodoBindingsByPane = new Map<string, PendingTodoBinding>()
const pendingTodoBindingsByTask = new Map<string, PendingTodoBinding>()
export interface BoundProjectSpaceContextUpdate {
  task: RuntimeTaskAddress
  project: CloudProject
  item: CloudLoopItem
}

const boundProjectSpaceContextListeners = new Set<
  (update: BoundProjectSpaceContextUpdate) => void
>()
const PENDING_BINDING_CONTEXT_RETRY_MS = 100
const PENDING_BINDING_CONTEXT_RETRY_LIMIT = 50

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

export function pendingBindingFor(
  address: RuntimeTaskAddress | null,
  paneKey: string
): PendingTodoBinding | null {
  return address
    ? (pendingTodoBindingsByTask.get(runtimeTaskKey(address)) ?? null)
    : (pendingTodoBindingsByPane.get(paneKey) ?? null)
}

export function storePendingBinding(binding: PendingTodoBinding) {
  if (binding.target) {
    pendingTodoBindingsByTask.set(runtimeTaskKey(binding.target), binding)
    pendingTodoBindingsByPane.delete(binding.paneKey)
    return
  }
  pendingTodoBindingsByPane.set(binding.paneKey, binding)
}

export function clearPendingBinding(binding: PendingTodoBinding) {
  pendingTodoBindingsByPane.delete(binding.paneKey)
  if (binding.target) pendingTodoBindingsByTask.delete(runtimeTaskKey(binding.target))
}

export function pendingBindingTargetsTask(address: RuntimeTaskAddress): boolean {
  return pendingTodoBindingsByTask.has(runtimeTaskKey(address))
}

export function publishBoundProjectSpaceContext(update: BoundProjectSpaceContextUpdate) {
  rememberProjectTaskStore(update.task, update.project.project_store)
  publishProjectSpaceTaskBindingChanged({
    task: update.task,
    project: projectSpaceRef(update.project),
    type: 'bound',
  })
  const pendingBinding = pendingTodoBindingsByTask.get(runtimeTaskKey(update.task))
  if (pendingBinding) clearPendingBinding(pendingBinding)
  for (const listener of boundProjectSpaceContextListeners) listener(update)
}

export async function waitForPendingProjectSpaceContext(
  apis: ProjectSpaceTaskContextApi[],
  task: RuntimeTaskAddress,
  shouldContinue: () => boolean
) {
  let lastError: unknown
  for (let attempt = 0; attempt <= PENDING_BINDING_CONTEXT_RETRY_LIMIT; attempt += 1) {
    try {
      return await findProjectSpaceContextForTask(apis, task)
    } catch (error) {
      lastError = error
      if (
        attempt === PENDING_BINDING_CONTEXT_RETRY_LIMIT ||
        !shouldContinue() ||
        !pendingBindingTargetsTask(task)
      ) {
        throw error
      }
      await new Promise(resolve => window.setTimeout(resolve, PENDING_BINDING_CONTEXT_RETRY_MS))
    }
  }
  throw lastError
}

export function pendingTodoForTask(address: RuntimeTaskAddress | null, paneKey: string) {
  return pendingBindingFor(address, paneKey)?.item ?? null
}

export function pendingProjectForTask(address: RuntimeTaskAddress | null, paneKey: string) {
  return pendingBindingFor(address, paneKey)?.project ?? null
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

export function subscribeBoundProjectSpaceContext(
  listener: (update: BoundProjectSpaceContextUpdate) => void
) {
  boundProjectSpaceContextListeners.add(listener)
  return () => {
    boundProjectSpaceContextListeners.delete(listener)
  }
}
