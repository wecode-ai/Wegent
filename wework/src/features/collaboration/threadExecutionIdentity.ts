import {
  humanDispatchAssignment,
  type CollaborationGroup,
  type CollaborationIssue,
} from '@wegent/collaboration'
import type { ProjectChatMessage } from '@wegent/chat-core'
import { isPublicStandInMessage } from '@/features/todo/issueActivityRole'

export function threadAssignmentIdentity(item: CollaborationIssue): string {
  return JSON.stringify([
    item.id,
    item.cloud_project_id,
    item.assignee_user_id ?? null,
    item.assignee_agent_id ?? null,
    item.assignee_team_id ?? null,
    item.assignee_group_id ?? null,
    item.assignee_group_source_id ?? null,
  ])
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Only server-projected provenance can identify a historical manager's resource. */
export function hasCurrentCrewProvenance(
  item: CollaborationIssue,
  message: ProjectChatMessage,
  crew: CollaborationGroup | null | undefined
): boolean {
  if (
    !crew ||
    !item.assignee_group_id ||
    !item.assignee_group_source_id ||
    crew.id !== item.assignee_group_id ||
    (crew.binding_owner_id != null && crew.binding_owner_id !== item.assignee_group_source_id) ||
    message.taskId !== item.id ||
    message.projectId !== String(item.cloud_project_id)
  )
    return false
  const provenance = record(message.metadata.collaboration_group)
  const leader = record(provenance?.leader)
  if (
    provenance?.id !== crew.id ||
    provenance.binding_owner_id !== item.assignee_group_source_id ||
    leader?.kind !== crew.leader.kind ||
    leader.id !== crew.leader.id
  )
    return false
  return true
}

export function isCurrentCrewMessage(
  item: CollaborationIssue,
  message: ProjectChatMessage,
  crew: CollaborationGroup | null | undefined
): boolean {
  if (!crew || !hasCurrentCrewProvenance(item, message, crew)) return false
  return crew.leader.kind === 'agent'
    ? message.sender.type === 'agent' &&
        typeof message.metadata.manager_agent_id === 'string' &&
        message.sender.id === message.metadata.manager_agent_id
    : message.sender.type === 'user' && message.sender.id === crew.leader.id
}

export function currentThreadExecutionTarget(
  item: CollaborationIssue,
  messages: ProjectChatMessage[],
  crew?: CollaborationGroup | null
): ProjectChatMessage | undefined {
  return messages.findLast(
    message =>
      message.taskId === item.id &&
      message.projectId === String(item.cloud_project_id) &&
      message.sender.type === 'agent' &&
      !isPublicStandInMessage(message) &&
      (item.assignee_group_id
        ? message.metadata.dispatch_role === 'manager' && isCurrentCrewMessage(item, message, crew)
        : Boolean(item.assignee_agent_id) && message.sender.id === item.assignee_agent_id)
  )
}

export function currentThreadHumanDispatch(
  item: CollaborationIssue,
  messages: ProjectChatMessage[],
  crew: CollaborationGroup | null | undefined,
  actor: string | number
) {
  const latest = messages.findLast(
    message => message.metadata.activity_type === 'manager_assignment'
  )
  if (!latest || !isCurrentCrewMessage(item, latest, crew)) return null
  return humanDispatchAssignment([latest], actor)
}
