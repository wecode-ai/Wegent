import type { CloudTodoWorkspaceProps } from './cloudTodoWorkspaceTypes'
import { runtimeTaskBindingAddress } from './runtimeTaskBindingAddress'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { AITableField } from '@/api/aitable'
import { ApiError } from '@/api/http'
import { type CollaborationProject, type SharedWorkspaceApi } from '@wegent/collaboration'
import { ProjectBoardGroupPicker } from '@wegent/collaboration/project-board'
import { resolveWorkbenchDeviceId } from '@/lib/workbench-device'
import {
  findRuntimeTask,
  hydrateRuntimeTaskAddress,
} from '@/features/workbench/workbenchRuntimeHelpers'
import { type AutomationSelectionCandidate } from '@/features/todo/AutomationSelectionDialog'
import type {
  DeviceInfo,
  ModelSelectionConfig,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
} from '@/types/api'
import { type CloudTodoBoardTaskBinding } from './CloudTodoBoardCard'
import { projectSpaceRef, sameProjectSpace } from './projectSpaceSelection'
import type {
  LocatedCloudProject,
  LocatedLoopItem,
  TaskBindingAddressInput,
} from './cloudTodoWorkspaceTypes'
export function formatCompactFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
export const nativeBoardGroupFields: AITableField[] = [
  { id: 'status', name: '状态', type: 'status', config: null, raw: {} },
  { id: 'priority', name: '优先级', type: 'singleSelect', config: null, raw: {} },
  { id: 'assignee', name: '负责人', type: 'user', config: null, raw: {} },
  { id: 'tag', name: '标签', type: 'tag', config: null, raw: {} },
]
export const nativeBoardStatusColors: Record<
  CloudLoopItem['status'],
  'gray' | 'blue' | 'orange' | 'purple' | 'green'
> = {
  inbox: 'gray',
  pending: 'blue',
  in_progress: 'orange',
  in_review: 'purple',
  completed: 'green',
}
export const externalBoardColumnPageSize = 10
export function aitableCellLabels(value: unknown): string[] {
  if (value === null || value === undefined || value === '') return []
  return (Array.isArray(value) ? value : [value])
    .map(entry => {
      if (typeof entry === 'object' && entry !== null) {
        const object = entry as Record<string, unknown>
        return String(object.name ?? object.title ?? object.text ?? '')
      }
      return String(entry)
    })
    .filter(Boolean)
}
export const AITableGroupFieldPicker = ProjectBoardGroupPicker
export function toWeworkCloudProject(project: CollaborationProject): CloudProject {
  return project as CloudProject
}
export function toCloudLoopItem(issue: Awaited<ReturnType<SharedWorkspaceApi['issues']['get']>>) {
  return issue as CloudLoopItem
}
export function boardTaskModelSelection(
  binding: CloudTodoBoardTaskBinding,
  runtimeWork: RuntimeWorkListResponse | null | undefined
): ModelSelectionConfig | null {
  if (binding.modelSelection) return binding.modelSelection

  return (
    findRuntimeTask(runtimeWork, {
      deviceId: binding.device_id,
      taskId: binding.task_id,
    })?.modelSelection ?? null
  )
}
export function withBoardTaskModelSelection(
  binding: CloudTodoBoardTaskBinding,
  runtimeWork: RuntimeWorkListResponse | null | undefined
): CloudTodoBoardTaskBinding {
  return {
    ...binding,
    modelSelection: boardTaskModelSelection(binding, runtimeWork),
  }
}
export function selectedTaskBindingAddress(
  binding: TaskBindingAddressInput,
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  devices: DeviceInfo[]
): RuntimeTaskAddress {
  return hydrateRuntimeTaskAddress(runtimeWork, {
    ...runtimeTaskBindingAddress(binding),
    deviceId: resolveWorkbenchDeviceId(devices, binding.device_id) ?? binding.device_id,
  })
}
export function cloudProjectRequestError(cause: unknown): string {
  if (!(cause instanceof ApiError)) {
    return cause instanceof Error ? cause.message : '创建项目空间失败'
  }
  if (cause.status === 422) {
    const payload = cause.detail as { errors?: Array<{ loc?: string[]; msg?: string }> } | undefined
    const fieldError = payload?.errors?.[0]
    return fieldError?.msg
      ? `${fieldError.loc?.at(-1) ?? '参数'}：${fieldError.msg}`
      : '项目标识只能包含 2–16 位字母和数字'
  }
  if (cause.status === 404) {
    return '项目空间接口返回 404，请重启当前分支的 Backend 后重试'
  }
  return cause.message || `创建项目空间失败（HTTP ${cause.status}）`
}
export function automationSelectionCandidates(
  cause: unknown
): AutomationSelectionCandidate[] | null {
  if (
    !(cause instanceof ApiError) ||
    cause.status !== 409 ||
    cause.errorCode !== 'automation_selection_required'
  ) {
    return null
  }
  const detail = cause.detail
  if (!detail || typeof detail !== 'object' || !('candidates' in detail)) return null
  const candidates = (detail as { candidates?: unknown }).candidates
  if (!Array.isArray(candidates)) return null
  const normalized = candidates.flatMap(candidate => {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      !('id' in candidate) ||
      !('name' in candidate) ||
      typeof candidate.id !== 'string' ||
      typeof candidate.name !== 'string'
    ) {
      return []
    }
    return [
      {
        id: candidate.id,
        name: candidate.name,
        description:
          'description' in candidate && typeof candidate.description === 'string'
            ? candidate.description
            : '',
      },
    ]
  })
  return normalized.length > 1 ? normalized : null
}
export function findCloudTodoProject(
  projects: LocatedCloudProject[],
  selected: LocatedCloudProject | null,
  item: Pick<LocatedLoopItem, 'cloud_project_id' | 'project_store'>
) {
  if (item.project_store)
    return projects.find(project =>
      sameProjectSpace(projectSpaceRef(project), {
        projectStore: item.project_store!,
        projectId: item.cloud_project_id,
      })
    )
  const matches = projects.filter(project => project.id === item.cloud_project_id)
  const selectedMatch = selected
    ? matches.find(project => sameProjectSpace(projectSpaceRef(project), projectSpaceRef(selected)))
    : undefined
  return selectedMatch ?? (matches.length === 1 ? matches[0] : undefined)
}

export function cloudTodoIssueResourceKey(
  item: LocatedLoopItem | null,
  project: LocatedCloudProject | undefined,
  userId: CloudTodoWorkspaceProps['user']['id']
) {
  return item && project
    ? JSON.stringify([
        project.project_store,
        project.id,
        item.id,
        userId,
        project.current_user_id,
        project.access_role,
        item.can_view_detail,
      ])
    : null
}
