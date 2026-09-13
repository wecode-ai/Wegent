// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";

import type { CollaborationAssignment, CollaborationIssue } from "../types";

export function ProjectIssueTable({
  issues,
  assignmentsByIssueId,
  emptyLabel,
  issueLabel,
  statusLabel,
  assignmentsLabel,
  assignmentSourceLabel,
  executionLabel,
  updatedLabel,
  projectKey,
  searchPlaceholder,
  createLabel,
  statusName = (status) => status,
  onCreate,
  onOpen,
}: {
  issues: CollaborationIssue[];
  assignmentsByIssueId: Record<string, CollaborationAssignment[]>;
  emptyLabel: string;
  issueLabel: string;
  statusLabel: string;
  assignmentsLabel: string;
  assignmentSourceLabel?: string;
  executionLabel?: string;
  updatedLabel: string;
  projectKey?: string;
  searchPlaceholder?: string;
  createLabel?: string;
  statusName?(status: string): string;
  onCreate?(): void;
  onOpen(issue: CollaborationIssue): void;
}) {
  const [query, setQuery] = useState("");
  const visibleIssues = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return issues;
    return issues.filter((issue) =>
      `${projectKey ?? ""}-${issue.sequence_number} ${issue.title}`
        .toLocaleLowerCase()
        .includes(normalized),
    );
  }, [issues, projectKey, query]);

  if (issues.length === 0) {
    return (
      <div
        className="collaboration-platform-empty"
        data-testid="collaboration-issue-table-empty"
      >
        <strong>{emptyLabel}</strong>
        {onCreate && createLabel ? (
          <button
            type="button"
            className="collaboration-primary-button"
            data-testid="collaboration-issue-table-empty-create"
            onClick={onCreate}
          >
            {createLabel}
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div className="collaboration-issue-table-wrap">
      <div className="collaboration-issue-table-toolbar">
        <label>
          <span aria-hidden="true">⌕</span>
          <input
            aria-label={searchPlaceholder}
            data-testid="collaboration-issue-table-search"
            placeholder={searchPlaceholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {onCreate && createLabel ? (
          <button
            type="button"
            className="collaboration-primary-button"
            data-testid="collaboration-issue-table-create"
            onClick={onCreate}
          >
            {createLabel}
          </button>
        ) : null}
      </div>
      <table
        className="collaboration-issue-table"
        data-testid="collaboration-issue-table"
      >
        <thead>
          <tr>
            <th>{issueLabel}</th>
            <th>{statusLabel}</th>
            <th>{assignmentsLabel}</th>
            {assignmentSourceLabel ? <th>{assignmentSourceLabel}</th> : null}
            {executionLabel ? <th>{executionLabel}</th> : null}
            <th>{updatedLabel}</th>
          </tr>
        </thead>
        <tbody>
          {visibleIssues.map((issue) => {
            const currentAssignment =
              (assignmentsByIssueId[issue.id] ?? [])
                .filter((assignment) => assignment.status === "active")
                .sort((left, right) =>
                  left.updated_at.localeCompare(right.updated_at),
                )
                .at(-1) ?? null;
            return (
              <tr
                key={issue.id}
                data-testid={`collaboration-issue-table-row-${issue.id}`}
              >
                <td>
                  <button type="button" onClick={() => onOpen(issue)}>
                    <span className="collaboration-issue-key">
                      {projectKey
                        ? `${projectKey}-${issue.sequence_number}`
                        : `#${issue.sequence_number}`}
                    </span>
                    {issue.title}
                  </button>
                </td>
                <td>{statusName(issue.status)}</td>
                <td>{currentAssignment?.target_name || "—"}</td>
                {assignmentSourceLabel ? (
                  <td>
                    {currentAssignment
                      ? currentAssignment.workflow_step || "Issue 内分配"
                      : "—"}
                  </td>
                ) : null}
                {executionLabel ? (
                  <td>{issue.execution_state || "—"}</td>
                ) : null}
                <td>{issue.updated_at.slice(0, 10)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
