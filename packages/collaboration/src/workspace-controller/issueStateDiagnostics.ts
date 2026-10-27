import { issueAssigneeTarget } from "../issue-detail/IssueDetailDraft";
import type { CollaborationIssue } from "../types";

export function traceIssueStateChange(
  action: string,
  before: CollaborationIssue | null,
  after: CollaborationIssue | null,
) {
  if (!before || !after || before.id !== after.id) return;
  const previousAssignee = issueAssigneeTarget(before);
  const nextAssignee = issueAssigneeTarget(after);
  if (previousAssignee === nextAssignee && after.version >= before.version)
    return;
  console.debug("[collaboration-workspace] selected issue changed", {
    action,
    issueId: after.id,
    previousVersion: before.version,
    nextVersion: after.version,
    previousAssignee,
    nextAssignee,
  });
}
