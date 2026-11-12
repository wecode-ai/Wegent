import type { CollaborationGroup } from '@wegent/collaboration'
import type { ProjectChatClient, ProjectChatMessage } from '@wegent/chat-core'
import type { ChatGroupApi } from '@/api/chatGroups'
import { isPublicStandInMessage } from '@/features/todo/issueActivityRole'
import type { ThreadActionContext } from './threadActions'
import { requireCurrentThreadExecution } from './threadExecutionActions'
import { readThreadChatSnapshot } from './threadChatSnapshot'
import {
  hasCurrentCrewProvenance,
  isCurrentCrewMessage,
  threadAssignmentIdentity,
} from './threadExecutionIdentity'

export function threadCommentRequestsExecution(
  trigger: ProjectChatMessage,
  messages: ProjectChatMessage[]
): boolean {
  const mentions = trigger.metadata.mentions
  if (
    Array.isArray(mentions) &&
    mentions.some(
      value =>
        value &&
        typeof value === 'object' &&
        value.type === 'agent' &&
        typeof value.id === 'string' &&
        value.id
    )
  )
    return true
  const target = trigger.replyToMessageId
    ? messages.find(message => message.messageId === trigger.replyToMessageId)
    : null
  return Boolean(target?.sender.type === 'agent' && !isPublicStandInMessage(target))
}

/** A saved discussion remains saved when AI admission fails; retries reuse its exact ID. */
export async function executeThreadComment({
  context,
  groups,
  chat,
  trigger,
  unavailable,
  isCurrent,
}: {
  context: ThreadActionContext
  groups: ChatGroupApi
  chat: ProjectChatClient
  trigger: ProjectChatMessage
  unavailable: string
  isCurrent(): boolean
}) {
  const current = () => requireCurrentThreadExecution(context, groups, unavailable, isCurrent)
  const item = await current()
  const expectedAssignment = threadAssignmentIdentity(item)
  let expectedCrew: string | null = null
  const crewIdentity = (crew: CollaborationGroup | undefined) =>
    JSON.stringify(
      crew && [crew.id, crew.binding_owner_id, crew.version, crew.leader.kind, crew.leader.id]
    )
  if (!chat.executeTaskComment) throw new Error(unavailable)
  const messages = await readThreadChatSnapshot(
    chat,
    context.group.id,
    item.id,
    unavailable,
    isCurrent
  )
  const saved = messages.find(
    message =>
      message.messageId === trigger.messageId &&
      message.taskId === item.id &&
      message.projectId === context.group.id &&
      message.sender.type === 'user' &&
      message.sender.id === String(context.participation!.current_user_id)
  )
  if (!saved) throw new Error(unavailable)
  if (saved.replyToMessageId) {
    const replyId = saved.replyToMessageId
    const target =
      messages.find(message => message.messageId === replyId) ??
      (
        await readThreadChatSnapshot(
          chat,
          context.group.id,
          item.id,
          unavailable,
          isCurrent,
          replyId
        )
      ).find(message => message.messageId === replyId)
    if (!target || target.taskId !== item.id || target.projectId !== context.group.id)
      throw new Error(unavailable)
    if (target.metadata.dispatch_role === 'manager' || target.metadata.dispatch_role === 'member') {
      const latest = await current()
      if (
        threadAssignmentIdentity(latest) !== threadAssignmentIdentity(item) ||
        !latest.assignee_group_source_id ||
        !context.api.projects.listCollaborationGroups
      )
        throw new Error(unavailable)
      const crews = await context.api.projects.listCollaborationGroups(
        latest.assignee_group_source_id
      )
      const crew = crews.find(crew => crew.id === latest.assignee_group_id)
      const matches =
        target.metadata.dispatch_role === 'manager'
          ? isCurrentCrewMessage(latest, target, crew)
          : hasCurrentCrewProvenance(latest, target, crew)
      if (!matches) throw new Error(unavailable)
      expectedCrew = crewIdentity(crew)
    }
  }
  const latest = await current()
  if (expectedCrew !== null) {
    if (
      threadAssignmentIdentity(latest) !== expectedAssignment ||
      !latest.assignee_group_source_id ||
      !context.api.projects.listCollaborationGroups
    )
      throw new Error(unavailable)
    const crews = await context.api.projects.listCollaborationGroups(
      latest.assignee_group_source_id
    )
    if (crewIdentity(crews.find(crew => crew.id === latest.assignee_group_id)) !== expectedCrew)
      throw new Error(unavailable)
    if (threadAssignmentIdentity(await current()) !== expectedAssignment)
      throw new Error(unavailable)
  }
  return chat.executeTaskComment({
    projectId: context.group.id,
    taskId: item.id,
    triggerMessageId: saved.messageId,
  })
}
