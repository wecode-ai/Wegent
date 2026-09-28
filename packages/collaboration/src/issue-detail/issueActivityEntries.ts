import type {
  CollaborationAssignment,
  CollaborationComment,
  CollaborationExecution,
} from "../types";
type ActivityEntry =
  | { kind: "assignment"; at: string; assignment: CollaborationAssignment }
  | { kind: "comment"; at: string; comment: CollaborationComment }
  | { kind: "run"; at: string; run: CollaborationExecution };

export function issueActivityEntries(
  assignments: CollaborationAssignment[],
  comments: CollaborationComment[],
  executions: CollaborationExecution[],
): ActivityEntry[] {
  const assignmentEventIds = new Set(
    assignments.flatMap((assignment) => [
      assignment.id,
      ...(assignment.comment_id ? [assignment.comment_id] : []),
    ]),
  );
  return [
    ...assignments.map(
      (assignment): ActivityEntry => ({
        kind: "assignment",
        at: assignment.created_at,
        assignment,
      }),
    ),
    ...comments
      .filter((comment) => !assignmentEventIds.has(comment.id))
      .map(
        (comment): ActivityEntry => ({
          kind: "comment",
          at: comment.created_at,
          comment,
        }),
      ),
    ...executions.map(
      (run): ActivityEntry => ({
        kind: "run",
        at: run.created_at,
        run,
      }),
    ),
  ];
}
