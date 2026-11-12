import type { ProjectBoardColumn } from './ProjectBoardBody'

export interface ParentBoardItem {
  id: string
  title: string
  parent_id: string | null
  status: string
  can_view_detail?: boolean
}

export interface ProjectBoardParentRow<T> {
  key: string
  parentId: string | null
  parent: T | null
  items: ReadonlyMap<string, readonly T[]>
  total: number
  completed: number
  running: number
}

/** Group direct children without deriving progress from repeated tag projections. */
export function projectBoardParentRows<T extends ParentBoardItem>({
  items,
  currentParentId,
  columns,
  getColumnItems,
}: {
  items: readonly T[]
  currentParentId: string | null
  columns: readonly ProjectBoardColumn[]
  getColumnItems(column: ProjectBoardColumn, parentId: string | null): readonly T[]
}): ProjectBoardParentRow<T>[] {
  const visible = items.filter(item => item.can_view_detail !== false)
  const byId = new Map(visible.map(item => [item.id, item]))
  const children = new Map<string | null, T[]>()
  for (const item of visible) {
    const siblings = children.get(item.parent_id) ?? []
    siblings.push(item)
    children.set(item.parent_id, siblings)
  }
  const layer = visible.filter(
    item =>
      item.parent_id === currentParentId ||
      (currentParentId === null && item.parent_id !== null && !byId.has(item.parent_id))
  )
  const result: ProjectBoardParentRow<T>[] = []
  const standalone = new Map<string | null, Set<string>>()
  const project = (parentId: string | null, allowed: Set<string>) =>
    new Map(
      columns.map(column => [
        column.key,
        getColumnItems(column, parentId).filter(item => allowed.has(item.id)),
      ])
    )
  for (const parent of layer) {
    const direct = children.get(parent.id) ?? []
    if (!direct.length) {
      const ids = standalone.get(parent.parent_id) ?? new Set<string>()
      ids.add(parent.id)
      standalone.set(parent.parent_id, ids)
      continue
    }
    const projected = project(parent.id, new Set(direct.map(item => item.id)))
    if (![...projected.values()].some(values => values.length)) continue
    result.push({
      key: `parent:${parent.id}`,
      parentId: parent.id,
      parent,
      items: projected,
      total: direct.length,
      completed: direct.filter(item => item.status === 'completed').length,
      running: direct.filter(item => item.status === 'in_progress').length,
    })
  }
  for (const [parentId, ids] of standalone) {
    const projected = project(parentId, ids)
    if (![...projected.values()].some(values => values.length)) continue
    result.push({
      key: `standalone:${parentId ?? ''}`,
      parentId,
      parent: null,
      items: projected,
      total: ids.size,
      completed: 0,
      running: 0,
    })
  }
  return result
}
