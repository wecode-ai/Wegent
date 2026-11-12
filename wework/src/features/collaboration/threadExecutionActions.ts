import type { CollaborationGroup, CollaborationIssue } from '@wegent/collaboration'
import type { ProjectChatClient, ProjectChatMessage } from '@wegent/chat-core'
import type { ChatGroupApi } from '@/api/chatGroups'
import { humanTaskDispatchInput } from '@/features/todo/humanTaskDispatch'
import { requestIssueDispatch } from '@/features/notifications/issueDispatch'
import type { ThreadActionContext } from './threadActions'
import { hasThreadWorkOwner } from './threadPersonalTaskAccess'
import { readThreadChatSnapshot } from './threadChatSnapshot'
import {
  currentThreadExecutionTarget,
  currentThreadHumanDispatch,
  threadAssignmentIdentity,
} from './threadExecutionIdentity'

export function canOperateThreadExecution(context: ThreadActionContext | null) {
  return Boolean(
    context &&
    hasThreadWorkOwner(context) &&
    context.group.status === 'active' &&
    context.group.role !== 'Viewer' &&
    context.participation?.joined &&
    context.participation.can_comment &&
    context.item.permissions?.execute === true
  )
}

/** UI snapshots never authorize an execution or a queued cancellation. */
export async function requireCurrentThreadExecution(
  context: ThreadActionContext,
  groups: ChatGroupApi,
  unavailable: string,
  isCurrent: () => boolean
): Promise<CollaborationIssue> {
  if (!isCurrent() || !canOperateThreadExecution(context)) throw new Error(unavailable)
  const actor = context.participation?.current_user_id
  const [item, participation, { group }] = await Promise.all([
    context.api.issues.get(context.item.id),
    groups.participation(context.item.id),
    groups.get(context.group.id),
  ])
  const current = { ...context, item, participation, group }
  if (
    !isCurrent() ||
    participation.current_user_id !== actor ||
    !canOperateThreadExecution(current)
  )
    throw new Error(unavailable)
  return item
}

export function createThreadExecutionActions({
  context,
  groups,
  chat,
  unavailable,
  isCurrent,
  onChanged,
}: {
  context: ThreadActionContext
  groups: ChatGroupApi
  chat?: ProjectChatClient
  unavailable: string
  isCurrent(): boolean
  onChanged(): void
}) {
  const expectedAssignment = threadAssignmentIdentity(context.item)
  const current = async () => {
    const item = await requireCurrentThreadExecution(context, groups, unavailable, isCurrent)
    if (threadAssignmentIdentity(item) !== expectedAssignment) throw new Error(unavailable)
    return item
  }
  const currentCrew = async (item: CollaborationIssue): Promise<CollaborationGroup | null> => {
    if (!item.assignee_group_id) return null
    if (!item.assignee_group_source_id || !context.api.projects.listCollaborationGroups)
      throw new Error(unavailable)
    const crews = await context.api.projects.listCollaborationGroups(item.assignee_group_source_id)
    const crew = crews.find(
      value =>
        value.id === item.assignee_group_id &&
        (value.binding_owner_id == null || value.binding_owner_id === item.assignee_group_source_id)
    )
    if (!crew) throw new Error(unavailable)
    await current()
    return crew
  }
  const changed = () => {
    if (isCurrent()) onChanged()
  }
  const snapshot = async () => {
    if (!chat) throw new Error(unavailable)
    return readThreadChatSnapshot(chat, context.group.id, context.item.id, unavailable, isCurrent)
  }
  const crewIdentity = (crew: CollaborationGroup | null) =>
    JSON.stringify(
      crew && [crew.id, crew.binding_owner_id, crew.version, crew.leader.kind, crew.leader.id]
    )
  const requireSameCrew = async (item: CollaborationIssue, expected: string) => {
    const crew = await currentCrew(item)
    if (crewIdentity(crew) !== expected) throw new Error(unavailable)
    return crew
  }
  const resolveHumanTask = async () => {
    const item = await current()
    const expected = crewIdentity(await currentCrew(item))
    const messages = await snapshot()
    const latest = await current()
    const crew = await requireSameCrew(latest, expected)
    const dispatch = currentThreadHumanDispatch(
      latest,
      messages,
      crew,
      context.participation!.current_user_id
    )
    if (!dispatch) throw new Error(unavailable)
    return { item: latest, dispatch }
  }
  return {
    resolveHumanTask,
    async accept() {
      const item = await current()
      if (item.status !== 'in_review' || item.permissions?.edit_content !== true)
        throw new Error(unavailable)
      await context.api.issues.update(item.id, { version: item.version, status: 'completed' })
      changed()
    },
    async approve() {
      const item = await current()
      if (!item.can_approve || item.execution_state !== 'waiting_approval')
        throw new Error(unavailable)
      await context.api.issues.approveRun(context.group.id, item.id, item.version)
      changed()
    },
    async reject(reason: string) {
      const item = await current()
      if (!item.can_approve || item.execution_state !== 'waiting_approval')
        throw new Error(unavailable)
      await context.api.issues.rejectRun(
        context.group.id,
        item.id,
        item.version,
        reason.trim() || undefined
      )
      changed()
    },
    async stop(message: ProjectChatMessage) {
      const item = await current()
      const executionId = Number(message.metadata.execution_id)
      if (
        !context.api.executions ||
        !Number.isSafeInteger(executionId) ||
        executionId <= 0 ||
        message.taskId !== item.id
      )
        throw new Error(unavailable)
      const executions = await context.api.executions.list(context.group.id, {
        includeTerminal: true,
      })
      const execution = executions.find(
        value =>
          value.id === executionId &&
          value.loop_item_id === item.id &&
          String(value.cloud_project_id) === context.group.id
      )
      if (!isCurrent() || !execution) throw new Error(unavailable)
      await current()
      await context.api.executions.stop(context.group.id, executionId)
      changed()
    },
    async rerun() {
      const item = await current()
      if (!chat?.executeTaskComment) throw new Error(unavailable)
      const expected = crewIdentity(await currentCrew(item))
      const messages = await snapshot()
      const latest = await current()
      const crew = await requireSameCrew(latest, expected)
      const target = currentThreadExecutionTarget(latest, messages, crew)
      if (!target) throw new Error(unavailable)
      const trigger = await chat.send({
        containerKind: 'chat_group',
        projectId: context.group.id,
        taskId: item.id,
        clientMessageId: crypto.randomUUID(),
        text:
          typeof item.automation?.prompt === 'string' && item.automation.prompt.trim()
            ? item.automation.prompt
            : [item.title, item.description].filter(Boolean).join('\n\n'),
        replyToMessageId: target.messageId,
      })
      await requireSameCrew(await current(), expected)
      await chat.executeTaskComment({
        projectId: context.group.id,
        taskId: item.id,
        triggerMessageId: trigger.messageId,
      })
      changed()
    },
    async startHumanTask() {
      const { item, dispatch } = await resolveHumanTask()
      requestIssueDispatch({
        ...humanTaskDispatchInput(dispatch),
        projectId: context.group.id,
        itemId: item.id,
        issueId: item.id,
        dispatchTaskId: dispatch.humanAssignmentId,
        idempotencyKey: `${context.accountScope}:${context.group.id}:${item.id}:${dispatch.humanAssignmentId}`,
      })
    },
  }
}
