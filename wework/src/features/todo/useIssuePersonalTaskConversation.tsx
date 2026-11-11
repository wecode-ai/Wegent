import { useStableEvent } from '@/features/workbench/useStableEvent'
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type {
  CollaborationIssue,
  CollaborationProject,
  SharedWorkspaceApi,
  WeworkWorkspaceRuntimePort,
} from '@wegent/collaboration'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { loopItemLocalProject } from '@/api/localProjectAssociation'
import type {
  ProjectSpaceDetailServices,
  WorkbenchServices,
} from '@/features/workbench/workbenchServices'
import { toWorkspaceRuntimeTaskAddress } from '@/features/workbench/projectTaskTracking'
import type {
  ProjectWithTasks,
  RuntimeTaskAddress,
  RuntimeTaskCreateRequest,
  RuntimeWorkListResponse,
} from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import {
  issueDispatchPersonalTaskInput,
  type IssueTaskDispatchInput,
  type IssueDispatchPersonalTaskAction,
} from '@/features/notifications/NotificationTaskSourceContext'
import { resolveHumanTaskDispatch } from './humanTaskDispatch'
import { requireIssueTaskAvailable } from './issueTaskAvailability'
import { workspaceExecutionAddress } from './collaborationTaskAddress'
import { AiChatModal } from './AiChatModal'
import { updateIssueWhenPersonalTaskStarts, workItemComposerReference } from './workItemTaskInput'
import {
  loadProjectSpaceCodeWorkspacePreference,
  saveProjectSpaceCodeWorkspacePreference,
} from './projectSpaceCodeWorkspacePreference'
import { publishProjectSpaceTaskBindingChanged } from './projectSpaceSelection'

export type IssueRuntimeBindingPort = Pick<WeworkWorkspaceRuntimePort, 'bindTask' | 'unbindTask'>
export interface IssuePersonalTaskComposer {
  address?: RuntimeTaskAddress
  issue: CollaborationIssue
  conversationKey: string
  taskRequest?: RuntimeTaskCreateRequest | null
  dispatch?: IssueTaskDispatchInput
  humanTaskBinding?: CollaborationIssue['human_task_binding']
}

export function useIssuePersonalTaskState() {
  const [taskComposer, setTaskComposer] = useState<IssuePersonalTaskComposer | null>(null)
  const taskComposerSequenceRef = useRef(0)
  const active = useRef(true)
  const acceptedDispatchTaskActions = useRef(new Set<string>())
  const closeTaskConversation = useCallback(() => {
    taskComposerSequenceRef.current += 1
    setTaskComposer(null)
  }, [])
  useLayoutEffect(() => {
    active.current = true
    return () => {
      active.current = false
      taskComposerSequenceRef.current += 1
    }
  }, [])
  return {
    taskComposer,
    setTaskComposer,
    taskComposerSequenceRef,
    acceptedDispatchTaskActions,
    closeTaskConversation,
    active,
  }
}

