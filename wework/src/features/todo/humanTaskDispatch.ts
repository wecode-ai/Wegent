import { humanDispatchAssignment, type HumanDispatchAssignment } from '@wegent/collaboration'
import type { ProjectChatClient } from '@wegent/chat-core'
import type { IssueTaskDispatchInput } from '@/features/notifications/NotificationTaskSourceContext'

/**
 * Adapts a manager assignment read from the Issue timeline into the dispatch
 * binding every task composer accepts. Human acknowledgments stay in the
 * discussion; only the assigned work belongs in the task instructions.
 */
export function humanTaskDispatchInput(
  assignment: HumanDispatchAssignment
): IssueTaskDispatchInput {
  return {
    humanAssignmentId: assignment.humanAssignmentId,
    dispatchId: assignment.dispatchId,
    roundId: assignment.roundId,
    assignmentId: assignment.assignmentId,
    taskTitle: assignment.taskTitle,
    instructions: assignment.instructions || assignment.taskTitle,
    ...(assignment.workflowStageId ? { workflowStageId: assignment.workflowStageId } : {}),
  }
}

/** Resolve the same round binding for direct creation and assignment replies. */
export async function resolveHumanTaskDispatch(
  client: ProjectChatClient | undefined,
  projectId: string | number,
  issueId: string,
  userId: string | number,
  containerKind: 'project' | 'chat_group' = 'project'
): Promise<IssueTaskDispatchInput | undefined> {
  if (!client) return undefined
  const args = [String(projectId), issueId, 0, () => {}, () => {}] as const
  const subscription =
    containerKind === 'chat_group'
      ? await client.subscribe(...args, { containerKind })
      : await client.subscribe(...args)
  try {
    const identities = [userId, subscription.snapshot.currentUserId].filter(
      (id): id is string | number => id != null
    )
    const assignment = humanDispatchAssignment(subscription.snapshot.messages, identities)
    return assignment ? humanTaskDispatchInput(assignment) : undefined
  } finally {
    subscription.unsubscribe()
  }
}
