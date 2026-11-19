import { projectSpaceKey } from './projectSpaceSelection'
import type {
  WeworkStandardBoardUpdate,
  LocatedCloudProject,
  LocatedLoopItem,
  TaskComposerRequest,
} from './cloudTodoWorkspaceTypes'
import { toCloudLoopItem, automationSelectionCandidates } from './cloudTodoWorkspaceSupport'
import type { CloudTodoWorkspaceObservation } from './cloudTodoWorkspaceObservation'
import type { CloudLoopItem } from '@/api/deliveries'
import { runnerEnvironmentError, type CollaborationProject } from '@wegent/collaboration'
import {
  executeStandardCloudBoardMutation,
  mergePersistedBoardMove,
  type ProjectBoardColumn,
  type StandardCloudBoardMutation,
} from '@wegent/collaboration/project-board'
import { track } from '@/telemetry/client'
import { runtimeConversationKey } from '@/features/workbench/runtimeConversationCache'
import type { RuntimeTaskAddress } from '@/types/api'
import {
  canEditProjectSpaceIssue,
  projectSpaceRef,
  sameProjectSpace,
} from './projectSpaceSelection'
import { projectExecutionEnvironmentTaskRequest } from './projectExecutionEnvironmentTaskRequest'
import { shouldPrepareWorkItemTask, workItemTaskInput } from './workItemTaskInput'
import type { createCloudTodoWorkspaceState } from './cloudTodoWorkspaceState'
import { locateBoardItems as locateItems } from './cloudTodoLocalBoard'
import { findCloudTodoProject } from './cloudTodoWorkspaceSupport'
export function createCloudTodoBoardMutations(
  state: ReturnType<typeof createCloudTodoWorkspaceState>,
  getObservation: () => CloudTodoWorkspaceObservation | undefined
) {
  async function performStandardBoardMove(
    item: LocatedLoopItem,
    column: ProjectBoardColumn,
    beforeItemId: string | null,
    mutation: StandardCloudBoardMutation<LocatedLoopItem>,
    automationRuleId?: string
  ): Promise<boolean> {
    const input = getObservation()
    if (!input) throw new Error('项目空间当前不可用')
    const { notificationChoice, t, boardTranslate, workbench, runtimeTasksByKey, nativeGroupBy } =
      input
    const cloudWorkspaceApi = input.cloudApi,
      cloudWorkspace = input.cloud,
      cloudWorkspaceMessages = { saveFailed: '云端协作数据保存失败' },
      user = input.props.user
    const activeItemTaskBindings = input.taskBindings,
      runtimeAddressesByWorkItem = input.runtimeAddressesByWorkItem
    const projectForItem = (item: Pick<LocatedLoopItem, 'cloud_project_id' | 'project_store'>) =>
      findCloudTodoProject(input.projects, input.project, item)
    const apiForProject = (project: LocatedCloudProject | null | undefined) =>
      project?.location === 'local' ? input.localApi : undefined
    const isAITableProject = input.project?.task_provider === 'dingtalk_aitable'
    const isProcessingStatus = (status: string) => {
      const index = input.nativeStatuses.findIndex(candidate => candidate.id === status)
      return input.processingStartIndex >= 0 && index >= input.processingStartIndex
    }
    const valid = () => {
      const latest = getObservation()
      return Boolean(
        latest &&
        latest.props.user.id === input.props.user.id &&
        latest.cloudApi === input.cloudApi &&
        latest.localApi === input.localApi &&
        sameProjectSpace(
          latest.project ? projectSpaceRef(latest.project) : null,
          input.project ? projectSpaceRef(input.project) : null
        )
      )
    }
    const {
      setSelectedItem,
      setItems,
      setBackgroundTaskItemId,
      setPendingAutomationSelection,
      setSelectedTaskBinding,
      setBoardError,
    } = state
    const openTaskComposer = (request: TaskComposerRequest) => {
      if (!valid()) return
      input.workbench?.projectChat.requestCatalogs?.()
      state.update({
        taskPanelSessionId: state.getSnapshot().taskPanelSessionId + 1,
        taskComposerRequest: request,
      })
    }

    if (!canEditProjectSpaceIssue(item) || isAITableProject) return false
    const enteringExecution = mutation.kind === 'status' && isProcessingStatus(mutation.status)
    const forceStart =
      mutation.kind === 'status' && item.status === 'pending' && isProcessingStatus(mutation.status)
    const itemProject = projectForItem(item)
    const notifyAssignee =
      mutation.kind === 'assignee' &&
      mutation.assigneeType === 'user' &&
      Number(mutation.assigneeId) !== user.id &&
      Number(mutation.assigneeId) !== item.assignee_user_id &&
      item.project_store === 'backend'
        ? await notificationChoice.request()
        : true
    if (notifyAssignee === null || !valid()) return false
    const taskBindingCount = Math.max(
      activeItemTaskBindings[item.id]?.length ?? 0,
      runtimeAddressesByWorkItem.get(`${item.cloud_project_id}:${item.id}`)?.length ?? 0
    )
    const acceptPersistedMove = (updated: CloudLoopItem) => {
      if (!valid()) return
      const locatedUpdated = { ...updated, project_store: item.project_store }
      if (itemProject?.location === 'local') {
        setItems(current =>
          mutation.position
            ? mergePersistedBoardMove(current, locatedUpdated, mutation.position)
            : current.map(candidate => (candidate.id === updated.id ? locatedUpdated : candidate))
        )
      }
      setSelectedItem(current => (current?.id === updated.id ? locatedUpdated : current))
    }
    setBoardError(null)
    try {
      const itemApi = apiForProject(itemProject)
      if (!itemProject || (itemProject.location === 'cloud' ? !cloudWorkspaceApi : !itemApi)) {
        throw new Error('项目空间当前不可用')
      }
      const assignItem =
        itemProject.location === 'cloud' || typeof itemApi!.assignLoopItem === 'function'
          ? async (
              target: LocatedLoopItem,
              assignment: {
                assigneeId: string
                assigneeType: 'user' | 'agent' | 'team'
                notifyAssignee: boolean
                position?: { beforeItemId: string | null }
              }
            ): Promise<CloudLoopItem> =>
              itemProject.location === 'cloud'
                ? cloudWorkspace.commands
                    .assignIssue(String(target.cloud_project_id), target.id, {
                      version: target.version,
                      assigneeType: assignment.assigneeType,
                      assigneeId: assignment.assigneeId,
                      notifyAssignee: assignment.notifyAssignee,
                      position: assignment.position,
                    })
                    .then(updated => {
                      if (!updated) throw new Error(cloudWorkspaceMessages.saveFailed)
                      return toCloudLoopItem(updated)
                    })
                : itemApi!.assignLoopItem!(target.cloud_project_id, target.id, {
                    version: target.version,
                    assigneeType: assignment.assigneeType,
                    assigneeId: assignment.assigneeId,
                    notifyAssignee: assignment.notifyAssignee,
                    position: assignment.position,
                  })
          : undefined
      const updated = await executeStandardCloudBoardMutation<
        LocatedLoopItem,
        WeworkStandardBoardUpdate
      >({
        additionalUpdate: {
          ...(automationRuleId ? { automation_rule_id: automationRuleId } : {}),
        },
        commands: {
          update: (target, update) =>
            updateStandardBoardItem(
              target,
              update,
              input.project ? projectSpaceKey(projectSpaceRef(input.project)) : null
            ),
          assign: assignItem,
          refreshOrder: async saved => {
            acceptPersistedMove(saved)
            if (!valid()) return
            if (itemProject.location === 'cloud') {
              await cloudWorkspace.commands.loadProjectSnapshot(String(item.cloud_project_id), {
                invalidate: true,
                throwOnError: true,
              })
            } else {
              const saved = await itemApi!.listLoopItems(item.cloud_project_id)
              if (!valid()) return
              setItems(current => [
                ...current.filter(
                  candidate =>
                    candidate.cloud_project_id !== item.cloud_project_id ||
                    candidate.project_store !== item.project_store
                ),
                ...locateItems(saved.items, itemProject.location === 'local' ? 'local' : 'backend'),
              ])
            }
          },
        },
        item,
        mutation,
        notifyAssignee,
      })
      if (!valid()) return true
      const locatedUpdated = { ...updated, project_store: item.project_store }
      if (!mutation.position) acceptPersistedMove(updated)
      const shouldOpenTaskComposer =
        enteringExecution &&
        shouldPrepareWorkItemTask(locatedUpdated, item.status, taskBindingCount)
      if (shouldOpenTaskComposer) {
        const initialInput = workItemTaskInput(locatedUpdated)
        const preparedEnvironmentTaskRequest = projectExecutionEnvironmentTaskRequest(
          itemProject as CollaborationProject
        )
        setSelectedTaskBinding(null)
        setSelectedItem(locatedUpdated)
        setBackgroundTaskItemId(
          mutation.kind === 'status' && mutation.status === 'in_progress' ? locatedUpdated.id : null
        )
        openTaskComposer({
          workItemId: locatedUpdated.id,
          initialInput,
          backgroundAfterSend: column.status === 'in_progress',
          taskRequest:
            preparedEnvironmentTaskRequest || forceStart
              ? {
                  ...preparedEnvironmentTaskRequest,
                  runtime: 'codex',
                  message: initialInput,
                  ...(forceStart ? { forceStart: true } : {}),
                }
              : undefined,
        })
      } else if (forceStart && workbench) {
        const addresses = new Map<string, RuntimeTaskAddress>()
        for (const binding of activeItemTaskBindings[item.id] ?? []) {
          const address = { deviceId: binding.device_id, taskId: binding.task_id }
          addresses.set(runtimeConversationKey(address), address)
        }
        for (const address of runtimeAddressesByWorkItem.get(
          `${item.cloud_project_id}:${item.id}`
        ) ?? []) {
          addresses.set(runtimeConversationKey(address), address)
        }
        const queuedAddresses = [...addresses.values()].filter(address => {
          const task = runtimeTasksByKey.get(runtimeConversationKey(address))
          return task?.status?.trim().toLowerCase() === 'queued'
        })
        const forceStartResults = await Promise.allSettled(
          queuedAddresses.map(address => workbench.forceStartRuntimeTask(address))
        )
        const failedForceStart = forceStartResults.find(result => result.status === 'rejected')
        if (failedForceStart?.status === 'rejected') {
          console.error('[Wework project board] queued task force start failed', {
            itemId: locatedUpdated.id,
            error: failedForceStart.reason,
          })
          setBoardError(t('workbench.runtime_task_force_start_failed'))
        }
      }
      track('board_item_moved', {
        group_by: nativeGroupBy,
        reordered: beforeItemId !== null,
        source: projectForItem(item)?.location ?? 'unknown',
      })
      return true
    } catch (cause) {
      if (!valid()) return false
      const candidates = automationSelectionCandidates(cause)
      if (candidates && !automationRuleId) {
        setBoardError(null)
        setPendingAutomationSelection({
          candidates,
          onCancel: () => setPendingAutomationSelection(null),
          onConfirm: async selectedAutomationId => {
            if (!valid()) throw new Error('Project context changed')
            const moved = await performStandardBoardMove(
              item,
              column,
              beforeItemId,
              mutation,
              selectedAutomationId
            )
            if (!moved) {
              throw new Error(
                t('todo.automation_selection_move_failed', '移动 Issue 失败，请重新选择')
              )
            }
            setPendingAutomationSelection(null)
          },
        })
        return false
      }
      setBoardError(
        runnerEnvironmentError(cause, boardTranslate) ??
          (cause instanceof Error ? cause.message : '移动任务失败')
      )
      track('operation_failed', { operation: 'board_item_move' })
      return false
    }
  }
  async function updateStandardBoardItem(
    target: LocatedLoopItem,
    update: WeworkStandardBoardUpdate,
    expectedProjectKey?: string | null
  ): Promise<CloudLoopItem> {
    const input = getObservation()
    if (!input) throw new Error('项目空间当前不可用')
    if (
      expectedProjectKey !== undefined &&
      (input.project ? projectSpaceKey(projectSpaceRef(input.project)) : null) !==
        expectedProjectKey
    )
      throw new Error('Project context changed')
    const cloudWorkspaceApi = input.cloudApi,
      cloudWorkspace = input.cloud,
      cloudWorkspaceMessages = { saveFailed: '云端协作数据保存失败' }
    const projectForItem = (item: Pick<LocatedLoopItem, 'cloud_project_id' | 'project_store'>) =>
      findCloudTodoProject(input.projects, input.project, item)
    const apiForProject = (project: LocatedCloudProject | null | undefined) =>
      project?.location === 'local' ? input.localApi : undefined

    const project = projectForItem(target)
    const itemApi = apiForProject(project)
    if (!project || (project.location === 'cloud' ? !cloudWorkspaceApi : !itemApi)) {
      throw new Error('项目空间当前不可用')
    }
    if (project.location === 'local') {
      return itemApi!.updateLoopItem(target.id, {
        version: target.version,
        ...update,
      })
    }
    return cloudWorkspace.commands
      .updateIssue(
        target.id,
        {
          version: target.version,
          position: update.position,
          status: update.status,
          priority: update.priority,
          assigneeUserId: update.assignee_user_id,
          assigneeAgentId: update.assignee_agent_id,
          assigneeTeamId: update.assignee_team_id,
          tags: update.tags,
        },
        { throwOnError: true }
      )
      .then(updated => {
        if (!updated) throw new Error(cloudWorkspaceMessages.saveFailed)
        return toCloudLoopItem(updated)
      })
  }
  return { performStandardBoardMove, updateStandardBoardItem }
}
