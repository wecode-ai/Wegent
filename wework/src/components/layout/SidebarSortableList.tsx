import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useMemo, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface SidebarSortableListProps<T> {
  items: T[]
  getId: (item: T) => string
  getLabel: (item: T) => string
  canDrag?: (item: T) => boolean
  renderItem: (item: T) => ReactNode
  onMove: (item: T, beforeItem: T | null) => Promise<void>
  className?: string
  testId: string
}

interface SortableItemProps {
  id: string
  disabled: boolean
  children: ReactNode
}

function SortableItem({ id, disabled, children }: SortableItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id, disabled })

  return (
    <div
      ref={setNodeRef}
      data-sidebar-sortable-id={id}
      data-dragging={isDragging ? 'true' : undefined}
      className={cn(
        'relative touch-none',
        isDragging && 'z-[75] opacity-35',
        isOver &&
          !isDragging &&
          'before:absolute before:inset-x-2 before:-top-px before:z-[76] before:h-0.5 before:rounded-full before:bg-primary'
      )}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  )
}

export function SidebarSortableList<T>({
  items,
  getId,
  getLabel,
  canDrag = () => true,
  renderItem,
  onMove,
  className,
  testId,
}: SidebarSortableListProps<T>) {
  const sourceIds = useMemo(() => items.map(getId), [getId, items])
  const sourceSignature = sourceIds.join('\0')
  const [optimisticOrder, setOptimisticOrder] = useState<{
    sourceSignature: string
    ids: string[]
  } | null>(null)
  const orderedIds =
    optimisticOrder?.sourceSignature === sourceSignature ? optimisticOrder.ids : sourceIds
  const [activeId, setActiveId] = useState<string | null>(null)
  const itemById = useMemo(
    () => new Map(items.map(item => [getId(item), item] as const)),
    [getId, items]
  )
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const handleDragStart = ({ active }: DragStartEvent) => setActiveId(String(active.id))
  const handleDragEnd = async ({ active, over }: DragEndEvent) => {
    setActiveId(null)
    if (!over || active.id === over.id) return
    const oldIndex = orderedIds.indexOf(String(active.id))
    const newIndex = orderedIds.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return

    const previousIds = orderedIds
    const nextIds = arrayMove(previousIds, oldIndex, newIndex)
    const movedItem = itemById.get(String(active.id))
    const beforeItem = itemById.get(nextIds[newIndex + 1] ?? '') ?? null
    if (!movedItem) return

    setOptimisticOrder({ sourceSignature, ids: nextIds })
    try {
      await onMove(movedItem, beforeItem)
    } catch {
      setOptimisticOrder({ sourceSignature, ids: previousIds })
    }
  }

  const activeItem = activeId ? itemById.get(activeId) : undefined

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragCancel={() => setActiveId(null)}
      onDragEnd={event => void handleDragEnd(event)}
    >
      <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
        <div data-testid={testId} className={className}>
          {orderedIds.map(id => {
            const item = itemById.get(id)
            if (!item) return null
            return (
              <SortableItem key={id} id={id} disabled={!canDrag(item)}>
                {renderItem(item)}
              </SortableItem>
            )
          })}
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {activeItem ? (
          <div className="max-w-[280px] truncate rounded-lg border border-border bg-background px-3 py-2 text-[13px] text-text-primary shadow-lg">
            {getLabel(activeItem)}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
