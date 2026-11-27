import { Checkbox } from '../controls/Checkbox'
import { SelectContent, SelectItem, SelectRoot, SelectTrigger } from '../controls/SelectParts'
import { TextField as ControlInput } from '../controls/TextField'
import { Button as ControlButton } from '../markdown/Button'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { Archive, ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, Search } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'

import { IssueListTitle } from '../issue-card/IssueListTitle'
import { IssueOpenControl } from '../issue-card/IssueOpenControl'
import { formatIssueTimestamp } from '../issue-detail/issueTimestamp'
import { canEditCollaborationIssue } from '../permissions'
import type { CollaborationAssignment, CollaborationIssue } from '../types'
import type { IssueStatusFailure } from './bulkIssueStatus'

type IssueTableSortKey =
  | 'title'
  | 'status'
  | 'assignee'
  | 'tags'
  | 'start_at'
  | 'due_at'
  | 'execution'
  | 'updated_at'

type IssueTableSort = {
  key: IssueTableSortKey
  direction: 'asc' | 'desc'
}

const noAssignments: Record<string, CollaborationAssignment[]> = {}

type IssueRowOptions = {
  buttonTestId?: string
  active?: boolean
  assigneeName?: string | null
  ref?(row: HTMLTableRowElement | null): void
  titleTrailing?: ReactNode
  details?: ReactNode
}

type ProjectIssueTableProps<Issue extends CollaborationIssue> = {
  issues: Issue[]
  assignmentsByIssueId?: Record<string, CollaborationAssignment[]>
  emptyLabel: string
  issueLabel: string
  statusLabel: string
  assignmentsLabel: string
  executionLabel?: string
  updatedLabel: string
  startAtLabel?: string
  dueAtLabel?: string
  projectKey?: string
  showIssueKey?: boolean
  selectable?: boolean
  searchPlaceholder?: string
  showControls?: boolean
  createLabel?: string
  allLabel?: string
  tagLabel?: string
  actionsLabel?: string
  deleteLabel?: string
  selectAllLabel?: string
  selectIssueLabel?: string
  selectedLabel?: string
  batchStatusLabel?: string
  batchApplyLabel?: string
  batchDeleteLabel?: string
  batchFailedLabel?: string
  availableStatuses?: readonly string[]
  statusName?(status: string): string
  onCreate?(): void
  canDelete?(issue: CollaborationIssue): boolean
  onDelete?(issue: CollaborationIssue): void
  renderBulkActions?(issues: CollaborationIssue[]): ReactNode
  toolbarAction?: ReactNode
  onBulkStatusChange?(issues: CollaborationIssue[], status: string): Promise<IssueStatusFailure[]>
  onBulkDelete?(issues: CollaborationIssue[]): void
  getRowOptions?(issue: Issue): IssueRowOptions
  onOpen(issue: Issue): void
}

export function ProjectIssueTable<Issue extends CollaborationIssue>(
  props: ProjectIssueTableProps<Issue>
) {
  return <ProjectIssueTableContent key={props.projectKey} {...props} />
}

