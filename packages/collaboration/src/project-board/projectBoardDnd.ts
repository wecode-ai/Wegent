import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import type { ProjectBoardGroupBy } from './useProjectBoardState'

const rowColumnPrefix = 'todo-row-column:'

export function projectBoardRowDropId(parentId: string | null, columnKey: string): string {
  return `${rowColumnPrefix}${JSON.stringify([parentId, columnKey])}`
}

function rowDropTarget(id: unknown): { targetParentId: string | null; columnKey: string } | null {
  if (typeof id !== 'string' || !id.startsWith(rowColumnPrefix)) return null
  try {
    const value: unknown = JSON.parse(id.slice(rowColumnPrefix.length))
    if (!Array.isArray(value) || value.length !== 2) return null
    const [parentId, columnKey] = value
    return (parentId === null || typeof parentId === 'string') && typeof columnKey === 'string'
      ? { targetParentId: parentId, columnKey }
      : null
  } catch {
    return null
  }
}

export const projectBoardDnd = { DndContext, DragOverlay, useDroppable }

export function useProjectBoardSensors() {
  return useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
}

export function projectBoardDragItemId(active: DragStartEvent['active']): string | null {
  const itemId = active.data.current?.itemId
  return typeof itemId === 'string' ? itemId : null
}

export function projectBoardDrop(event: Pick<DragEndEvent, 'active' | 'over'>) {
  const activeData = event.active.data.current
  const overData = event.over?.data.current
  const beforeItemId = typeof overData?.itemId === 'string' ? overData.itemId : null
  const id = event.over?.id
  const rowTarget = rowDropTarget(id)
  return {
    activeItemId: projectBoardDragItemId(event.active),
    beforeItemId,
    sourceColumnKey: typeof activeData?.columnKey === 'string' ? activeData.columnKey : undefined,
    groupBy: activeData?.groupBy as ProjectBoardGroupBy | undefined,
    columnDropKey: beforeItemId
      ? ((overData?.columnKey as string | undefined) ?? null)
      : rowTarget
        ? rowTarget.columnKey
        : typeof id === 'string' && id.startsWith('todo-column:')
          ? id.slice('todo-column:'.length) || null
          : null,
    ...(rowTarget ? { targetParentId: rowTarget.targetParentId } : {}),
  }
}

/** Card insertion takes precedence over its containing lane's append target. */
export const projectBoardCollisionDetection: CollisionDetection = args => {
  const collisions = pointerWithin(args)
  const card = collisions.find(collision => String(collision.id).startsWith('todo-card:'))
  return card ? [card] : collisions.slice(0, 1)
}
