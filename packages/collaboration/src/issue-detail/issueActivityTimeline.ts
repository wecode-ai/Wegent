import type { ProjectChatMessage } from '@wegent/chat-core'
import type { SharedIssueAssignmentHistoryEntry, SharedIssueStatusHistoryEntry } from '../types'
import type { IssueActivityThreadModel } from './IssueActivityThread'
import { compareIssueTimestamps, issueThreadActivityTimestamp } from './issueTimestamp'

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

export type IssueActivity = ReturnType<typeof issueActivityTimeline>[number]

export type IssueActivityRow =
  | { kind: 'activity'; activity: IssueActivity }
  | { kind: 'collapsed'; count: number; firstSequence?: number; lastSequence?: number }

/** Keep both ends of a long discussion without mounting its hidden middle. */
export function collapsedIssueActivity(
  activities: readonly IssueActivity[],
  expanded: boolean
): IssueActivityRow[] {
  const row = (activity: IssueActivity): IssueActivityRow => ({ kind: 'activity', activity })
  if (expanded || activities.length <= 20) return activities.map(row)
  let firstSequence = Infinity
  let lastSequence = 0
  for (let index = 2; index < activities.length - 10; index++) {
    const activity = activities[index]
    if (activity.kind !== 'comment') continue
    for (const { sequenceNumber } of [activity.card.root, ...activity.card.replies]) {
      if (Number.isFinite(sequenceNumber) && sequenceNumber > 0) {
        firstSequence = Math.min(firstSequence, sequenceNumber)
        lastSequence = Math.max(lastSequence, sequenceNumber)
      }
    }
  }
  return [
    ...activities.slice(0, 2).map(row),
    {
      kind: 'collapsed',
      count: activities.length - 12,
      ...(lastSequence > 0 ? { firstSequence, lastSequence } : {}),
    },
    ...activities.slice(-10).map(row),
  ]
}
