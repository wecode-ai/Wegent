import type {
  LocatedCloudProject,
  LoopItemTaskBinding,
  CloudTodoWorkspaceProps,
} from './cloudTodoWorkspaceTypes'
import { selectedTaskBindingAddress } from './cloudTodoWorkspaceSupport'
import { createBoardTaskBindings } from './boardTaskBindings'
import { createBoardRuntimeGoalLoader } from './boardRuntimeGoal'
import { useCallback, useMemo } from 'react'
import type { CloudLoopItem } from '@/api/deliveries'
import { isDefaultWorkItemProject } from '@/api/deliveries'
import {
  useCollaborationWorkspaceController,
  type SharedIssueDetailTaskExecutionState,
} from '@wegent/collaboration'
import { runtimeConversationKey } from '@/features/workbench/runtimeConversationCache'
import {
  isRuntimeTaskExecutionRunning,
  runtimeTaskTrackingExecutionStatus,
} from '@/features/workbench/runtimeTaskLifecycle/projection'
import type {
  DeviceInfo,
  RuntimeProjectSpaceRef,
  RuntimeTaskAddress,
  RuntimeTaskSummary,
  RuntimeWorkListResponse,
} from '@/types/api'
import { runtimeTaskConversationStatusesByAddress } from './runtimeTaskConversationStatus'
import { projectSpaceKey, projectSpaceRef } from './projectSpaceSelection'
import {
  projectRuntimeStatusSignature,
  toWeworkIssueTaskBinding,
} from './WeworkCollaborationPlatform'
import { loopItemLocalProject } from '@/api/localProjectAssociation'
import { runtimeWorkItemReference } from './runtimeMyWork'
import type { CloudTodoWorkspaceState } from './cloudTodoWorkspaceState'
interface RuntimeProjectionInput
  extends
    Pick<
      CloudTodoWorkspaceProps,
      'user' | 'localProjects' | 'runtimeWork' | 'runtimeTaskLifecycle' | 'services'
    >,
    Pick<
      CloudTodoWorkspaceState,
      | 'localProjectFilter'
      | 'localItemTaskBindings'
      | 'itemTaskBindingsProjectKey'
      | 'assigneeQuickAddRequest'
    > {
  workbenchDevices: DeviceInfo[]
  selectedProject: LocatedCloudProject | null
  selectedProjectRef: RuntimeProjectSpaceRef | null
  cloudWorkspace: ReturnType<typeof useCollaborationWorkspaceController>
  taskOwnerUserId: string | number
  runtimeTaskExecutionStatusByAddress: ReturnType<typeof runtimeTaskConversationStatusesByAddress>
}
export function useCloudTodoRuntimeProjection({
  user,
  localProjects,
  runtimeWork,
  runtimeTaskLifecycle,
  services,
  workbenchDevices,
  selectedProject,
  selectedProjectRef,
  localProjectFilter,
  cloudWorkspace,
  localItemTaskBindings,
  itemTaskBindingsProjectKey,
  assigneeQuickAddRequest,
  taskOwnerUserId,
  runtimeTaskExecutionStatusByAddress,
}: RuntimeProjectionInput) {
  const localProjectOptions = useMemo(() => {
    const runtimeProjectOrder = new Map(
      (runtimeWork?.projects ?? []).flatMap((entry, index) =>
        entry.project.id ? [[entry.project.id, index] as const] : []
      )
    )
    return [...localProjects].sort((left, right) => {
      const leftOrder = runtimeProjectOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER
      const rightOrder = runtimeProjectOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER
      return leftOrder - rightOrder || left.name.localeCompare(right.name, 'zh-CN')
    })
  }, [localProjects, runtimeWork])
  const isMyTasksBoard = isDefaultWorkItemProject(selectedProject)
  const runtimeTaskStatusSignature =
    isMyTasksBoard && runtimeTaskLifecycle
      ? [...runtimeTaskLifecycle.tasks.entries()]
          .flatMap(([key, lifecycle]) => {
            const status = runtimeTaskTrackingExecutionStatus(lifecycle)
            return status ? [`${key}:${status}`] : []
          })
          .sort()
          .join('|')
      : selectedProjectRef
        ? projectRuntimeStatusSignature(runtimeTaskLifecycle, selectedProjectRef)
        : ''
  const activeLocalProjectFilter =
    localProjectFilter === '' || localProjectFilter === 'all'
      ? 'all'
      : localProjectOptions.some(project => String(project.id) === localProjectFilter)
        ? localProjectFilter
        : 'all'
  const selectedLocalProject =
    localProjectOptions.find(project => String(project.id) === activeLocalProjectFilter) ?? null
  const runtimeProjectIdByTask = useMemo(() => {
    const result = new Map<string, number>()
    for (const projectWork of runtimeWork?.projects ?? []) {
      if (!projectWork.project.id) continue
      for (const workspace of projectWork.deviceWorkspaces) {
        for (const task of workspace.tasks) {
          result.set(`${workspace.deviceId}:${task.taskId}`, projectWork.project.id)
        }
      }
    }
    return result
  }, [runtimeWork])
  const runtimeTasksByKey = useMemo(() => {
    const result = new Map<string, RuntimeTaskSummary>()
    const workspaces = [
      ...(runtimeWork?.projects ?? []).flatMap(projectWork => projectWork.deviceWorkspaces),
      ...(runtimeWork?.chats ?? []),
    ]
    for (const workspace of workspaces) {
      for (const task of workspace.tasks) {
        result.set(
          runtimeConversationKey({
            deviceId: workspace.deviceId,
            taskId: task.taskId,
          }),
          task
        )
      }
    }
    return result
  }, [runtimeWork])
  const runtimeTaskKeys = useMemo(() => {
    const keys = new Set(runtimeTasksByKey.keys())
    for (const lifecycle of runtimeTaskLifecycle?.tasks.values() ?? []) {
      keys.add(runtimeConversationKey(lifecycle.address))
    }
    return keys
  }, [runtimeTaskLifecycle, runtimeTasksByKey])
  const runtimeAddressesByWorkItem = useMemo(() => {
    const result = new Map<string, RuntimeTaskAddress[]>()
    const workspaces = [
      ...(runtimeWork?.projects ?? []).flatMap(projectWork => projectWork.deviceWorkspaces),
      ...(runtimeWork?.chats ?? []),
    ]
    for (const workspace of workspaces) {
      for (const task of workspace.tasks) {
        const reference = runtimeWorkItemReference(task)
        if (!reference) continue
        const key = `${reference.projectId}:${reference.itemId}`
        const addresses = result.get(key) ?? []
        addresses.push({
          deviceId: workspace.deviceId,
          taskId: task.taskId,
          runtime: task.runtime,
          threadId: task.threadId,
          workspacePath: task.workspacePath || workspace.workspacePath,
          runtimeHandle: task.runtimeHandle,
        })
        result.set(key, addresses)
      }
    }
    return result
  }, [runtimeWork])
  const runtimeTaskRunningByAddress = useMemo(() => {
    const result = new Map<string, boolean>()
    const workspaces = [
      ...(runtimeWork?.projects ?? []).flatMap(projectWork => projectWork.deviceWorkspaces),
      ...(runtimeWork?.chats ?? []),
    ]
    for (const workspace of workspaces) {
      for (const task of workspace.tasks) {
        result.set(
          runtimeConversationKey({
            deviceId: workspace.deviceId,
            taskId: task.taskId,
          }),
          isRuntimeTaskExecutionRunning(task)
        )
      }
    }
    return result
  }, [runtimeWork])
  const runtimeTaskByAddress = useMemo(() => {
    const result = new Map<
      string,
      {
        workspace: RuntimeWorkListResponse['projects'][number]['deviceWorkspaces'][number]
        task: RuntimeWorkListResponse['projects'][number]['deviceWorkspaces'][number]['tasks'][number]
      }
    >()
    const workspaces = [
      ...(runtimeWork?.projects ?? []).flatMap(projectWork => projectWork.deviceWorkspaces),
      ...(runtimeWork?.chats ?? []),
    ]
    for (const workspace of workspaces) {
      for (const task of workspace.tasks) {
        result.set(runtimeConversationKey({ deviceId: workspace.deviceId, taskId: task.taskId }), {
          workspace,
          task,
        })
      }
    }
    return result
  }, [runtimeWork])
  const selectedProjectKey = selectedProject
    ? projectSpaceKey(projectSpaceRef(selectedProject))
    : null
  const activeAssigneeQuickAddRequest =
    assigneeQuickAddRequest?.projectKey === selectedProjectKey ? assigneeQuickAddRequest : null
  const activeItemTaskBindings = useMemo(() => {
    const refreshedBindings =
      itemTaskBindingsProjectKey === selectedProjectKey
        ? Object.values(localItemTaskBindings).flat()
        : null
    const bindings =
      refreshedBindings ??
      (selectedProject?.location === 'cloud'
        ? cloudWorkspace.state.taskBindings.map(toWeworkIssueTaskBinding)
        : [])
    const ownBindings = bindings.filter(
      binding => String(binding.task_user_id) === String(taskOwnerUserId)
    )
    const visibleBindings = isMyTasksBoard
      ? ownBindings.filter(binding =>
          runtimeTaskKeys.has(
            runtimeConversationKey({
              deviceId: binding.device_id,
              taskId: binding.task_id,
            })
          )
        )
      : ownBindings
    const byItem: Record<string, LoopItemTaskBinding[]> = {}
    for (const binding of visibleBindings) {
      if (!binding.loop_item_id) continue
      byItem[binding.loop_item_id] = [...(byItem[binding.loop_item_id] ?? []), binding]
    }
    return byItem
  }, [
    cloudWorkspace.state.taskBindings,
    itemTaskBindingsProjectKey,
    isMyTasksBoard,
    localItemTaskBindings,
    runtimeTaskKeys,
    selectedProject?.location,
    selectedProjectKey,
    taskOwnerUserId,
  ])
  const taskExecutionStatesByBindingId = useMemo(() => {
    const states: Record<string, SharedIssueDetailTaskExecutionState> = {}
    for (const binding of Object.values(activeItemTaskBindings).flat()) {
      const status = runtimeTaskExecutionStatusByAddress.get(
        runtimeConversationKey({ deviceId: binding.device_id, taskId: binding.task_id })
      )
      if (status) states[String(binding.id)] = { status }
    }
    return states
  }, [activeItemTaskBindings, runtimeTaskExecutionStatusByAddress])
  const boardTaskBindings = useMemo(
    () =>
      createBoardTaskBindings({
        bindings: activeItemTaskBindings,
        runtimeTasks: runtimeTaskByAddress,
        running: runtimeTaskRunningByAddress,
        addressForBinding: binding =>
          selectedTaskBindingAddress(binding, runtimeWork, workbenchDevices),
      }),
    [
      activeItemTaskBindings,
      runtimeTaskByAddress,
      runtimeTaskRunningByAddress,
      runtimeWork,
      workbenchDevices,
    ]
  )
  const loadBoardTaskRuntimeGoal = useMemo(
    () => createBoardRuntimeGoalLoader(services.runtimeWorkApi, user.id),
    [services.runtimeWorkApi, user.id]
  )
  const localProjectIdForItem = useCallback(
    (item: CloudLoopItem): number | null => {
      const storedAssociation = loopItemLocalProject(item)
      if (storedAssociation) return storedAssociation.id
      for (const binding of activeItemTaskBindings[item.id] ?? []) {
        const projectId = runtimeProjectIdByTask.get(`${binding.device_id}:${binding.task_id}`)
        if (projectId) return projectId
      }
      return null
    },
    [activeItemTaskBindings, runtimeProjectIdByTask]
  )

  return {
    localProjectOptions,
    isMyTasksBoard,
    runtimeTaskStatusSignature,
    activeLocalProjectFilter,
    selectedLocalProject,
    runtimeProjectIdByTask,
    runtimeTasksByKey,
    runtimeTaskKeys,
    runtimeAddressesByWorkItem,
    runtimeTaskRunningByAddress,
    runtimeTaskByAddress,
    selectedProjectKey,
    activeAssigneeQuickAddRequest,
    activeItemTaskBindings,
    taskExecutionStatesByBindingId,
    boardTaskBindings,
    loadBoardTaskRuntimeGoal,
    localProjectIdForItem,
  }
}
