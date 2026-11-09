import type { CollaborationIssue } from '../types'
import {
  filterAndSortScheduleIssues,
  ganttIssueRange,
  type GanttIssueRange,
  type ScheduleViewOptions,
} from './model'

export interface GanttHierarchyRow {
  issue: CollaborationIssue
  root: CollaborationIssue
  range: GanttIssueRange | null
  depth: number
  hasChildren: boolean
}

/** Keep matching scheduled descendants together with their readable ancestors. */
export function ganttHierarchyRows(
  issues: readonly CollaborationIssue[],
  options: ScheduleViewOptions,
  windowStart: Date,
  windowEnd: Date,
  collapsed: ReadonlySet<string>,
): GanttHierarchyRow[] {
  const readable = issues.filter((issue) => issue.can_view_detail !== false)
  const byId = new Map(readable.map((issue) => [issue.id, issue]))
  const visibleRanges = new Map<string, GanttIssueRange>()
  const included = new Set<string>()
  const matching = filterAndSortScheduleIssues(readable, options)
  for (const issue of matching) {
    const range = ganttIssueRange(issue)
    if (!range || range.end < windowStart || range.start > windowEnd) continue
    visibleRanges.set(issue.id, range)
    let current: CollaborationIssue | undefined = issue
    const ancestors = new Set<string>()
    while (current && !ancestors.has(current.id)) {
      ancestors.add(current.id)
      included.add(current.id)
      current = current.parent_id ? byId.get(current.parent_id) : undefined
    }
  }
  const ordered = filterAndSortScheduleIssues(readable, {
    ...options,
    status: '',
    assignee: '',
    tag: '',
  }).filter((issue) => included.has(issue.id))
  const children = new Map<string, CollaborationIssue[]>()
  const roots: CollaborationIssue[] = []
  for (const issue of ordered) {
    if (issue.parent_id && included.has(issue.parent_id)) {
      const siblings = children.get(issue.parent_id) ?? []
      siblings.push(issue)
      children.set(issue.parent_id, siblings)
    } else {
      roots.push(issue)
    }
  }
  const rows: GanttHierarchyRow[] = []
  const visited = new Set<string>()
  const visit = (
    issue: CollaborationIssue,
    root: CollaborationIssue,
    depth: number,
  ) => {
    if (visited.has(issue.id)) return
    visited.add(issue.id)
    const descendants = children.get(issue.id) ?? []
    rows.push({
      issue,
      root,
      depth,
      hasChildren: descendants.length > 0,
      range: visibleRanges.get(issue.id) ?? null,
    })
    if (!collapsed.has(issue.id)) {
      for (const child of descendants) visit(child, root, depth + 1)
    }
  }
  for (const root of roots) visit(root, root, 0)
  return rows
}