function ProjectIssueTableContent<Issue extends CollaborationIssue>({
  issues,
  assignmentsByIssueId = noAssignments,
  emptyLabel,
  issueLabel,
  statusLabel,
  assignmentsLabel,
  executionLabel,
  updatedLabel,
  startAtLabel = 'Start',
  dueAtLabel = 'End',
  projectKey,
  showIssueKey = false,
  selectable = true,
  searchPlaceholder,
  showControls = true,
  createLabel,
  allLabel = 'All',
  tagLabel = 'Tags',
  actionsLabel,
  deleteLabel,
  selectAllLabel = 'Select all visible issues',
  selectIssueLabel = 'Select issue',
  selectedLabel = 'selected',
  batchStatusLabel = 'Change status',
  batchApplyLabel = 'Apply',
  batchDeleteLabel = 'Archive selected',
  batchFailedLabel = 'Status update failed',
  availableStatuses,
  statusName = status => status,
  onCreate,
  canDelete = () => true,
  onDelete,
  renderBulkActions,
  toolbarAction,
  onBulkStatusChange,
  onBulkDelete,
  getRowOptions,
  onOpen,
}: ProjectIssueTableProps<Issue>) {
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [assigneeFilter, setAssigneeFilter] = useState('')
  const [tagFilter, setTagFilter] = useState('')
  const [sort, setSort] = useState<IssueTableSort | null>(null)
  const [selectedIssueIds, setSelectedIssueIds] = useState<Set<string>>(() => new Set())
  const [batchStatus, setBatchStatus] = useState('')
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchFailures, setBatchFailures] = useState<IssueStatusFailure[]>([])
  const currentAssignmentByIssueId = useMemo(
    () =>
      Object.fromEntries(
        issues.map(issue => [
          issue.id,
          (assignmentsByIssueId[issue.id] ?? [])
            .filter(assignment => assignment.status === 'active')
            .sort((left, right) => left.updated_at.localeCompare(right.updated_at))
            .at(-1) ?? null,
        ])
      ) as Record<string, CollaborationAssignment | null>,
    [assignmentsByIssueId, issues]
  )
  const filterOptions = useMemo(
    () => ({
      statuses: [...new Set([...(availableStatuses ?? []), ...issues.map(issue => issue.status)])],
      assignees: [
        ...new Map(
          Object.values(currentAssignmentByIssueId)
            .filter((assignment): assignment is CollaborationAssignment => assignment !== null)
            .map(assignment => [
              `${assignment.target_type}:${assignment.target_id}`,
              assignment.target_name,
            ])
        ).entries(),
      ],
      tags: [...new Set(issues.flatMap(issue => issue.tags ?? []))],
    }),
    [availableStatuses, currentAssignmentByIssueId, issues]
  )
  if (statusFilter && !filterOptions.statuses.includes(statusFilter)) {
    setStatusFilter('')
  }
  if (assigneeFilter && !filterOptions.assignees.some(([id]) => id === assigneeFilter)) {
    setAssigneeFilter('')
  }
  if (tagFilter && !filterOptions.tags.includes(tagFilter)) {
    setTagFilter('')
  }

  const visibleIssues = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    const filteredIssues = issues.filter(issue => {
      const assignment = currentAssignmentByIssueId[issue.id]
      const matchesQuery =
        !normalized ||
        `${projectKey ?? ''}-${issue.sequence_number} ${issue.title}`
          .toLocaleLowerCase()
          .includes(normalized)
      const matchesStatus = !statusFilter || issue.status === statusFilter
      const matchesAssignee =
        !assigneeFilter ||
        (assignment !== null &&
          `${assignment.target_type}:${assignment.target_id}` === assigneeFilter)
      const matchesTag = !tagFilter || (issue.tags ?? []).includes(tagFilter)
      return matchesQuery && matchesStatus && matchesAssignee && matchesTag
    })
    if (!sort) return filteredIssues

    const sortValue = (issue: CollaborationIssue): string | null => {
      const assignment = currentAssignmentByIssueId[issue.id]
      switch (sort.key) {
        case 'title':
          return issue.title
        case 'status':
          return statusName(issue.status)
        case 'assignee':
          return assignment?.target_name ?? null
        case 'tags':
          return issue.tags?.length ? issue.tags.join(', ') : null
        case 'start_at':
          return issue.start_at ?? null
        case 'due_at':
          return issue.due_at ?? null
        case 'execution':
          return issue.execution_state ?? null
        case 'updated_at':
          return issue.updated_at
      }
    }

    return [...filteredIssues].sort((left, right) => {
      const leftValue = sortValue(left)
      const rightValue = sortValue(right)
      if (leftValue === null && rightValue === null) {
        return left.sequence_number - right.sequence_number
      }
      if (leftValue === null) return 1
      if (rightValue === null) return -1
      const result = leftValue.localeCompare(rightValue, undefined, {
        numeric: true,
        sensitivity: 'base',
      })
      if (result !== 0) return sort.direction === 'asc' ? result : -result
      return left.sequence_number - right.sequence_number
    })
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
  ])
  const selectableVisibleIssues = visibleIssues.filter(issue => canEditCollaborationIssue(issue))
  const selectedIssues = visibleIssues.filter(issue => selectedIssueIds.has(issue.id))
  const archivableSelectedIssues = selectedIssues.filter(issue => canDelete(issue))
  const allVisibleSelected =
    selectableVisibleIssues.length > 0 &&
    selectableVisibleIssues.every(issue => selectedIssueIds.has(issue.id))
  const someVisibleSelected = selectableVisibleIssues.some(issue => selectedIssueIds.has(issue.id))
  const validSelection = useMemo(() => {
    const editableIds = new Set(issues.filter(canEditCollaborationIssue).map(issue => issue.id))
    return new Set([...selectedIssueIds].filter(id => editableIds.has(id)))
  }, [issues, selectedIssueIds])
  if (validSelection.size !== selectedIssueIds.size) setSelectedIssueIds(validSelection)

  const toggleAllVisible = () => {
    setSelectedIssueIds(current => {
      const next = new Set(current)
      if (allVisibleSelected) {
        selectableVisibleIssues.forEach(issue => next.delete(issue.id))
      } else {
        selectableVisibleIssues.forEach(issue => next.add(issue.id))
      }
      return next
    })
  }
  const toggleIssue = (issue: CollaborationIssue) => {
    setSelectedIssueIds(current => {
      const next = new Set(current)
      if (next.has(issue.id)) next.delete(issue.id)
      else next.add(issue.id)
      return next
    })
  }
  const applyBatchStatus = async () => {
    if (!batchStatus || selectedIssues.length === 0 || !onBulkStatusChange || batchBusy) {
      return
    }
    setBatchBusy(true)
    setBatchFailures([])
    try {
      const failures = await onBulkStatusChange(selectedIssues, batchStatus)
      setBatchFailures(failures)
      setSelectedIssueIds(new Set(failures.map(failure => failure.issueId)))
      if (failures.length === 0) setBatchStatus('')
    } catch (error) {
      setBatchFailures(
        selectedIssues.map(issue => ({
          issueId: issue.id,
          message: error instanceof Error ? error.message : batchFailedLabel,
        }))
      )
    } finally {
      setBatchBusy(false)
    }
  }
  const toggleSort = (key: IssueTableSortKey) => {
    setSort(current => ({
      key,
      direction: current?.key === key && current.direction === 'asc' ? 'desc' : 'asc',
    }))
  }
  const sortDirection = (key: IssueTableSortKey) => (sort?.key === key ? sort.direction : null)
  const sortIcon = (key: IssueTableSortKey) => {
    const direction = sortDirection(key)
    if (direction === 'asc') return <ArrowUp aria-hidden="true" />
    if (direction === 'desc') return <ArrowDown aria-hidden="true" />
    return <ArrowUpDown aria-hidden="true" />
  }
  const sortButton = (key: IssueTableSortKey, label: string) => (
    <ControlButton
      variant="unstyled"
      type="button"
      className={`collaboration-issue-table-sort ${sort?.key === key ? 'is-active' : ''}`}
      data-testid={`collaboration-issue-table-sort-${key}`}
      onClick={() => toggleSort(key)}
    >
      <span>{label}</span>
      {sortIcon(key)}
    </ControlButton>
  )
  const ariaSort = (key: IssueTableSortKey) =>
    sortDirection(key) === 'asc'
      ? 'ascending'
      : sortDirection(key) === 'desc'
        ? 'descending'
        : 'none'

  return (
    <div className="collaboration-issue-table-wrap">
      {showControls && (
        <div className="collaboration-issue-table-toolbar">
          <label className="collaboration-issue-table-search">
            <Search aria-hidden="true" />
            <ControlInput
              aria-label={searchPlaceholder}
              data-testid="collaboration-issue-table-search"
              placeholder={searchPlaceholder}
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
          </label>
          {toolbarAction}
          {onCreate && createLabel ? (
            <ControlButton
              variant="unstyled"
              type="button"
              className="collaboration-primary-button"
              data-testid={
                issues.length === 0
                  ? 'collaboration-issue-table-empty-create'
                  : 'collaboration-issue-table-create'
              }
              onClick={onCreate}
            >
              {createLabel}
            </ControlButton>
          ) : null}
          {selectedIssues.length > 0 ? (
            <div
              className="collaboration-issue-table-batch"
              data-testid="collaboration-issue-table-batch"
            >
              <strong>
                {selectedIssues.length} {selectedLabel}
              </strong>
              {renderBulkActions?.(selectedIssues)}
              {onBulkStatusChange ? (
                <div className="collaboration-issue-table-batch-group">
                  <SelectRoot
                    disabled={batchBusy}
                    value={String(batchStatus)}
                    onValueChange={selectedValue => {
                      if (selectedValue === null) return
                      return setBatchStatus(selectedValue)
                    }}
                  >
                    <SelectTrigger
                      aria-label={batchStatusLabel}
                      data-testid="collaboration-issue-table-batch-status"
                    />
                    <SelectContent>
                      <SelectItem value="">{batchStatusLabel}</SelectItem>
                      {filterOptions.statuses.map(status => (
                        <SelectItem key={status} value={String(status)}>
                          {statusName(status)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </SelectRoot>
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid="collaboration-issue-table-batch-apply"
                    disabled={!batchStatus || batchBusy}
                    onClick={() => void applyBatchStatus()}
                  >
                    {batchApplyLabel}
                  </ControlButton>
                </div>
              ) : null}
              {onBulkDelete ? (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="collaboration-issue-table-batch-delete"
                  disabled={batchBusy || archivableSelectedIssues.length === 0}
                  onClick={() => onBulkDelete(archivableSelectedIssues)}
                >
                  {batchDeleteLabel}
                </ControlButton>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
      {batchFailures.length > 0 ? (
        <div
          role="alert"
          className="collaboration-alert"
          data-testid="collaboration-issue-table-batch-error"
        >
          <strong>{batchFailedLabel}</strong>
          <ul>
            {batchFailures.map(failure => (
              <li key={failure.issueId}>
                {issues.find(issue => issue.id === failure.issueId)?.title ?? failure.issueId}:{' '}
                {failure.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {issues.length === 0 ? (
        <div className="collaboration-platform-empty" data-testid="collaboration-issue-table-empty">
          <strong>{emptyLabel}</strong>
        </div>
      ) : (
        <table className="collaboration-issue-table" data-testid="collaboration-issue-table">
          <colgroup>
            {selectable && <col className="collaboration-issue-table-col-select" />}
            <col className="collaboration-issue-table-col-title" />
            <col className="collaboration-issue-table-col-status" />
            <col className="collaboration-issue-table-col-assignee" />
            <col className="collaboration-issue-table-col-tags collaboration-issue-table-secondary" />
            <col className="collaboration-issue-table-col-start collaboration-issue-table-secondary" />
            <col className="collaboration-issue-table-col-due collaboration-issue-table-secondary" />
            {executionLabel ? (
              <col className="collaboration-issue-table-col-execution collaboration-issue-table-secondary" />
            ) : null}
            <col className="collaboration-issue-table-col-updated collaboration-issue-table-secondary" />
            {onDelete ? <col className="collaboration-issue-table-col-actions" /> : null}
          </colgroup>
          {showControls && (
            <thead>
              <tr>
                {selectable && (
                  <th className="collaboration-issue-table-select">
                    <Checkbox
                      aria-label={selectAllLabel}
                      data-testid="collaboration-issue-table-select-all"
                      checked={
                        someVisibleSelected && !allVisibleSelected
                          ? 'indeterminate'
                          : allVisibleSelected
                      }
                      disabled={selectableVisibleIssues.length === 0}
                      onCheckedChange={toggleAllVisible}
                    />
                  </th>
                )}
                <th aria-sort={ariaSort('title')}>{sortButton('title', issueLabel)}</th>
                <th aria-sort={ariaSort('status')}>
                  <div className="collaboration-issue-table-header-controls">
                    {sortButton('status', statusLabel)}
                    <label
                      className={`collaboration-issue-table-header-filter ${
                        statusFilter ? 'is-active' : ''
                      }`}
                    >
                      <ChevronDown aria-hidden="true" />
                      <SelectRoot
                        value={String(statusFilter)}
                        onValueChange={selectedValue => {
                          if (selectedValue === null) return
                          return setStatusFilter(selectedValue)
                        }}
                      >
                        <SelectTrigger
                          aria-label={statusLabel}
                          data-testid="collaboration-issue-table-status-filter"
                        />
                        <SelectContent>
                          <SelectItem value="">
                            {allLabel} {statusLabel}
                          </SelectItem>
                          {filterOptions.statuses.map(status => (
                            <SelectItem key={status} value={String(status)}>
                              {statusName(status)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </SelectRoot>
                    </label>
                  </div>
                </th>
                <th aria-sort={ariaSort('assignee')}>
                  <div className="collaboration-issue-table-header-controls">
                    {sortButton('assignee', assignmentsLabel)}
                    <label
                      className={`collaboration-issue-table-header-filter ${
                        assigneeFilter ? 'is-active' : ''
                      }`}
                    >
                      <ChevronDown aria-hidden="true" />
                      <SelectRoot
                        value={String(assigneeFilter)}
                        onValueChange={selectedValue => {
                          if (selectedValue === null) return
                          return setAssigneeFilter(selectedValue)
                        }}
                      >
                        <SelectTrigger
                          aria-label={assignmentsLabel}
                          data-testid="collaboration-issue-table-assignee-filter"
                        />
                        <SelectContent>
                          <SelectItem value="">
                            {allLabel} {assignmentsLabel}
                          </SelectItem>
                          {filterOptions.assignees.map(([id, name]) => (
                            <SelectItem key={id} value={String(id)}>
                              {name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </SelectRoot>
                    </label>
                  </div>
                </th>
                <th className="collaboration-issue-table-secondary" aria-sort={ariaSort('tags')}>
                  <div className="collaboration-issue-table-header-controls">
                    {sortButton('tags', tagLabel)}
                    <label
                      className={`collaboration-issue-table-header-filter ${
                        tagFilter ? 'is-active' : ''
                      }`}
                    >
                      <ChevronDown aria-hidden="true" />
                      <SelectRoot
                        value={String(tagFilter)}
                        onValueChange={selectedValue => {
                          if (selectedValue === null) return
                          return setTagFilter(selectedValue)
                        }}
                      >
                        <SelectTrigger
                          aria-label={tagLabel}
                          data-testid="collaboration-issue-table-tag-filter"
                        />
                        <SelectContent>
                          <SelectItem value="">
                            {allLabel} {tagLabel}
                          </SelectItem>
                          {filterOptions.tags.map(tag => (
                            <SelectItem key={tag} value={String(tag)}>
                              {tag}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </SelectRoot>
                    </label>
                  </div>
                </th>
                <th
                  className="collaboration-issue-table-secondary"
                  aria-sort={ariaSort('start_at')}
                >
                  {sortButton('start_at', startAtLabel)}
                </th>
                <th className="collaboration-issue-table-secondary" aria-sort={ariaSort('due_at')}>
                  {sortButton('due_at', dueAtLabel)}
                </th>
                {executionLabel ? (
                  <th
                    className="collaboration-issue-table-secondary"
                    aria-sort={ariaSort('execution')}
                  >
                    {sortButton('execution', executionLabel)}
                  </th>
                ) : null}
                <th
                  className="collaboration-issue-table-secondary"
                  aria-sort={ariaSort('updated_at')}
                >
                  {sortButton('updated_at', updatedLabel)}
                </th>
                {onDelete ? (
                  <th className="collaboration-issue-table-actions-head">{actionsLabel}</th>
                ) : null}
              </tr>
            </thead>
          )}
          <tbody>
            {visibleIssues.map(issue => {
              const currentAssignment = currentAssignmentByIssueId[issue.id]
              const row = getRowOptions?.(issue)
              const assignee = currentAssignment?.target_name || row?.assigneeName
              return (
                <IssueOpenControl<HTMLTableRowElement>
                  key={issue.id}
                  onOpen={() => onOpen(issue)}
                  buttonProps={{ title: issue.title, 'aria-current': row?.active || undefined }}
                  testId={row?.buttonTestId ?? `collaboration-issue-table-open-${issue.id}`}
                  renderRow={(button, onRowClick) => (
                    <tr
                      className="cursor-pointer"
                      aria-current={row?.active || undefined}
                      ref={row?.ref}
                      data-testid={`collaboration-issue-table-row-${issue.id}`}
                      onClick={onRowClick}
                    >
                      {selectable && (
                        <td className="collaboration-issue-table-select">
                          <Checkbox
                            aria-label={`${selectIssueLabel} ${issue.title}`}
                            data-testid={`collaboration-issue-table-select-${issue.id}`}
                            checked={selectedIssueIds.has(issue.id)}
                            disabled={!canEditCollaborationIssue(issue)}
                            onCheckedChange={() => toggleIssue(issue)}
                          />
                        </td>
                      )}
                      <td>
                        {button}
                        {row?.details}
                      </td>
                      <td className="collaboration-issue-table-status">
                        {statusName(issue.status)}
                      </td>
                      <td className="collaboration-issue-table-assignee">
                        {assignee ? (
                          <span data-testid={`cloud-todo-card-assignee-${issue.id}`}>
                            {assignee}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="collaboration-issue-table-secondary">
                        {issue.tags?.length ? issue.tags.join(', ') : '—'}
                      </td>
                      <td className="collaboration-issue-table-date collaboration-issue-table-secondary">
                        {issue.start_at?.slice(0, 10) || '—'}
                      </td>
                      <td className="collaboration-issue-table-date collaboration-issue-table-secondary">
                        {issue.due_at?.slice(0, 10) || '—'}
                      </td>
                      {executionLabel ? (
                        <td
                          className="collaboration-issue-table-secondary"
                          data-testid={`collaboration-issue-table-execution-${issue.id}`}
                          title={issue.execution_error || undefined}
                        >
                          {issue.execution_state || '—'}
                        </td>
                      ) : null}
                      <td className="collaboration-issue-table-updated collaboration-issue-table-secondary">
                        <time dateTime={issue.updated_at}>
                          {formatIssueTimestamp(issue.updated_at)}
                        </time>
                      </td>
                      {onDelete ? (
                        <td className="collaboration-issue-table-actions">
                          {canEditCollaborationIssue(issue) && canDelete(issue) ? (
                            <ControlButton
                              variant="unstyled"
                              aria-label={deleteLabel}
                              className="collaboration-issue-table-delete"
                              data-testid={`collaboration-issue-table-delete-${issue.id}`}
                              onClick={() => onDelete(issue)}
                              title={deleteLabel}
                              type="button"
                            >
                              <Archive aria-hidden="true" />
                            </ControlButton>
                          ) : null}
                        </td>
                      ) : null}
                    </tr>
                  )}
                >
                  <IssueListTitle
                    title={issue.title}
                    issueId={issue.id}
                    reference={
                      showIssueKey
                        ? projectKey
                          ? `${projectKey}-${issue.sequence_number}`
                          : `#${issue.sequence_number}`
                        : undefined
                    }
                  />
                  {issue.created_at && (
                    <time dateTime={issue.created_at} className="block text-xs text-text-secondary">
                      {formatIssueTimestamp(issue.created_at)}
                    </time>
                  )}
                  {row?.titleTrailing}
                </IssueOpenControl>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
