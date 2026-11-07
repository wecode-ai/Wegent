import type { RequestUserInputQuestion } from '@wegent/chat-core/runtime'
import { executionDisplayStatus } from './issue-detail/executionStatus'

/** Shared Issue handoff state; execution progress is deliberately independent. */
export interface IssueHumanRequest {
  can_assign?: boolean
  can_reply?: boolean
  id: string
  project_id: string
  issue_id: string
  issue_title?: string
  root_comment_id: string
  source_message_id?: string
  runtime_device_id: string
  runtime_task_id: string
  item_id: string
  question: string
  questions?: RequestUserInputQuestion[]
  recipient_user_id: number | null
  recipient_name: string | null
  responsible_user_id?: number
  responsible_user_name?: string | null
  blocks_progress: boolean
  status: 'pending' | 'answering' | 'resolved' | 'cancelled'
  version: number
  created_at: string
  updated_at: string
  answer_message_id?: string | null
  delivery_error?: 'rejected' | 'uncertain'
  waiting_since?: string
  events?: {
    type:
      | 'requested'
      | 'assigned'
      | 'answered'
      | 'accepted'
      | 'cancelled'
      | 'delivery_rejected'
      | 'delivery_uncertain'
      | 'blocking_changed'
    at: string
    user_id?: number
    from_user_id?: number | null
    to_user_id?: number | null
    message_id?: string
    blocks_progress?: boolean
  }[]
}

export interface IssueParticipationSource {
  status?: string
  assignee_user_id?: number | null
  assignee_name?: string | null
  created_by_user_id?: number
  created_by_user_name?: string | null
  execution_state?: string | null
  ai_state?: { status?: string | null } | null
  human_requests?: readonly IssueHumanRequest[]
  processing_actor?: { kind: 'agent' | 'stand_in'; name: string } | null
  created_at?: string | null
  human_waiting_since?: string | null
  assignment_history?: readonly { to_type: string | null; to_id: string | null; at: string }[]
}

export function pendingIssueHumanRequests(item: IssueParticipationSource): IssueHumanRequest[] {
  if (['completed', 'cancelled', 'archived'].includes(item.status ?? '')) return []
  return (item.human_requests ?? []).filter(
    request => request.status === 'pending' || request.status === 'answering'
  )
}

export function issueParticipation(item: IssueParticipationSource): 'ai' | 'human' | null {
  if (['completed', 'cancelled', 'archived'].includes(item.status ?? '')) return null
  if (pendingIssueHumanRequests(item).length) return 'human'
  return item.processing_actor ||
    executionDisplayStatus(item.execution_state ?? item.ai_state?.status) === 'running'
    ? 'ai'
    : 'human'
}

export function standInProcessingActor(
  handle: Record<string, unknown> | null | undefined,
  running: boolean
) {
  const origin = handle?.origin as Record<string, unknown> | undefined
  return running && origin?.initiatedBy === 'stand_in' && typeof origin.roleName === 'string'
    ? { kind: 'stand_in' as const, name: origin.roleName }
    : undefined
}

export function issueHumanAssignees(
  item: IssueParticipationSource
): { id: number; name: string }[] {
  const ownerId = item.assignee_user_id ?? item.created_by_user_id
  const ownerName =
    (ownerId === item.assignee_user_id ? item.assignee_name : null) ||
    (ownerId === item.created_by_user_id ? item.created_by_user_name : null)
  const requests = pendingIssueHumanRequests(item)
  const targets = requests.length
    ? requests.map(request => {
        const id = request.recipient_user_id ?? request.responsible_user_id ?? ownerId
        const supplied =
          request.recipient_user_id != null ? request.recipient_name : request.responsible_user_name
        return {
          id,
          name:
            supplied ||
            (id === ownerId
              ? ownerName
              : id === item.created_by_user_id
                ? item.created_by_user_name
                : null),
        }
      })
    : [{ id: ownerId, name: ownerName }]
  return targets.flatMap(target =>
    target.id == null ? [] : [{ id: target.id, name: target.name?.trim() || '' }]
  )
}

export function issueNeedsUser(item: IssueParticipationSource, userId: string | number): boolean {
  return (
    issueParticipation(item) === 'human' &&
    issueHumanAssignees(item).some(person => String(person.id) === String(userId))
  )
}

/** Missing historical handoff evidence must not become an invented waiting age. */
export function issueWaitingSince(
  item: IssueParticipationSource & {
    ai_state?: { status?: string | null; completed_at?: string | null } | null
  },
  userId: string | number
): string | null {
  if (!issueNeedsUser(item, userId)) return null
  const requests = pendingIssueHumanRequests(item)
  if (requests.length) {
    const mine = requests.filter(
      request =>
        String(
          request.recipient_user_id ??
            request.responsible_user_id ??
            item.assignee_user_id ??
            item.created_by_user_id
        ) === String(userId)
    )
    const times = mine
      .map(
        request =>
          request.waiting_since ?? (request.recipient_user_id == null ? request.created_at : null)
      )
      .filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value!)))
    return times.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null
  }
  const assignment = [...(item.assignment_history ?? [])]
    .reverse()
    .find(event => event.to_type === 'user' && event.to_id === String(userId))?.at
  const rawCompletion = item.ai_state?.completed_at
  // Legacy execution timestamps are naive UTC, not the viewer's local time.
  const completed =
    item.human_waiting_since ??
    (rawCompletion && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(rawCompletion)
      ? `${rawCompletion.replace(' ', 'T')}Z`
      : rawCompletion)
  if (
    item.execution_state &&
    (!['succeeded', 'failed', 'cancelled', 'skipped'].includes(
      executionDisplayStatus(item.execution_state) ?? ''
    ) ||
      !completed)
  )
    return null
  const candidates = [assignment, completed].filter(
    (value): value is string => Boolean(value) && Number.isFinite(Date.parse(value!))
  )
  if (candidates.length) return candidates.sort((a, b) => Date.parse(b) - Date.parse(a))[0]
  return !item.execution_state &&
    !item.ai_state &&
    String(item.created_by_user_id) === String(userId)
    ? (item.created_at ?? null)
    : null
}
