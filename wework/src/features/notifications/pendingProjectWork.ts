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

  return projectIssueAssignedAfter(
    item,
    viewer,
    Math.max(...item.human_requests.map(request => Date.parse(request.updated_at)))
  )
}

/** A later explicit assignment is new work; edits and execution completion are not. */
export function projectIssueAssignedAfter(
  item: IssueParticipationSource,
  viewer: IssueParticipationViewer,
  handledAt: number
): boolean {
  const assignment = item.assignment_history?.at(-1)
  if (
    assignment?.to_type !== 'user' ||
    String(assignment.to_id) !== String(item.assignee_user_id ?? item.created_by_user_id)
  )
    return false
  return (
    issueNeedsUser({ ...item, human_requests: [] }, viewer) && Date.parse(assignment.at) > handledAt
  )
}
