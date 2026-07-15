import type { TodoViewState } from './TodoDetailPanel'

export type TodoLayout = 'board' | 'list'
export type TodoAssigneeFilter = 'all' | 'unassigned' | 'ai' | 'human'
export type TodoPriorityFilter = 'all' | 'none' | 'urgent' | 'high' | 'normal' | 'low'
export type TodoUpdatedFilter = 'all' | '7d' | '30d'
export type TodoOrder = 'manual' | 'updated' | 'priority'

export interface TodoFilters {
  state: TodoViewState | 'all'
  assignee: TodoAssigneeFilter
  priority: TodoPriorityFilter
  updated: TodoUpdatedFilter
}

export interface TodoDisplaySettings {
  showAssignee: boolean
  showPriority: boolean
  showUpdated: boolean
  showObjective: boolean
  showEmptyGroups: boolean
  order: TodoOrder
}

export const DEFAULT_TODO_FILTERS: TodoFilters = {
  state: 'all',
  assignee: 'all',
  priority: 'all',
  updated: 'all',
}

export const DEFAULT_TODO_DISPLAY: TodoDisplaySettings = {
  showAssignee: true,
  showPriority: true,
  showUpdated: true,
  showObjective: false,
  showEmptyGroups: true,
  order: 'manual',
}

export function countActiveTodoFilters(filters: TodoFilters): number {
  return Object.values(filters).filter(value => value !== 'all').length
}
