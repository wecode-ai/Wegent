// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { CollaborationIssue } from "../types";

export function ProjectIssueTable({
  issues,
  emptyLabel,
  issueLabel,
  statusLabel,
  assignmentsLabel,
  updatedLabel,
  onOpen,
}: {
  issues: CollaborationIssue[];
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
            const assignmentNames = [
              issue.assignee_name,
              issue.assignee_agent_name,
              issue.assignee_team_name,
            ].filter(Boolean);
            return (
              <tr
                key={issue.id}
                data-testid={`collaboration-issue-table-row-${issue.id}`}
                onClick={() => onOpen(issue)}
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
