/**
 * The human work item a manager dispatch assigned to one member.
 *
 * A manager assignment activity carries everything the member needs to start
 * their own task, so the same binding travels through both the notification
 * payload and the Issue timeline.
 */
export interface HumanDispatchAssignment {
  humanAssignmentId: string;
  dispatchId: string;
  roundId: string;
  assignmentId: string;
  taskTitle: string;
  instructions?: string;
  workflowStageId: string | null;
}

function assignmentFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  userIds: ReadonlySet<string>,
): HumanDispatchAssignment | null {
  if (!metadata) return null;
  const dispatchId = metadata.dispatch_id;
  const roundId = metadata.coordination_round_id;
  const assignments = metadata.dispatch_assignments;
  if (
    typeof dispatchId !== "string" ||
    !dispatchId ||
    typeof roundId !== "string" ||
    !roundId ||
    !Array.isArray(assignments)
  ) {
    return null;
  }
  for (const entry of assignments) {
    if (typeof entry !== "object" || entry === null) continue;
    const assignment = entry as Record<string, unknown>;
    if (assignment.assignee_type !== "human") continue;
    if (!userIds.has(String(assignment.human_user_id))) continue;
    const humanAssignmentId = assignment.human_assignment_id;
    const assignmentId = assignment.assignment_id;
    const taskTitle = assignment.task_title;
    if (typeof humanAssignmentId !== "string" || !humanAssignmentId) continue;
    if (typeof assignmentId !== "string" || !assignmentId) continue;
    if (typeof taskTitle !== "string" || !taskTitle.trim()) continue;
    const workflowStageId = assignment.workflow_stage_id;
    return {
      humanAssignmentId,
      dispatchId,
      roundId,
      assignmentId,
      taskTitle: taskTitle.trim(),
      ...(typeof assignment.instructions === "string"
        ? { instructions: assignment.instructions }
        : {}),
      workflowStageId:
        typeof workflowStageId === "string" && workflowStageId.trim()
          ? workflowStageId.trim()
          : null,
    };
  }
  return null;
}

/**
 * The most recent manager dispatch that assigned this member a human work
 * item, or null when the Issue timeline holds no assignment for them.
 *
 * A dispatch activity is the comment that carries both a `dispatch_id` and a
 * `dispatch_assignments` list. Reading the binding from the timeline lets a
 * member start the same work item without the original notification payload.
 */
export function humanDispatchAssignment(
  messages: readonly { metadata: Record<string, unknown> }[],
  currentUserId:
    | string
    | number
    | readonly (string | number)[]
    | null
    | undefined,
): HumanDispatchAssignment | null {
  if (currentUserId === null || currentUserId === undefined) return null;
  const userIds = new Set(
    (Array.isArray(currentUserId) ? currentUserId : [currentUserId]).map(
      String,
    ),
  );
  let latest: HumanDispatchAssignment | null = null;
  for (const message of messages) {
    if (message.metadata.activity_type === "manager_assignment") {
      latest = assignmentFromMetadata(message.metadata, userIds);
    }
  }
  return latest;
}
