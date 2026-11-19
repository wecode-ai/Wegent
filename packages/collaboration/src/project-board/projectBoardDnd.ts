import type { ProjectBoardGroupBy } from './useProjectBoardState'

export interface ProjectBoardDragMetadata {
  itemId?: string
  columnKey?: string
  groupBy?: ProjectBoardGroupBy
}
export interface ProjectBoardDragItem extends ProjectBoardDragMetadata {
  id: string
}
export interface ProjectBoardDropInput {
  source: ProjectBoardDragItem
  target: ProjectBoardDragItem | null
}
const rowColumnPrefix = 'todo-row-column:'
export function projectBoardRowDropId(
  parentId: string | null,
  columnKey: string,
): string {
  return `${rowColumnPrefix}${JSON.stringify([parentId, columnKey])}`
}
function rowDropTarget(
  id: unknown,
): { targetParentId: string | null; columnKey: string } | null {
  if (typeof id !== 'string' || !id.startsWith(rowColumnPrefix)) return null
  try {
    const value: unknown = JSON.parse(id.slice(rowColumnPrefix.length))
    if (!Array.isArray(value) || value.length !== 2) return null
    const [parentId, columnKey] = value
    return (parentId === null || typeof parentId === 'string') &&
      typeof columnKey === 'string'
      ? { targetParentId: parentId, columnKey }
      : null
  } catch {
    return null
  }
}
export function projectBoardDragItemId(
  active: ProjectBoardDragItem,
): string | null {
  const itemId = active.itemId
  return typeof itemId === 'string' ? itemId : null
}
export function projectBoardDrop(event: ProjectBoardDropInput) {
  const activeData = event.source
  const overData = event.target
  const beforeItemId =
    typeof overData?.itemId === 'string' ? overData.itemId : null
  const id = event.target?.id
  const rowTarget = rowDropTarget(id)
  return {
    activeItemId: projectBoardDragItemId(event.source),
    beforeItemId,
    sourceColumnKey: activeData?.columnKey,
    groupBy: activeData?.groupBy,
    columnDropKey: beforeItemId
      ? (overData?.columnKey ?? null)
      : rowTarget
        ? rowTarget.columnKey
        : typeof id === 'string' && id.startsWith('todo-column:')
          ? id.slice('todo-column:'.length) || null
          : null,
    ...(rowTarget ? { targetParentId: rowTarget.targetParentId } : {}),
  }
}

export type ProjectBoardDrop = ReturnType<typeof projectBoardDrop>
