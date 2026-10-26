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
  return {
    activeItemId: projectBoardDragItemId(event.active),
    beforeItemId,
    sourceColumnKey: typeof activeData?.columnKey === 'string' ? activeData.columnKey : undefined,
    groupBy: activeData?.groupBy as ProjectBoardGroupBy | undefined,
    columnDropKey: beforeItemId
      ? ((overData?.columnKey as string | undefined) ?? null)
      : typeof id === 'string' && id.startsWith('todo-column:')
        ? id.slice('todo-column:'.length) || null
        : null,
  }
}

/** Card insertion takes precedence over its containing lane's append target. */
export const projectBoardCollisionDetection: CollisionDetection = args => {
  const collisions = pointerWithin(args)
  const card = collisions.find(collision => String(collision.id).startsWith('todo-card:'))
  return card ? [card] : collisions.slice(0, 1)
}
