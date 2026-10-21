// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { compareIssueTimestamps } from '../issue-detail/issueTimestamp'

export const projectBoardSortModes = [
  'priority-desc',
  'priority-asc',
  'created-desc',
  'created-asc',
  'updated-desc',
  'updated-asc',
] as const
export type ProjectBoardSortRule = (typeof projectBoardSortModes)[number]
export type ProjectBoardSort = readonly ProjectBoardSortRule[]
export type ProjectBoardColumnSorts = Record<string, ProjectBoardSort>
export const defaultProjectBoardSort: ProjectBoardSort = ['priority-desc']
const sortLabelKeys = {
  label: 'by',
  manual: 'manual',
  add: 'add',
  remove: 'remove',
  moveUp: 'move_up',
  moveDown: 'move_down',
  description: 'description',
} as const
export type ProjectBoardSortLabels = Record<
  keyof typeof sortLabelKeys | ProjectBoardSortRule,
  string
>

export function createProjectBoardSortLabels(
  translate: (key: string) => string
): ProjectBoardSortLabels {
  return Object.fromEntries([
    ...Object.entries(sortLabelKeys).map(([name, key]) => [
      name,
      translate('todo.board_sort_' + key),
    ]),
    ...projectBoardSortModes.map(mode => [
      mode,
      translate('todo.board_sort_' + mode.replace('-', '_')),
    ]),
  ]) as ProjectBoardSortLabels
}

export const boardPriorities = ['urgent', 'high', 'medium', 'low', 'none'] as const
const priorityRank = (priority: string) => {
  const rank = boardPriorities.findIndex(value => value === priority)
  return rank < 0 ? boardPriorities.length : rank
}

export function projectBoardSortField(rule: ProjectBoardSortRule): string {
  return rule.split('-')[0]
}

function isProjectBoardSort(value: unknown): value is ProjectBoardSort {
  return (
    Array.isArray(value) &&
    value.every(rule => projectBoardSortModes.includes(rule)) &&
    new Set(value.map(projectBoardSortField)).size === value.length
  )
}

export function readProjectBoardColumnSorts(value: string | null): ProjectBoardColumnSorts {
  if (!value) return {}
  let saved: unknown
  try {
    saved = JSON.parse(value)
  } catch {
    return {}
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
  return Object.fromEntries(
    Object.entries(saved).filter((entry): entry is [string, ProjectBoardSort] =>
      isProjectBoardSort(entry[1])
    )
  )
}

interface SortableBoardItem {
  id?: string
  priority: string
  sort_order: number
  created_at: string
  updated_at: string
}

function compareRule(
  left: SortableBoardItem,
  right: SortableBoardItem,
  rule: ProjectBoardSortRule
): number {
  switch (rule) {
    case 'priority-desc':
      return priorityRank(left.priority) - priorityRank(right.priority)
    case 'priority-asc':
      return priorityRank(right.priority) - priorityRank(left.priority)
    case 'created-desc':
      return compareIssueTimestamps(right.created_at, left.created_at)
    case 'created-asc':
      return compareIssueTimestamps(left.created_at, right.created_at)
    case 'updated-desc':
      return compareIssueTimestamps(right.updated_at, left.updated_at)
    case 'updated-asc':
      return compareIssueTimestamps(left.updated_at, right.updated_at)
  }
}

export function compareProjectBoardItems(
  left: SortableBoardItem,
  right: SortableBoardItem,
  rules: ProjectBoardSort
): number {
  for (const rule of rules) {
    const order = compareRule(left, right, rule)
    if (order) return order
  }
  return (
    left.sort_order - right.sort_order ||
    compareIssueTimestamps(right.updated_at, left.updated_at) ||
    (left.id ?? '').localeCompare(right.id ?? '')
  )
}
