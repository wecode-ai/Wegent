import {
  compareIssueTimestamps,
  issueThreadActivityTimestamp,
  type IssueActivityThreadModel,
  type SharedIssueAssignmentHistoryEntry,
  type SharedIssueStatusHistoryEntry,
} from '@wegent/collaboration'
import type { ProjectChatMessage } from '@/api/backend/projectChatSocket'

export function issueActivityTimeline({
  cards,
  enabled,
  createdAt,
  statusHistory,
  assignmentHistory,
}: {
  cards: IssueActivityThreadModel<ProjectChatMessage>[]
  enabled: boolean
  createdAt?: string
  statusHistory: SharedIssueStatusHistoryEntry[]
  assignmentHistory: SharedIssueAssignmentHistoryEntry[]
}) {
  const comments = cards.map((card, index) => ({
    kind: 'comment' as const,
    at: issueThreadActivityTimestamp(card),
    index,
    card,
  }))
  if (!enabled) return comments
  const creation =
    createdAt && !statusHistory.some(entry => entry.trigger === 'create')
      ? [{ kind: 'created' as const, at: createdAt, index: -1 }]
      : []
  return [
    ...creation,
    ...statusHistory.map((entry, index) => ({
      kind: 'status' as const,
      at: entry.at,
      index,
      entry,
    })),
    ...assignmentHistory.map((entry, index) => ({
      kind: 'assignment' as const,
      at: entry.at,
      index,
      entry,
    })),
    ...comments,
  ].sort((left, right) => {
    const delta = compareIssueTimestamps(left.at, right.at)
    const order = { created: 0, status: 1, assignment: 2, comment: 3 }
    return delta || order[left.kind] - order[right.kind] || left.index - right.index
  })
}
