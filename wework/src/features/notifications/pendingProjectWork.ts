import {
  issueNeedsUser,
  pendingIssueHumanRequests,
  type IssueParticipationSource,
  type IssueParticipationViewer,
} from '@wegent/collaboration'

/** Ownership alone cannot recreate work after its explicit questions were handled. */
export function projectIssueNeedsInput(
  item: IssueParticipationSource,
  viewer: IssueParticipationViewer
): boolean {
  if (!issueNeedsUser(item, viewer)) return false
  if (pendingIssueHumanRequests(item).length || !item.human_requests?.length) return true

  // A later explicit assignment is new work; edits and execution completion are not.
  const assignment = item.assignment_history?.at(-1)
  if (
    assignment?.to_type !== 'user' ||
    String(assignment.to_id) !== String(item.assignee_user_id ?? item.created_by_user_id)
  )
    return false
  const assignedAt = Date.parse(assignment.at)
  return item.human_requests.every(request => assignedAt > Date.parse(request.updated_at))
}
