// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from "react";

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
  allLabel = "All",
  tagLabel = "Tags",
  manualAssignmentLabel = "Assigned in Issue",
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
  allLabel?: string;
  tagLabel?: string;
  manualAssignmentLabel?: string;
  statusName?(status: string): string;
  onCreate?(): void;
  onOpen(issue: CollaborationIssue): void;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const currentAssignmentByIssueId = useMemo(
    () =>
      Object.fromEntries(
        issues.map((issue) => [
          issue.id,
          (assignmentsByIssueId[issue.id] ?? [])
            .filter((assignment) => assignment.status === "active")
            .sort((left, right) =>
              left.updated_at.localeCompare(right.updated_at),
            )
            .at(-1) ?? null,
        ]),
      ) as Record<string, CollaborationAssignment | null>,
    [assignmentsByIssueId, issues],
  );
  const filterOptions = useMemo(
    () => ({
      statuses: [...new Set(issues.map((issue) => issue.status))],
      assignees: [
        ...new Map(
          Object.values(currentAssignmentByIssueId)
            .filter(
              (assignment): assignment is CollaborationAssignment =>
                assignment !== null,
            )
            .map((assignment) => [
              `${assignment.target_type}:${assignment.target_id}`,
              assignment.target_name,
            ]),
        ).entries(),
      ],
      tags: [...new Set(issues.flatMap((issue) => issue.tags))],
    }),
    [currentAssignmentByIssueId, issues],
  );
  useEffect(() => {
    setQuery("");
    setStatusFilter("");
    setAssigneeFilter("");
    setTagFilter("");
  }, [projectKey]);
  useEffect(() => {
    if (statusFilter && !filterOptions.statuses.includes(statusFilter)) {
      setStatusFilter("");
    }
    if (
      assigneeFilter &&
      !filterOptions.assignees.some(([id]) => id === assigneeFilter)
    ) {
      setAssigneeFilter("");
    }
    if (tagFilter && !filterOptions.tags.includes(tagFilter)) {
      setTagFilter("");
    }
  }, [assigneeFilter, filterOptions, statusFilter, tagFilter]);
  const visibleIssues = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return issues.filter((issue) => {
      const assignment = currentAssignmentByIssueId[issue.id];
      const matchesQuery =
        !normalized ||
        `${projectKey ?? ""}-${issue.sequence_number} ${issue.title}`
          .toLocaleLowerCase()
          .includes(normalized);
      const matchesStatus = !statusFilter || issue.status === statusFilter;
      const matchesAssignee =
        !assigneeFilter ||
        (assignment !== null &&
          `${assignment.target_type}:${assignment.target_id}` ===
            assigneeFilter);
      const matchesTag = !tagFilter || issue.tags.includes(tagFilter);
      return matchesQuery && matchesStatus && matchesAssignee && matchesTag;
    });
  }, [
    assigneeFilter,
    currentAssignmentByIssueId,
    issues,
    projectKey,
    query,
    statusFilter,
    tagFilter,
  ]);

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
        <select
          aria-label={statusLabel}
          data-testid="collaboration-issue-table-status-filter"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
        >
          <option value="">
            {allLabel} {statusLabel}
          </option>
          {filterOptions.statuses.map((status) => (
            <option key={status} value={status}>
              {statusName(status)}
            </option>
          ))}
        </select>
        <select
          aria-label={assignmentsLabel}
          data-testid="collaboration-issue-table-assignee-filter"
          value={assigneeFilter}
          onChange={(event) => setAssigneeFilter(event.target.value)}
        >
          <option value="">
            {allLabel} {assignmentsLabel}
          </option>
          {filterOptions.assignees.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
        <select
          aria-label={tagLabel}
          data-testid="collaboration-issue-table-tag-filter"
          value={tagFilter}
          onChange={(event) => setTagFilter(event.target.value)}
        >
          <option value="">
            {allLabel} {tagLabel}
          </option>
          {filterOptions.tags.map((tag) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </select>
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
            const currentAssignment = currentAssignmentByIssueId[issue.id];
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
                      ? currentAssignment.workflow_step || manualAssignmentLabel
                      : "—"}
                  </td>
                ) : null}
                {executionLabel ? (
                  <td
                    data-testid={`collaboration-issue-table-execution-${issue.id}`}
                    title={issue.execution_error || undefined}
                  >
                    {issue.execution_state || "—"}
                  </td>
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
