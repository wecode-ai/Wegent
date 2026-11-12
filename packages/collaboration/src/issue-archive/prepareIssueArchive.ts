import { collectIssueSubtreeIds } from '../board'
import type { CollaborationIssue } from '../types'

/** Prepare readable descendants without requesting private Issue bindings. */
export async function prepareIssueArchiveSubtree(
  issues: CollaborationIssue[],
  root: CollaborationIssue,
  onPrepare?: (issue: CollaborationIssue) => Promise<void>,
): Promise<void> {
  if (!onPrepare) return
  const byId = new Map(issues.map((issue) => [issue.id, issue]))
  byId.set(root.id, root)
  for (const id of collectIssueSubtreeIds(issues, root.id)) {
    const issue = byId.get(id)
    if (issue && issue.can_view_detail !== false) await onPrepare(issue)
  }
}