export function useIssuePersonalTaskConversation({
  state,
  project,
  latestProjectRef,
  api: scopedApi,
  detailServices,
  userId,
  taskOwnerUserId,
  services,
  runtimePort,
  runtimeWork,
  localProjects,
  onOpenRuntimeTask,
  onOpenIssue,
  locationIssueId,
  notify,
  clearNotice,
  onChanged,
  beforeStart,
  embedded = true,
  open = true,
  onClosed,
}: {
  state: ReturnType<typeof useIssuePersonalTaskState>
  project: CollaborationProject
  latestProjectRef: RefObject<CollaborationProject>
  api: SharedWorkspaceApi
  detailServices?: ProjectSpaceDetailServices
  userId: string | number
  taskOwnerUserId: string | number
  services: WorkbenchServices
  runtimePort?: IssueRuntimeBindingPort
  runtimeWork?: RuntimeWorkListResponse | null
  localProjects: ProjectWithTasks[]
  onOpenRuntimeTask?(address: RuntimeTaskAddress): Promise<void> | void
  onOpenIssue(issueId: string): void
  locationIssueId: string | null
  notify(message: string, tone?: 'success' | 'error'): void
  clearNotice(): void
  onChanged(): void
  beforeStart?(issue: CollaborationIssue): Promise<void>
  embedded?: boolean
  open?: boolean
  onClosed?(): void
}) {
  const { t } = useTranslation('common')
  const scope = useMemo(
    () => ({ api: scopedApi, owner: `${project.project_store}:${project.id}:${userId}` }),
    [scopedApi, project.project_store, project.id, userId]
  )
  const currentScope = useRef<typeof scope | null>(scope)
  useLayoutEffect(() => {
    currentScope.current = scope
    return () => {
      if (currentScope.current === scope) currentScope.current = null
    }
  }, [scope])
  const {
    taskComposer,
    setTaskComposer,
    taskComposerSequenceRef,
    acceptedDispatchTaskActions,
    closeTaskConversation,
    active,
  } = state
  const openNewTaskConversation = useStableEvent(
    async (issue: CollaborationIssue, dispatch?: IssueTaskDispatchInput) => {
      if (!active.current) return
      if (!runtimePort) throw new Error('当前工作台无法打开个人任务')
      const requestSequence = ++taskComposerSequenceRef.current
      try {
        dispatch ??= await resolveHumanTaskDispatch(
          detailServices?.projectChatClient,
          project.id,
          issue.id,
          userId,
          project.resource_type === 'chat_group' ? 'chat_group' : 'project'
        )
      } catch (cause) {
        if (requestSequence !== taskComposerSequenceRef.current || currentScope.current !== scope)
          return
        notify(
          t('workbench.issue_task_dispatch_lookup_failed', {
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
          'error'
        )
        return
      }
      if (requestSequence !== taskComposerSequenceRef.current || currentScope.current !== scope)
        return
      clearNotice()
      const humanTaskBinding = issue.human_task_binding ?? null
      const currentProject = latestProjectRef.current
      setTaskComposer({
        issue,
        conversationKey: `${issue.id}:new:${requestSequence}`,
        dispatch,
        humanTaskBinding,
        taskRequest: {
          schemaVersion: 2,
          runtime: 'codex',
          message: '',
          ...(dispatch
            ? {
                message: issueDispatchPersonalTaskInput(dispatch),
                title: dispatch.taskTitle,
                cloudProjectId: String(currentProject.id),
                origin: {
                  type: 'issue_dispatch',
                  cloudProjectId: String(currentProject.id),
                  loopItemId: issue.id,
                  dispatchId: dispatch.dispatchId,
                  roundId: dispatch.roundId,
                  assignmentId: dispatch.assignmentId,
                  humanAssignmentId: dispatch.humanAssignmentId,
                },
              }
            : humanTaskBinding
              ? {
                  cloudProjectId: String(currentProject.id),
                  origin: {
                    type: 'issue_dispatch',
                    cloudProjectId: String(currentProject.id),
                    loopItemId: issue.id,
                    dispatchId: humanTaskBinding.dispatchId,
                    roundId: humanTaskBinding.dispatchRoundId,
                    assignmentId: humanTaskBinding.assignmentId,
                    humanAssignmentId: humanTaskBinding.humanAssignmentId,
                  },
                }
              : {}),
        },
      })
      if (locationIssueId !== issue.id) {
        onOpenIssue(issue.id)
      }
    }
  )
  const openBoundTaskConversation = useStableEvent(
    async (issue: CollaborationIssue, address: RuntimeTaskAddress) => {
      if (!active.current) return
      const requestSequence = ++taskComposerSequenceRef.current
      try {
        const latestBinding = (
          await scopedApi.taskBindings?.list(issue.id, String(project.id))
        )?.find(
          binding => binding.deviceId === address.deviceId && binding.taskId === address.taskId
        )
        const availableBinding = await requireIssueTaskAvailable(
          latestBinding,
          taskOwnerUserId,
          services.standInApi,
          key => t(key)
        )
        if (requestSequence !== taskComposerSequenceRef.current || currentScope.current !== scope)
          return
        const resolvedAddress = workspaceExecutionAddress(
          availableBinding,
          runtimeWork,
          issue.id,
          project.project_store
        )
        setTaskComposer({
          issue,
          address: resolvedAddress,
          conversationKey: `${issue.id}:${resolvedAddress.deviceId}:${resolvedAddress.taskId}`,
        })
        onOpenIssue(issue.id)
      } catch (error) {
        if (requestSequence !== taskComposerSequenceRef.current || currentScope.current !== scope)
          return
        notify(error instanceof Error ? error.message : t('todo.linked_task_unavailable'), 'error')
      }
    }
  )

  /** Open the personal task an assignment notification hands to this reader. */
  const answerIssueDispatch = useStableEvent(async (action: IssueDispatchPersonalTaskAction) => {
    if (!active.current) return
    const requestSequence = taskComposerSequenceRef.current
    const issue = await scopedApi.issues.get(action.itemId)
    const existing = (await scopedApi.taskBindings?.list(action.itemId, action.projectId))?.find(
      binding => binding.humanAssignmentId === action.humanAssignmentId
    )
    if (
      !active.current ||
      requestSequence !== taskComposerSequenceRef.current ||
      currentScope.current !== scope
    )
      return
    if (existing) {
      acceptedDispatchTaskActions.current.add(action.idempotencyKey)
      const address = workspaceExecutionAddress(
        existing,
        runtimeWork,
        issue.id,
        project.project_store
      )
      if (runtimePort) {
        await openBoundTaskConversation(issue, address)
        return
      }
      if (!onOpenRuntimeTask) throw new Error('当前工作台无法打开个人任务')
      await onOpenRuntimeTask(address)
      return
    }
    if (acceptedDispatchTaskActions.current.has(action.idempotencyKey)) return
    acceptedDispatchTaskActions.current.add(action.idempotencyKey)
    try {
      await openNewTaskConversation(issue, action)
    } catch (cause) {
      acceptedDispatchTaskActions.current.delete(action.idempotencyKey)
      throw cause
    }
  })

  const codeWorkspacePreference = loadProjectSpaceCodeWorkspacePreference(userId, {
    projectStore: project.project_store,
    projectId: String(project.id),
  })
  const issueLocalProjectId = taskComposer
    ? (loopItemLocalProject(taskComposer.issue as unknown as CloudLoopItem)?.id ?? null)
    : null
  const initialLocalProjectId =
    issueLocalProjectId ?? codeWorkspacePreference?.localProjectId ?? null
  const initialDeviceWorkspaceId =
    initialLocalProjectId === codeWorkspacePreference?.localProjectId
      ? (codeWorkspacePreference?.deviceWorkspaceId ?? null)
      : null
  const conversationSequence = taskComposerSequenceRef.current
  const isCurrentConversation = () =>
    active.current &&
    conversationSequence === taskComposerSequenceRef.current &&
    currentScope.current === scope
  const conversationPanel =
    taskComposer && runtimePort ? (
      <AiChatModal
        key={taskComposer.conversationKey}
        project={project as unknown as CloudProject}
        localProjects={localProjects}
        task={taskComposer.issue as unknown as CloudLoopItem}
        initialLocalProjectId={initialLocalProjectId}
        initialDeviceWorkspaceId={initialDeviceWorkspaceId}
        initialTaskRequest={taskComposer.taskRequest}
        taskTitle={taskComposer.dispatch?.taskTitle}
        open={open}
        embedded={embedded}
        initialTaskInput={
          taskComposer.dispatch
            ? `${workItemComposerReference(project, taskComposer.issue)} ${issueDispatchPersonalTaskInput(taskComposer.dispatch)}`
            : workItemComposerReference(project, taskComposer.issue)
        }
        initialAddress={taskComposer.address}
        onClose={() => {
          closeTaskConversation()
          onClosed?.()
        }}
        onAddressChange={address => {
          setTaskComposer(current =>
            current?.conversationKey === taskComposer.conversationKey
              ? { ...current, address }
              : current
          )
        }}
        onOpenRuntimeTask={onOpenRuntimeTask}
        prepareTask={async address => {
          const ensureActive = () => {
            if (!isCurrentConversation()) throw new Error(t('todo.linked_task_unavailable'))
          }
          ensureActive()
          await beforeStart?.(taskComposer.issue)
          ensureActive()
          const sharedTask = toWorkspaceRuntimeTaskAddress(address)
          await runtimePort.bindTask(
            taskComposer.issue.id,
            sharedTask,
            taskComposer.dispatch?.taskTitle ?? taskComposer.issue.title,
            taskComposer.dispatch
              ? {
                  humanAssignmentId: taskComposer.dispatch.humanAssignmentId,
                  dispatchId: taskComposer.dispatch.dispatchId,
                  dispatchRoundId: taskComposer.dispatch.roundId,
                  assignmentId: taskComposer.dispatch.assignmentId,
                }
              : (taskComposer.humanTaskBinding ?? null)
          )
          const projectRef = {
            projectStore: project.project_store,
            projectId: String(project.id),
          }
          publishProjectSpaceTaskBindingChanged({
            task: address,
            project: projectRef,
            type: 'bound',
          })
          const rollback = async () => {
            await runtimePort.unbindTask(taskComposer.issue.id, sharedTask)
            publishProjectSpaceTaskBindingChanged({
              task: address,
              project: projectRef,
              type: 'unbound',
            })
          }
          if (!isCurrentConversation()) {
            await rollback()
            ensureActive()
          }
          // Finish UI-owned writes before the runtime can mutate the same Issue version.
          const statusUpdateError = await updateIssueWhenPersonalTaskStarts(
            scopedApi.issues,
            taskComposer.issue.id
          )
          if (statusUpdateError !== null) {
            notify(statusUpdateError || t('task_board_status_update_failed'), 'error')
          }
          if (!isCurrentConversation()) {
            await rollback()
            ensureActive()
          }
          return rollback
        }}
        onTaskCreated={async (address, localProject, deviceWorkspaceId) => {
          if (!isCurrentConversation()) return
          if (localProject) {
            saveProjectSpaceCodeWorkspacePreference(
              userId,
              {
                projectStore: project.project_store,
                projectId: String(project.id),
              },
              {
                localProjectId: localProject.id,
                deviceWorkspaceId,
              }
            )
          }
          setTaskComposer(current =>
            current?.conversationKey === taskComposer.conversationKey
              ? { ...current, address }
              : current
          )
          onChanged()
        }}
      />
    ) : null

  return {
    openNewTaskConversation,
    openBoundTaskConversation,
    answerIssueDispatch,
    conversationPanel,
  }
}
