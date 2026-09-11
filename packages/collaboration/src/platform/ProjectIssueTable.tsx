// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationAssignment, CollaborationIssue } from "../types";

export function ProjectIssueTable({
  issues,
  assignmentsByIssueId,
  emptyLabel,
  issueLabel,
  statusLabel,
  assignmentsLabel,
  updatedLabel,
  onOpen,
}: {
  issues: CollaborationIssue[];
  assignmentsByIssueId: Record<string, CollaborationAssignment[]>;
  emptyLabel: string;
  issueLabel: string;
  statusLabel: string;
  assignmentsLabel: string;
  updatedLabel: string;
  onOpen(issue: CollaborationIssue): void;
}) {
  if (issues.length === 0) {
    return (
      <div
        className="collaboration-platform-empty"
        data-testid="collaboration-issue-table-empty"
      >
        <strong>{emptyLabel}</strong>
      </div>
    );
  }
  return (
    <div className="collaboration-issue-table-wrap">
      <table
        className="collaboration-issue-table"
        data-testid="collaboration-issue-table"
      >
        <thead>
          <tr>
            <th>{issueLabel}</th>
            <th>{statusLabel}</th>
            <th>{assignmentsLabel}</th>
            <th>{updatedLabel}</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue) => {
            const assignmentNames = (assignmentsByIssueId[issue.id] ?? []).map(
              (assignment) => assignment.target_name,
            );
            const openIssue = () => onOpen(issue);
            return (
              <tr
                key={issue.id}
                data-testid={`collaboration-issue-table-row-${issue.id}`}
                role="link"
                tabIndex={0}
                onClick={openIssue}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  openIssue();
                }}
              >
                <td>
                  <span className="collaboration-issue-key">
                    #{issue.sequence_number}
                  </span>
                  {issue.title}
                </td>
                <td>{issue.status}</td>
                <td>{assignmentNames.join(", ") || "—"}</td>
                <td>{issue.updated_at.slice(0, 10)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
