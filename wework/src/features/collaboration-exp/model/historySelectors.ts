import type { ExperienceTimelineInput, ExperienceTimelineNode } from './types'
import { validSourceTimestamp } from './sourceIdentity'

function historyNode(
  id: string,
  at: string,
  userId: number | null,
  fields: Pick<ExperienceTimelineNode, 'kind'> & Partial<ExperienceTimelineNode>
): ExperienceTimelineNode {
  return {
    id,
    sequenceNumber: null,
    at: validSourceTimestamp(at),
    body: null,
    author: userId === null ? null : { id: String(userId), name: null },
    status: 'completed',
    attachments: [],
    conversation: { state: 'unknown', items: [] },
    executionAddress: null,
    ...fields,
  }
}

export function selectHistoryNodes(input: ExperienceTimelineInput): ExperienceTimelineNode[] {
  const issue = input.issue
  if (!issue) return []
  const assignments =
    issue.assignment_history?.map(entry =>
      historyNode(
        `history:handoff:${JSON.stringify([issue.id, entry.at, entry.by_user_id, entry.to_type, entry.to_id, entry.action])}`,
        entry.at,
        entry.by_user_id,
        {
          kind: 'handoff',
          handoff: {
            action: entry.action,
            targetType: entry.to_type,
            targetId: entry.to_id,
            targetName: entry.to_type === 'user' ? (entry.to_name ?? null) : null,
          },
        }
      )
    ) ??
    (input.assignments ?? [])
      .filter(entry => entry.issue_id === issue.id)
      .map(entry =>
        historyNode(`history:assignment:${entry.id}`, entry.created_at, entry.created_by_user_id, {
          kind: 'handoff',
          author: { id: String(entry.created_by_user_id), name: entry.created_by_user_name },
          handoff: {
            action: 'assign',
            targetType: entry.target_type === 'human' ? 'user' : entry.target_type,
            targetId: entry.target_id,
            targetName: entry.target_type === 'human' ? entry.target_name : null,
          },
        })
      )
  const statuses = (issue.status_history ?? []).map(entry =>
    historyNode(
      `history:status:${JSON.stringify([issue.id, entry.at, entry.by_user_id, entry.from_status, entry.to_status, entry.trigger])}`,
      entry.at,
      entry.by_user_id,
      {
        kind: 'status',
        transition: {
          from: entry.from_status_name ?? entry.from_status,
          to: entry.to_status_name ?? entry.to_status,
        },
      }
    )
  )
  return [...new Map([...assignments, ...statuses].map(node => [node.id, node])).values()].sort(
    (a, b) =>
      (a.at && b.at ? Date.parse(a.at) - Date.parse(b.at) : a.at ? -1 : b.at ? 1 : 0) ||
      a.id.localeCompare(b.id)
  )
}

/** Insert persisted facts without changing the canonical message sequence. */
export function mergeHistoryNodes(
  messages: ExperienceTimelineNode[],
  history: ExperienceTimelineNode[]
): ExperienceTimelineNode[] {
  const nodes = [...messages]
  for (const node of history) {
    const before = node.at
      ? nodes.findIndex(
          candidate => candidate.at && Date.parse(candidate.at) > Date.parse(node.at!)
        )
      : -1
    nodes.splice(before < 0 ? nodes.length : before, 0, node)
  }
  return nodes
}
