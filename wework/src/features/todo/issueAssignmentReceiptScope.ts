import type { CloudLoopItem } from '@/api/deliveries'
import type { IssueAssignmentReceiptState } from './IssueAssignmentReceipts'

export function issueAssignmentRevision(item: Pick<CloudLoopItem, 'assignment_history'>) {
  // Status edits do not create assignments. Include every assignment event so
  // reassigning the same recipient still invalidates the previous receipt.
  return item.assignment_history === undefined
    ? undefined
    : JSON.stringify(
        item.assignment_history
          .map(({ at, action, to_type, to_id, by_user_id }) =>
            JSON.stringify([at, action, to_type, to_id, by_user_id])
          )
          .sort()
      )
}

export function sameIssueAssignment(
  state: IssueAssignmentReceiptState | null | undefined,
  issueId: string,
  version: number,
  assigneeUserId: number | null | undefined,
  assignmentRevision: string | undefined
) {
  return (
    state?.issueId === issueId &&
    state.assigneeUserId === assigneeUserId &&
    state.assignmentRevision === assignmentRevision &&
    // Without assignment history, only an exact Issue version proves scope.
    (assignmentRevision !== undefined || state.version === version)
  )
}
