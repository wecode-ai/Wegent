import { useState } from 'react'
import { collectIssueSubtreeIds } from '../board'
import { collectIssueChildrenProgress } from '../project-board/IssueChildrenProgress'
import type { CollaborationIssue } from '../types'

export interface MilestoneFilterValue {
  milestoneId: string | null
}

export interface MilestoneFilterProps {
  filter?: MilestoneFilterValue
  onFilterChange?(milestoneId: string | null): void
}

export function useMilestoneFilter(
  projectId: string | undefined,
  view: string,
  issues: CollaborationIssue[],
  { filter, onFilterChange }: MilestoneFilterProps = {}
) {
  const [selection, setSelection] = useState<{
    projectId: string
    value: string | null
  } | null>(null)
  const [drilldown, setDrilldown] = useState<{
    projectId: string
    rootId: string
  } | null>(null)
  const [scope, setScope] = useState({ projectId, view })
  if (scope.projectId !== projectId || scope.view !== view) {
    setScope({ projectId, view })
    setDrilldown(null)
  }
  const baseValue =
    filter !== undefined
      ? (filter.milestoneId ?? 'all')
      : selection?.projectId === projectId && selection
        ? selection.value
        : 'all'
  const temporary = view === 'board' && drilldown?.projectId === projectId
  const value = temporary ? 'all' : baseValue
  const filteredIssues = issues.filter(
    issue => value === 'all' || (issue.milestone_id ?? null) === value
  )

  return {
    value,
    filteredIssues,
    select(value: string | null) {
      if (filter === undefined && projectId) setSelection({ projectId, value })
      onFilterChange?.(value === 'all' ? null : value)
      setDrilldown(null)
    },
    clear() {
      if (filter === undefined) setSelection(null)
      onFilterChange?.(null)
      setDrilldown(null)
    },
    openChildren(issue: CollaborationIssue) {
      if (!projectId || value === 'all') return
      const total = collectIssueChildrenProgress(issues).get(issue.id)?.total ?? 0
      const visible = collectIssueChildrenProgress(filteredIssues).get(issue.id)?.total ?? 0
      if (visible < total) setDrilldown({ projectId, rootId: issue.id })
    },
    changeParent(parentId: string | null) {
      setDrilldown(current =>
        current && parentId && collectIssueSubtreeIds(issues, current.rootId).has(parentId)
          ? current
          : null
      )
    },
  }
}
