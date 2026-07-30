import type { CloudLoopItem, CloudProjectMember } from '@/api/deliveries'

export type TaskSearchFilters = {
  status: CloudLoopItem['status'] | null
  priority: CloudLoopItem['priority'] | null
  tag: string | null
  assigneeUserId: number | null
  creatorUserId: number | null
  due: 'any' | 'with_due_date' | 'overdue' | 'no_due_date'
  children: 'any' | 'with_children' | 'without_children'
}

export const emptyTaskSearchFilters: TaskSearchFilters = {
  status: null,
  priority: null,
  tag: null,
  assigneeUserId: null,
  creatorUserId: null,
  due: 'any',
  children: 'any',
}

export type TaskSearchResult = {
  item: CloudLoopItem
  score: number
  parentPath: string[]
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function textScore(item: CloudLoopItem, query: string, memberNames: Map<number, string>): number {
  if (!query) return 1
  const id = normalize(item.id)
  const title = normalize(item.title)
  const tags = (item.tags ?? []).map(normalize)
  const creator = normalize(
    item.created_by_user_name ?? memberNames.get(item.created_by_user_id) ?? ''
  )
  const assignee = normalize(memberNames.get(item.assignee_user_id ?? 0) ?? '')
  const description = normalize(item.description)
  if (id === query) return 100
  if (title === query) return 90
  if (title.startsWith(query)) return 80
  if (title.includes(query)) return 70
  if (id.includes(query)) return 65
  if (tags.some(tag => tag.includes(query))) return 60
  if (creator.includes(query) || assignee.includes(query)) return 55
  if (description.includes(query)) return 40
  return 0
}

function buildParentPath(item: CloudLoopItem, byId: Map<string, CloudLoopItem>): string[] {
  const path: string[] = []
  const visited = new Set<string>()
  let parentId = item.parent_id
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) break
    path.unshift(parent.title)
    parentId = parent.parent_id
  }
  return path
}

export function searchTasks(
  items: CloudLoopItem[],
  query: string,
  filters: TaskSearchFilters,
  members: CloudProjectMember[] = [],
  now = new Date()
): TaskSearchResult[] {
  const normalizedQuery = normalize(query)
  const byId = new Map(items.map(item => [item.id, item]))
  const childCounts = new Map<string, number>()
  for (const item of items) {
    if (item.parent_id) childCounts.set(item.parent_id, (childCounts.get(item.parent_id) ?? 0) + 1)
  }
  const memberNames = new Map(members.map(member => [member.user_id, member.user_name]))
  const today = now.toISOString().slice(0, 10)

  return items
    .map(item => ({ item, score: textScore(item, normalizedQuery, memberNames) }))
    .filter(({ item, score }) => {
      if (score === 0) return false
      if (filters.status && item.status !== filters.status) return false
      if (filters.priority && item.priority !== filters.priority) return false
      if (filters.tag && !(item.tags ?? []).includes(filters.tag)) return false
      if (filters.assigneeUserId && item.assignee_user_id !== filters.assigneeUserId) return false
      if (filters.creatorUserId && item.created_by_user_id !== filters.creatorUserId) return false
      if (filters.due === 'with_due_date' && !item.due_at) return false
      if (filters.due === 'no_due_date' && item.due_at) return false
      if (
        filters.due === 'overdue' &&
        (!item.due_at || item.due_at.slice(0, 10) >= today || item.status === 'completed')
      )
        return false
      const hasChildren = (childCounts.get(item.id) ?? 0) > 0
      if (filters.children === 'with_children' && !hasChildren) return false
      if (filters.children === 'without_children' && hasChildren) return false
      return true
    })
    .map(({ item, score }) => ({ item, score, parentPath: buildParentPath(item, byId) }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        Date.parse(right.item.updated_at) - Date.parse(left.item.updated_at)
    )
}

export function hasTaskSearchFilters(filters: TaskSearchFilters): boolean {
  return (
    filters.status !== null ||
    filters.priority !== null ||
    filters.tag !== null ||
    filters.assigneeUserId !== null ||
    filters.creatorUserId !== null ||
    filters.due !== 'any' ||
    filters.children !== 'any'
  )
}
