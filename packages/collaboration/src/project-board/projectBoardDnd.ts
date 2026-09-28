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
} from '@dnd-kit/core'

export const projectBoardDnd = { DndContext, DragOverlay, useDroppable }

export function useProjectBoardSensors() {
  return useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
}

export function boardCardIdFromDropId(id: string | number | undefined): string | null {
  return typeof id === 'string' && id.startsWith('todo-card:')
    ? id.slice('todo-card:'.length) || null
    : null
}

export function projectBoardDrop(event: Pick<DragEndEvent, 'active' | 'over'>) {
  const beforeItemId = boardCardIdFromDropId(event.over?.id)
  const id = event.over?.id
  return {
    activeItemId: String(event.active.id),
    beforeItemId,
    columnDropKey:
      !beforeItemId && typeof id === 'string' && id.startsWith('todo-column:')
        ? id.slice('todo-column:'.length) || null
        : null,
  }
}

/** Card insertion takes precedence over its containing lane's append target. */
export const projectBoardCollisionDetection: CollisionDetection = args => {
  const collisions = pointerWithin(args)
  const card = collisions.find(collision => boardCardIdFromDropId(collision.id))
  return card ? [card] : collisions.slice(0, 1)
}
