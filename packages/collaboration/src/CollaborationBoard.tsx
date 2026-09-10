// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState, type DragEvent } from 'react'

import { groupBoardIssues, reorderLaneItems } from './board'
import { collaborationTestIds } from './testIds'
import type { CollaborationIssue, CollaborationProject, CollaborationStatus } from './types'

interface CollaborationBoardProps {
  project: CollaborationProject
  issues: CollaborationIssue[]
  statuses: CollaborationStatus[]
  labels: {
    noIssues: string
    search: string
    groupBy: string
    groupStatus: string
    groupPriority: string
    groupAssignee: string
    groupTag: string
    unassigned: string
    noTag: string
  }
  onOpen(issue: CollaborationIssue): void
  onReorder(
    issue: CollaborationIssue,
    status: string,
    laneIds: string[],
    optimisticItems: CollaborationIssue[]
  ): Promise<void>
  onGroupByChange(groupBy: NonNullable<CollaborationProject['board_config']>['group_by']): void
}

export function CollaborationBoard({
  project,
  issues,
  statuses,
  labels,
  onOpen,
  onReorder,
  onGroupByChange,
}: CollaborationBoardProps) {
  const [query, setQuery] = useState('')
  const [draggedId, setDraggedId] = useState<string | null>(null)
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleIssues = useMemo(
    () =>
      issues.filter(issue => {
        if (!normalizedQuery) return true
        return [
          `${project.project_key}-${issue.sequence_number}`,
          issue.title,
          issue.description,
          issue.assignee_name,
          issue.assignee_agent_name,
          issue.assignee_team_name,
          ...issue.tags,
        ].some(value => value?.toLocaleLowerCase().includes(normalizedQuery))
      }),
    [issues, normalizedQuery, project.project_key]
  )
  const groups = groupBoardIssues(project, visibleIssues, statuses, labels.unassigned, labels.noTag)
  const groupBy = project.board_config?.group_by ?? 'status'

  const drop = (
    event: DragEvent<HTMLElement>,
    status: string,
    beforeItemId: string | null = null
  ) => {
    event.preventDefault()
    const itemId = draggedId ?? event.dataTransfer.getData('text/plain')
    const item = issues.find(candidate => candidate.id === itemId)
    setDraggedId(null)
    if (!item || groupBy !== 'status') return
    const reordered = reorderLaneItems(issues, item.id, status, beforeItemId)
    if (reordered) void onReorder(item, status, reordered.laneIds, reordered.items)
  }

  return (
    <>
      <div className="collaboration-board-toolbar">
        <input
          type="search"
          data-testid="collaboration-board-search"
          placeholder={labels.search}
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        <label>
          {labels.groupBy}
          <select
            data-testid="collaboration-board-group-by"
            value={groupBy}
            onChange={event =>
              onGroupByChange(
                event.target.value as NonNullable<CollaborationProject['board_config']>['group_by']
              )
            }
          >
            <option value="status">{labels.groupStatus}</option>
            <option value="priority">{labels.groupPriority}</option>
            <option value="assignee">{labels.groupAssignee}</option>
            <option value="tag">{labels.groupTag}</option>
          </select>
        </label>
      </div>
      <div className="collaboration-board" data-testid={collaborationTestIds.board}>
        {groups.map(group => (
          <section
            className="collaboration-column"
            key={group.id}
            onDragOver={event => {
              if (groupBy === 'status') event.preventDefault()
            }}
            onDrop={event => drop(event, group.id)}
          >
            <header>
              {group.color && (
                <span className={`collaboration-status collaboration-status-${group.color}`} />
              )}
              <strong>{group.label}</strong>
              <small>{group.issues.length}</small>
            </header>
            <div data-testid={`collaboration-column-${group.id}`}>
              {group.issues.length === 0 && (
                <p className="collaboration-column-empty">{labels.noIssues}</p>
              )}
              {group.issues
                .sort((left, right) => left.sort_order - right.sort_order)
                .map(issue => (
                  <article
                    className="collaboration-issue-card"
                    data-testid={collaborationTestIds.issue(issue.id)}
                    draggable={groupBy === 'status'}
                    key={issue.id}
                    onDragStart={event => {
                      setDraggedId(issue.id)
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', issue.id)
                    }}
                    onDragOver={event => {
                      if (groupBy === 'status') event.preventDefault()
                    }}
                    onDrop={event => {
                      event.stopPropagation()
                      drop(event, issue.status, issue.id)
                    }}
                  >
                    <button type="button" onClick={() => onOpen(issue)}>
                      <small>
                        {project.project_key}-{issue.sequence_number}
                      </small>
                      <strong>{issue.title}</strong>
                      <span className={`collaboration-priority priority-${issue.priority}`}>
                        {issue.priority}
                      </span>
                      {issue.parent_id && <span className="collaboration-sub-issue">↳</span>}
                      {issue.assignee_name && <span>{issue.assignee_name}</span>}
                    </button>
                  </article>
                ))}
            </div>
          </section>
        ))}
      </div>
    </>
  )
}
