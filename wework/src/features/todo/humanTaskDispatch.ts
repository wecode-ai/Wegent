import type { HumanDispatchAssignment } from '@wegent/collaboration'
import type { IssueTaskDispatchInput } from '@/features/notifications/NotificationTaskSourceContext'

/**
 * Adapts a manager assignment read from the Issue timeline into the dispatch
 * binding every task composer accepts. The reply is the member's instruction,
 * so it becomes the prompt while the assigned work item stays the title.
 */
export function humanTaskDispatchInput(
  assignment: HumanDispatchAssignment,
  replyText: string
): IssueTaskDispatchInput {
  return {
    humanAssignmentId: assignment.humanAssignmentId,
    dispatchId: assignment.dispatchId,
    roundId: assignment.roundId,
    assignmentId: assignment.assignmentId,
    taskTitle: assignment.taskTitle,
    instructions: replyText,
    ...(assignment.workflowStageId ? { workflowStageId: assignment.workflowStageId } : {}),
  }
}
