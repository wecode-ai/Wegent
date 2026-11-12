import type { CollaborationAssignment, CollaborationIssue } from '@wegent/collaboration'

export function isPersonalTaskAssignee(
  item: Pick<
    CollaborationIssue,
    'assignee_user_id' | 'assignee_agent_id' | 'assignee_group_id' | 'assignee_team_id'
  >,
  currentUserId: string | number,
  assignment?: CollaborationAssignment | null
): boolean {
  if (item.assignee_user_id !== null) {
    return String(item.assignee_user_id) === String(currentUserId)
  }
  if (item.assignee_agent_id || item.assignee_group_id || item.assignee_team_id) return false
  if (assignment?.status === 'active') {
    return (
      assignment.target_type === 'human' && String(assignment.target_id) === String(currentUserId)
    )
  }
  return true
}
