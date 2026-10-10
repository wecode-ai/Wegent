// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  Archive,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { canEditCollaborationIssue } from "../permissions";
import type { CollaborationAssignment, CollaborationIssue } from "../types";

type IssueTableSortKey =
  | "title"
  | "status"
  | "assignee"
  | "tags"
  | "start_at"
  | "due_at"
  | "execution"
  | "updated_at";

type IssueTableSort = {
  key: IssueTableSortKey;
  direction: "asc" | "desc";
};

export function ProjectIssueTable({
  issues,
  assignmentsByIssueId,
  emptyLabel,
  issueLabel,
  statusLabel,
  assignmentsLabel,
  executionLabel,
  updatedLabel,
  startAtLabel = "Start",
  dueAtLabel = "End",
  projectKey,
  showIssueKey = false,
  searchPlaceholder,
  createLabel,
  allLabel = "All",
  tagLabel = "Tags",
  actionsLabel,
  deleteLabel,
  selectAllLabel = "Select all visible issues",
  selectIssueLabel = "Select issue",
  selectedLabel = "selected",
  batchStatusLabel = "Change status",
  batchApplyLabel = "Apply",
  batchDeleteLabel = "Archive selected",
  availableStatuses,
  statusName = (status) => status,
  onCreate,
  canDelete = () => true,
  onDelete,
  onBulkStatusChange,
  onBulkDelete,
  onOpen,
}: {
  issues: CollaborationIssue[];
  assignmentsByIssueId: Record<string, CollaborationAssignment[]>;
  emptyLabel: string;
  issueLabel: string;
  statusLabel: string;
  assignmentsLabel: string;
  executionLabel?: string;
  updatedLabel: string;
  startAtLabel?: string;
  dueAtLabel?: string;
  projectKey?: string;
  showIssueKey?: boolean;
  searchPlaceholder?: string;
  createLabel?: string;
  allLabel?: string;
  tagLabel?: string;
  actionsLabel?: string;
  deleteLabel?: string;
  selectAllLabel?: string;
  selectIssueLabel?: string;
  selectedLabel?: string;
  batchStatusLabel?: string;
  batchApplyLabel?: string;
  batchDeleteLabel?: string;
  availableStatuses?: readonly string[];
  statusName?(status: string): string;
  onCreate?(): void;
  canDelete?(issue: CollaborationIssue): boolean;
  onDelete?(issue: CollaborationIssue): void;
  onBulkStatusChange?(
    issues: CollaborationIssue[],
    status: string,
  ): Promise<void> | void;
  onBulkDelete?(issues: CollaborationIssue[]): void;
  onOpen(issue: CollaborationIssue): void;
}) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [sort, setSort] = useState<IssueTableSort | null>(null);
  const [selectedIssueIds, setSelectedIssueIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [batchStatus, setBatchStatus] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);
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
      statuses: [
        ...new Set([
          ...(availableStatuses ?? []),
          ...issues.map((issue) => issue.status),
        ]),
      ],
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
      tags: [...new Set(issues.flatMap((issue) => issue.tags ?? []))],
    }),
    [availableStatuses, currentAssignmentByIssueId, issues],
  );
  useEffect(() => {
    setQuery("");
    setStatusFilter("");
    setAssigneeFilter("");
    setTagFilter("");
    setSort(null);
    setSelectedIssueIds(new Set());
    setBatchStatus("");
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
    const filteredIssues = issues.filter((issue) => {
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
      const matchesTag = !tagFilter || (issue.tags ?? []).includes(tagFilter);
      return matchesQuery && matchesStatus && matchesAssignee && matchesTag;
    });
    if (!sort) return filteredIssues;

    const sortValue = (issue: CollaborationIssue): string | null => {
      const assignment = currentAssignmentByIssueId[issue.id];
      switch (sort.key) {
        case "title":
          return issue.title;
        case "status":
          return statusName(issue.status);
        case "assignee":
          return assignment?.target_name ?? null;
        case "tags":
          return issue.tags?.length ? issue.tags.join(", ") : null;
        case "start_at":
          return issue.start_at ?? null;
        case "due_at":
          return issue.due_at ?? null;
        case "execution":
          return issue.execution_state ?? null;
        case "updated_at":
          return issue.updated_at;
      }
    };

    return [...filteredIssues].sort((left, right) => {
      const leftValue = sortValue(left);
      const rightValue = sortValue(right);
      if (leftValue === null && rightValue === null) {
        return left.sequence_number - right.sequence_number;
      }
      if (leftValue === null) return 1;
      if (rightValue === null) return -1;
      const result = leftValue.localeCompare(rightValue, undefined, {
        numeric: true,
        sensitivity: "base",
      });
      if (result !== 0) return sort.direction === "asc" ? result : -result;
      return left.sequence_number - right.sequence_number;
    });
  }, [
    assigneeFilter,
    currentAssignmentByIssueId,
    issues,
    projectKey,
    query,
    sort,
    statusName,
    statusFilter,
    tagFilter,
  ]);
  const selectableVisibleIssues = visibleIssues.filter((issue) =>
    canEditCollaborationIssue(issue),
  );
  const selectedIssues = issues.filter((issue) =>
    selectedIssueIds.has(issue.id),
  );
  const archivableSelectedIssues = selectedIssues.filter((issue) =>
    canDelete(issue),
  );
  const allVisibleSelected =
    selectableVisibleIssues.length > 0 &&
    selectableVisibleIssues.every((issue) => selectedIssueIds.has(issue.id));
  const someVisibleSelected = selectableVisibleIssues.some((issue) =>
    selectedIssueIds.has(issue.id),
  );
  useEffect(() => {
    setSelectedIssueIds(
      (current) =>
        new Set(
          [...current].filter((id) =>
            issues.some(
              (issue) => issue.id === id && canEditCollaborationIssue(issue),
            ),
          ),
        ),
    );
  }, [issues]);
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate =
        someVisibleSelected && !allVisibleSelected;
    }
  }, [allVisibleSelected, someVisibleSelected]);

  const toggleAllVisible = () => {
    setSelectedIssueIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        selectableVisibleIssues.forEach((issue) => next.delete(issue.id));
      } else {
        selectableVisibleIssues.forEach((issue) => next.add(issue.id));
      }
      return next;
    });
  };
  const toggleIssue = (issue: CollaborationIssue) => {
    setSelectedIssueIds((current) => {
      const next = new Set(current);
      if (next.has(issue.id)) next.delete(issue.id);
      else next.add(issue.id);
      return next;
    });
  };
  const applyBatchStatus = async () => {
    if (
      !batchStatus ||
      selectedIssues.length === 0 ||
      !onBulkStatusChange ||
      batchBusy
    ) {
      return;
    }
    setBatchBusy(true);
    try {
      await onBulkStatusChange(selectedIssues, batchStatus);
      setSelectedIssueIds(new Set());
      setBatchStatus("");
    } catch {
      return;
    } finally {
      setBatchBusy(false);
    }
  };
  const toggleSort = (key: IssueTableSortKey) => {
    setSort((current) => ({
      key,
      direction:
        current?.key === key && current.direction === "asc" ? "desc" : "asc",
    }));
  };
  const sortDirection = (key: IssueTableSortKey) =>
    sort?.key === key ? sort.direction : null;
  const sortIcon = (key: IssueTableSortKey) => {
    const direction = sortDirection(key);
    if (direction === "asc") return <ArrowUp aria-hidden="true" />;
    if (direction === "desc") return <ArrowDown aria-hidden="true" />;
    return <ArrowUpDown aria-hidden="true" />;
  };
  const sortButton = (key: IssueTableSortKey, label: string) => (
    <button
      type="button"
      className={`collaboration-issue-table-sort ${
        sort?.key === key ? "is-active" : ""
      }`}
      data-testid={`collaboration-issue-table-sort-${key}`}
      onClick={() => toggleSort(key)}
    >
      <span>{label}</span>
      {sortIcon(key)}
    </button>
  );
  const ariaSort = (key: IssueTableSortKey) =>
    sortDirection(key) === "asc"
      ? "ascending"
      : sortDirection(key) === "desc"
        ? "descending"
        : "none";

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
        <label className="collaboration-issue-table-search">
          <Search aria-hidden="true" />
          <input
            aria-label={searchPlaceholder}
            data-testid="collaboration-issue-table-search"
            placeholder={searchPlaceholder}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {selectedIssues.length > 0 ? (
          <div
            className="collaboration-issue-table-batch"
            data-testid="collaboration-issue-table-batch"
          >
            <strong>
              {selectedIssues.length} {selectedLabel}
            </strong>
            {onBulkStatusChange ? (
              <>
                <select
                  aria-label={batchStatusLabel}
                  data-testid="collaboration-issue-table-batch-status"
                  value={batchStatus}
                  onChange={(event) => setBatchStatus(event.target.value)}
                  disabled={batchBusy}
                >
                  <option value="">{batchStatusLabel}</option>
                  {filterOptions.statuses.map((status) => (
                    <option key={status} value={status}>
                      {statusName(status)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  data-testid="collaboration-issue-table-batch-apply"
                  disabled={!batchStatus || batchBusy}
                  onClick={() => void applyBatchStatus()}
                >
                  {batchApplyLabel}
                </button>
              </>
            ) : null}
            {onBulkDelete ? (
              <button
                type="button"
                data-testid="collaboration-issue-table-batch-delete"
                disabled={batchBusy || archivableSelectedIssues.length === 0}
                onClick={() => onBulkDelete(archivableSelectedIssues)}
              >
                {batchDeleteLabel}
              </button>
            ) : null}
          </div>
        ) : null}
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
        <colgroup>
          <col className="collaboration-issue-table-col-select" />
          <col className="collaboration-issue-table-col-title" />
          <col className="collaboration-issue-table-col-status" />
          <col className="collaboration-issue-table-col-assignee" />
          <col className="collaboration-issue-table-col-tags" />
          <col className="collaboration-issue-table-col-start" />
          <col className="collaboration-issue-table-col-due" />
          {executionLabel ? (
            <col className="collaboration-issue-table-col-execution" />
          ) : null}
          <col className="collaboration-issue-table-col-updated" />
          {onDelete ? (
            <col className="collaboration-issue-table-col-actions" />
          ) : null}
        </colgroup>
        <thead>
          <tr>
            <th className="collaboration-issue-table-select">
              <input
                ref={selectAllRef}
                type="checkbox"
                aria-label={selectAllLabel}
                data-testid="collaboration-issue-table-select-all"
                checked={allVisibleSelected}
                disabled={selectableVisibleIssues.length === 0}
                onChange={toggleAllVisible}
              />
            </th>
            <th aria-sort={ariaSort("title")}>
              {sortButton("title", issueLabel)}
            </th>
            <th aria-sort={ariaSort("status")}>
              <div className="collaboration-issue-table-header-controls">
                {sortButton("status", statusLabel)}
                <label
                  className={`collaboration-issue-table-header-filter ${
                    statusFilter ? "is-active" : ""
                  }`}
                >
                  <ChevronDown aria-hidden="true" />
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
                </label>
              </div>
            </th>
            <th aria-sort={ariaSort("assignee")}>
              <div className="collaboration-issue-table-header-controls">
                {sortButton("assignee", assignmentsLabel)}
                <label
                  className={`collaboration-issue-table-header-filter ${
                    assigneeFilter ? "is-active" : ""
                  }`}
                >
                  <ChevronDown aria-hidden="true" />
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
                </label>
              </div>
            </th>
            <th aria-sort={ariaSort("tags")}>
              <div className="collaboration-issue-table-header-controls">
                {sortButton("tags", tagLabel)}
                <label
                  className={`collaboration-issue-table-header-filter ${
                    tagFilter ? "is-active" : ""
                  }`}
                >
                  <ChevronDown aria-hidden="true" />
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
                </label>
              </div>
            </th>
            <th aria-sort={ariaSort("start_at")}>
              {sortButton("start_at", startAtLabel)}
            </th>
            <th aria-sort={ariaSort("due_at")}>
              {sortButton("due_at", dueAtLabel)}
            </th>
            {executionLabel ? (
              <th aria-sort={ariaSort("execution")}>
                {sortButton("execution", executionLabel)}
              </th>
            ) : null}
            <th aria-sort={ariaSort("updated_at")}>
              {sortButton("updated_at", updatedLabel)}
            </th>
            {onDelete ? (
              <th className="collaboration-issue-table-actions-head">
                {actionsLabel}
              </th>
            ) : null}
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
                <td className="collaboration-issue-table-select">
                  <input
                    type="checkbox"
                    aria-label={`${selectIssueLabel} ${issue.title}`}
                    data-testid={`collaboration-issue-table-select-${issue.id}`}
                    checked={selectedIssueIds.has(issue.id)}
                    disabled={!canEditCollaborationIssue(issue)}
                    onChange={() => toggleIssue(issue)}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    title={issue.title}
                    onClick={() => onOpen(issue)}
                  >
                    {showIssueKey ? (
                      <span className="collaboration-issue-key">
                        {projectKey
                          ? `${projectKey}-${issue.sequence_number}`
                          : `#${issue.sequence_number}`}
                      </span>
                    ) : null}
                    <span className="collaboration-issue-title">
                      {issue.title}
                    </span>
                  </button>
                </td>
                <td>{statusName(issue.status)}</td>
                <td>{currentAssignment?.target_name || "—"}</td>
                <td>{issue.tags?.length ? issue.tags.join(", ") : "—"}</td>
                <td className="collaboration-issue-table-date">
                  {issue.start_at?.slice(0, 10) || "—"}
                </td>
                <td className="collaboration-issue-table-date">
                  {issue.due_at?.slice(0, 10) || "—"}
                </td>
                {executionLabel ? (
                  <td
                    data-testid={`collaboration-issue-table-execution-${issue.id}`}
                    title={issue.execution_error || undefined}
                  >
                    {issue.execution_state || "—"}
                  </td>
                ) : null}
                <td className="collaboration-issue-table-updated">
                  {issue.updated_at.slice(0, 10)}
                </td>
                {onDelete ? (
                  <td className="collaboration-issue-table-actions">
                    {canEditCollaborationIssue(issue) && canDelete(issue) ? (
                      <button
                        aria-label={deleteLabel}
                        className="collaboration-issue-table-delete"
                        data-testid={`collaboration-issue-table-delete-${issue.id}`}
                        onClick={() => onDelete(issue)}
                        title={deleteLabel}
                        type="button"
                      >
                        <Archive aria-hidden="true" />
                      </button>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
