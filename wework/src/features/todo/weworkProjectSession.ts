import { hydrateRuntimeTaskAddress } from '@/features/workbench/workbenchRuntimeHelpers'
import type { CollaborationIssue } from '@wegent/collaboration'
import type { RuntimeTaskAddress, RuntimeTaskCreateRequest } from '@/types/api'
import type {
  IssueTaskDispatchInput,
  IssueDispatchPersonalTaskAction,
} from '@/features/notifications/NotificationTaskSourceContext'
import { issueDispatchPersonalTaskInput } from '@/features/notifications/NotificationTaskSourceContext'
import { subscribeIssueDispatch } from '@/features/notifications/issueDispatch'
import { resolveHumanTaskDispatch } from './humanTaskDispatch'
import { requireIssueTaskAvailable } from './issueTaskAvailability'
import {
  projectRuntimeStatusSignature,
  workspaceExecutionAddress,
} from './weworkCollaborationRuntime'
import {
  reconcileProjectSpaceTaskBindings,
  sameProjectSpace,
  subscribeProjectSpaceTaskBindingChanged,
  subscribeProjectSpaceTaskContextChanged,
} from './projectSpaceSelection'
import type { WeworkSharedProjectProps } from './weworkCollaborationTypes'

export interface ProjectTaskConversation {
  address?: RuntimeTaskAddress
  issue: CollaborationIssue
  conversationKey: string
  taskRequest?: RuntimeTaskCreateRequest | null
  dispatch?: IssueTaskDispatchInput
  humanTaskBinding?: CollaborationIssue['human_task_binding']
}
interface ProjectSessionSnapshot {
  executionProject: WeworkSharedProjectProps['project']
  taskComposer: ProjectTaskConversation | null
  notice: { message: string; tone: 'success' | 'error' } | null
  refreshProjectRequestKey: number
}
export interface ProjectSessionInput {
  project: WeworkSharedProjectProps['project']
  api: WeworkSharedProjectProps['api']
  projectChatClient: NonNullable<WeworkSharedProjectProps['detailServices']>['projectChatClient']
  standInApi: WeworkSharedProjectProps['services']['standInApi']
  runtimeAvailable: boolean
  personalIssue: WeworkSharedProjectProps['personalIssue']
  focusedItemId: WeworkSharedProjectProps['focusedItemId']
  runtimeWork: WeworkSharedProjectProps['runtimeWork']
  runtimeTaskLifecycle: WeworkSharedProjectProps['runtimeTaskLifecycle']
  detailExpanded: boolean
  locationIssueId: string | null
  navigateIssue(issueId: string): void
  onOpenRuntimeTask: WeworkSharedProjectProps['onOpenRuntimeTask']
  t(key: string, options?: Record<string, unknown>): string
}
export function createWeworkProjectSession({
  project,
  userId,
}: Pick<WeworkSharedProjectProps, 'project' | 'userId'>) {
  let snapshot: ProjectSessionSnapshot = {
    executionProject: project,
    taskComposer: null,
    notice: null,
    refreshProjectRequestKey: 0,
  }
  const observers = new Map<() => void, ProjectSessionInput>()
  let input: ProjectSessionInput | undefined
  let generation = 0
  let operationRevision = 0
  let chatRevision = 0
  let chatOwner: ProjectSessionInput['projectChatClient']
  let conversationSequence = 0
  let issueLookupSequence = 0
  let homeRequestSequence = 0
  let handledHomeRequest: string | undefined
  let pendingHomeRequest: string | undefined
  let started = false
  let releaseBindings: (() => void) | undefined
  let releaseContext: (() => void) | undefined
  let releaseChat: (() => void) | undefined
  let releaseDispatch: (() => void) | undefined
  let dispatchFocus: string | null | undefined
  let runtimeSignature = ''
  let statusTimers: ReturnType<typeof setTimeout>[] = []
  let expandedCallback: ((expanded: boolean) => void) | undefined
  let reportedExpanded: boolean | undefined
  const acceptedDispatches = new Set<string>()
  const active = () => observers.size > 0
  const projectRef = { projectStore: project.project_store, projectId: String(project.id) }
  const publish = (next: Partial<ProjectSessionSnapshot>) => {
    snapshot = { ...snapshot, ...next }
    observers.forEach((_, listener) => listener())
  }
  function reportExpanded() {
    if (!active()) return
    const expanded = Boolean(
      input?.detailExpanded ||
      (snapshot.taskComposer &&
        (!input?.personalIssue || snapshot.taskComposer.issue.id === input.personalIssue.issue.id))
    )
    const callback = input?.personalIssue?.onExpandedChange
    if (expanded === reportedExpanded && callback === expandedCallback) return
    reportedExpanded = expanded
    expandedCallback = callback
    callback?.(expanded)
  }
  function notify(message: string, tone: 'success' | 'error' = 'success') {
    if (active()) publish({ notice: { message, tone } })
  }
  function requestRefresh() {
    if (active()) publish({ refreshProjectRequestKey: snapshot.refreshProjectRequestKey + 1 })
  }
  function refreshRuntimeSignature() {
    const signature = projectRuntimeStatusSignature(input?.runtimeTaskLifecycle, projectRef)
    if (runtimeSignature === signature) return
    runtimeSignature = signature
    statusTimers.forEach(clearTimeout)
    statusTimers = signature ? [0, 500, 1500].map(delay => setTimeout(requestRefresh, delay)) : []
  }
  function closeConversation() {
    conversationSequence++
    publish({ taskComposer: null })
    reportExpanded()
  }
  function showConversation(taskComposer: ProjectTaskConversation) {
    publish({ taskComposer })
    reportExpanded()
    if (input?.locationIssueId !== taskComposer.issue.id)
      input?.navigateIssue(taskComposer.issue.id)
  }
  async function openNewConversation(issue: CollaborationIssue, dispatch?: IssueTaskDispatchInput) {
    const current = input
    if (!current || !active()) return
    if (!current.runtimeAvailable) throw new Error('当前工作台无法打开个人任务')
    const request = ++conversationSequence
    const epoch = generation
    const apiEpoch = operationRevision
    const isCurrent = () =>
      active() &&
      generation === epoch &&
      operationRevision === apiEpoch &&
      request === conversationSequence
    try {
      dispatch ??= await resolveHumanTaskDispatch(
        current.projectChatClient,
        project.id,
        issue.id,
        userId
      )
    } catch (cause) {
      if (isCurrent())
        notify(
          current.t('workbench.issue_task_dispatch_lookup_failed', {
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
          'error'
        )
      return
    }
    if (!isCurrent()) return
    publish({ notice: null })
    const humanTaskBinding = issue.human_task_binding ?? null
    showConversation({
      issue,
      conversationKey: `${issue.id}:new:${request}`,
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
              cloudProjectId: String(project.id),
              origin: {
                type: 'issue_dispatch',
                cloudProjectId: String(project.id),
                loopItemId: issue.id,
                dispatchId: dispatch.dispatchId,
                roundId: dispatch.roundId,
                assignmentId: dispatch.assignmentId,
                humanAssignmentId: dispatch.humanAssignmentId,
              },
            }
          : humanTaskBinding
            ? {
                cloudProjectId: String(project.id),
                origin: {
                  type: 'issue_dispatch',
                  cloudProjectId: String(project.id),
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
  }
  function openIssueExecutionConversation(issue: CollaborationIssue, address: RuntimeTaskAddress) {
    if (!input || !active()) return
    conversationSequence += 1
    const issueExecution = { projectId: String(project.id), issueId: issue.id }
    const resolvedAddress = {
      ...hydrateRuntimeTaskAddress(input.runtimeWork, address),
      issueExecution,
      ...(project.project_store === 'backend' ? { projectSession: issueExecution } : {}),
    }
    showConversation({
      issue,
      address: resolvedAddress,
      conversationKey: `${issue.id}:${resolvedAddress.deviceId}:${resolvedAddress.taskId}`,
    })
  }
  async function openBoundConversation(issue: CollaborationIssue, address: RuntimeTaskAddress) {
    const current = input
    if (!current || !active()) return
    const request = ++conversationSequence
    const epoch = generation
    const isCurrent = () => active() && generation === epoch && request === conversationSequence
    try {
      const bindings = (await current.api.taskBindings?.list(issue.id, String(project.id))) ?? []
      if (!isCurrent()) return
      const taskOwnerUserId = project.project_store === 'local' ? 0 : userId
      const owned = bindings.filter(
        binding =>
          binding.taskId === address.taskId &&
          String(binding.taskUserId) === String(taskOwnerUserId)
      )
      if (!owned.length) throw new Error(current.t('todo.linked_task_unavailable'))
      let binding = owned.find(
        binding =>
          project.project_store === 'backend' &&
          binding.deviceId === address.deviceId &&
          binding.dispatchId &&
          !binding.humanAssignmentId
      )
      if (!binding) {
        const backendDeviceId =
          project.project_store === 'backend'
            ? (await current.standInApi!.deviceIdentity(address.deviceId)).backendDeviceId
            : address.deviceId
        if (!isCurrent()) return
        const available = await requireIssueTaskAvailable(
          owned.find(binding => binding.deviceId === backendDeviceId),
          taskOwnerUserId,
          current.standInApi,
          key => current.t(key)
        )
        if (!isCurrent()) return
        binding = { ...available, deviceId: backendDeviceId }
      }
      const resolved = workspaceExecutionAddress(
        binding,
        current.runtimeWork,
        issue.id,
        project.project_store
      )
      showConversation({
        issue,
        address: resolved,
        conversationKey: `${issue.id}:${resolved.deviceId}:${resolved.taskId}`,
      })
    } catch (cause) {
      if (isCurrent())
        notify(
          cause instanceof Error ? cause.message : current.t('todo.linked_task_unavailable'),
          'error'
        )
    }
  }
  async function answerDispatch(action: IssueDispatchPersonalTaskAction) {
    const epoch = generation
    const current = input
    if (!current) return
    const apiEpoch = operationRevision
    const isCurrent = () => active() && generation === epoch && operationRevision === apiEpoch
    const issue = await current.api.issues.get(action.itemId)
    if (!isCurrent()) return
    const existing = (await current.api.taskBindings?.list(action.itemId, action.projectId))?.find(
      binding => binding.humanAssignmentId === action.humanAssignmentId
    )
    if (!isCurrent()) return
    if (existing) {
      acceptedDispatches.add(action.idempotencyKey)
      const address = workspaceExecutionAddress(
        existing,
        input?.runtimeWork,
        issue.id,
        project.project_store
      )
      if (current.runtimeAvailable) return openBoundConversation(issue, address)
      if (!current?.onOpenRuntimeTask) throw new Error('当前工作台无法打开个人任务')
      await current.onOpenRuntimeTask(address)
      return
    }
    if (acceptedDispatches.has(action.idempotencyKey)) return
    acceptedDispatches.add(action.idempotencyKey)
    try {
      await openNewConversation(issue, action)
    } catch (cause) {
      acceptedDispatches.delete(action.idempotencyKey)
      throw cause
    }
  }
  function continueHomeTask() {
    const current = input
    const request = current?.personalIssue?.taskRequest
    if (
      !current?.personalIssue?.active ||
      !request ||
      request.key === handledHomeRequest ||
      request.key === pendingHomeRequest
    )
      return
    pendingHomeRequest = request.key
    const sequence = ++homeRequestSequence
    const epoch = generation
    const apiEpoch = operationRevision
    const isCurrent = () =>
      active() &&
      generation === epoch &&
      operationRevision === apiEpoch &&
      sequence === homeRequestSequence &&
      input?.personalIssue?.active &&
      input.personalIssue.taskRequest?.key === request.key
    void current.api.issues
      .get(current.personalIssue.issue.id)
      .then(async issue => {
        if (!isCurrent()) return
        handledHomeRequest = request.key
        if (request.address) await openBoundConversation(issue, request.address)
        else if (request.binding)
          await openBoundConversation(
            issue,
            workspaceExecutionAddress(
              request.binding,
              input?.runtimeWork,
              issue.id,
              project.project_store
            )
          )
        else await openNewConversation(issue)
      })
      .catch(cause => {
        if (isCurrent()) notify(String(cause), 'error')
      })
      .finally(() => {
        if (sequence === homeRequestSequence) pendingHomeRequest = undefined
      })
  }
  function bindDispatch() {
    if (releaseDispatch && dispatchFocus === input?.focusedItemId) return
    releaseDispatch?.()
    dispatchFocus = input?.focusedItemId
    releaseDispatch = subscribeIssueDispatch({
      shows: action =>
        active() &&
        action.itemId === input?.focusedItemId &&
        String(action.projectId) === String(project.id),
      answer: action => {
        void answerDispatch(action).catch(cause => {
          if (active()) notify(cause instanceof Error ? cause.message : String(cause), 'error')
        })
      },
    })
  }
  function start() {
    if (started) return
    started = true
    releaseBindings = subscribeProjectSpaceTaskBindingChanged(change => {
      if (!active() || !sameProjectSpace(change.project, projectRef)) return
      requestRefresh()
      refreshRuntimeSignature()
    })
    releaseContext = subscribeProjectSpaceTaskContextChanged(change => {
      if (active() && sameProjectSpace(change.project, projectRef)) requestRefresh()
    })
  }
  function bindChat() {
    const client = input?.projectChatClient
    if (chatOwner === client) return
    chatOwner = client
    const revision = ++chatRevision
    releaseChat?.()
    releaseChat = undefined
    const subscribe = client?.subscribeLoopItemChanges
    if (!subscribe) return
    const epoch = generation
    void subscribe(event => {
      if (
        active() &&
        generation === epoch &&
        chatRevision === revision &&
        event.projectId === String(project.id)
      )
        requestRefresh()
    })
      .then(release => {
        if (generation !== epoch || chatRevision !== revision) {
          release()
          return
        }
        releaseChat = release
      })
      .catch(cause => {
        if (active() && generation === epoch && chatRevision === revision)
          console.warn('[Wework collaboration] issue-change subscription failed', cause)
      })
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void, next: ProjectSessionInput) {
      const previous = input
      if (
        previous &&
        (previous.api !== next.api ||
          previous.projectChatClient !== next.projectChatClient ||
          previous.standInApi !== next.standInApi ||
          previous.runtimeAvailable !== next.runtimeAvailable)
      ) {
        operationRevision++
        conversationSequence++
        issueLookupSequence++
        homeRequestSequence++
        pendingHomeRequest = undefined
      }
      observers.set(listener, next)
      input = next
      if (
        previous &&
        JSON.stringify(previous.project.execution_environment) !==
          JSON.stringify(next.project.execution_environment)
      )
        publish({ executionProject: next.project })
      start()
      bindChat()
      bindDispatch()
      refreshRuntimeSignature()
      continueHomeTask()
      reportExpanded()
      return () => {
        observers.delete(listener)
        input = [...observers.values()].at(-1) ?? input
        queueMicrotask(() => {
          if (active()) return
          generation++
          chatRevision++
          chatOwner = undefined
          conversationSequence++
          issueLookupSequence++
          homeRequestSequence++
          pendingHomeRequest = undefined
          releaseBindings?.()
          releaseBindings = undefined
          releaseContext?.()
          releaseContext = undefined
          releaseChat?.()
          releaseChat = undefined
          releaseDispatch?.()
          releaseDispatch = undefined
          statusTimers.forEach(clearTimeout)
          statusTimers = []
          runtimeSignature = ''
          started = false
          expandedCallback?.(false)
          reportedExpanded = undefined
        })
      }
    },
    projectUpdated(next: WeworkSharedProjectProps['project']) {
      if (
        active() &&
        String(next.id) === String(project.id) &&
        next.project_store === project.project_store
      )
        publish({ executionProject: next })
    },
    notify,
    requestRefresh,
    closeConversation,
    openNewConversation,
    openBoundConversation,
    openIssueExecutionConversation,
    clearNotice() {
      if (active()) publish({ notice: null })
    },
    retainConversationForIssue(issueId: string | null) {
      if (snapshot.taskComposer?.issue.id !== issueId) closeConversation()
    },
    openPersonalIssue(issueId: string | null) {
      const current = input
      const sequence = ++issueLookupSequence
      if (!current?.personalIssue) return false
      if (!issueId || issueId === current.personalIssue.issue.id) return true
      const epoch = generation
      const apiEpoch = operationRevision
      void current.api.issues
        .get(issueId)
        .then(issue => {
          if (
            active() &&
            epoch === generation &&
            apiEpoch === operationRevision &&
            sequence === issueLookupSequence
          )
            input?.personalIssue?.onOpenIssue(issue)
        })
        .catch(cause => {
          if (
            active() &&
            epoch === generation &&
            apiEpoch === operationRevision &&
            sequence === issueLookupSequence
          )
            notify(String(cause), 'error')
        })
      return true
    },
    updateConversationAddress(conversationKey: string, address: RuntimeTaskAddress) {
      if (active() && snapshot.taskComposer?.conversationKey === conversationKey)
        publish({ taskComposer: { ...snapshot.taskComposer, address } })
    },
    reconcileBindings(bindings: { deviceId: string; taskId: string }[]) {
      if (!active()) return
      if (reconcileProjectSpaceTaskBindings(projectRef, bindings)) refreshRuntimeSignature()
    },
  }
}
