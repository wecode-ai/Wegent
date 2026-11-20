import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  useDraggable,
  useSensor,
  useSensors,
  type CollisionDetection,
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
import { useCallback, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useWindowEvent } from '@wegent/collaboration/dom-events'
import {
  createSidebarPointerDragSource,
  isWithinSidebarHorizontalBounds as isWithinHorizontalBounds,
  type SidebarPointerCoordinates as PointerCoordinates,
  type SidebarHorizontalBounds as HorizontalBounds,
} from './sidebarPointerDragSource'
import { cn } from '@/lib/utils'
import { SidebarPointerSensor } from './sidebarDragActivator'
import { getSidebarAutoScrollConfiguration } from './sidebarSortableAutoScroll'
import {
  dispatchWorkbenchSidebarPaneDragCancel,
  dispatchWorkbenchSidebarPaneDragEnd,
  dispatchWorkbenchSidebarPaneDragStart,
  type WorkbenchSidebarPaneDragData,
} from './workbenchPaneDrag'

const SIDEBAR_SORTABLE_POINTER_DISTANCE = 6

interface SidebarSortableListBaseProps<T> {
  items: T[]
  getId: (item: T) => string
  getLabel: (item: T) => string
  canDrag?: (item: T) => boolean
  getExternalDragData?: (item: T) => WorkbenchSidebarPaneDragData
  renderItem: (item: T) => ReactNode
  className?: string
  testId: string
}

type SidebarSortableListProps<T> = SidebarSortableListBaseProps<T> &
  (
    | { sortable: false; onMove?: (item: T, beforeItem: T | null) => Promise<void> }
    | { sortable?: true; onMove: (item: T, beforeItem: T | null) => Promise<void> }
  )

interface SortableItemProps {
  id: string
  disabled: boolean
  sortingSuppressed: boolean
  children: ReactNode
}

function readPointerCoordinates(event: Event): PointerCoordinates | null {
  if (!('clientX' in event) || !('clientY' in event)) return null
  const { clientX, clientY } = event
  return typeof clientX === 'number' && typeof clientY === 'number'
    ? { x: clientX, y: clientY }
    : null
}

function getHorizontalBounds(
  rects: Iterable<{ left: number; right: number }>
): HorizontalBounds | null {
  let left = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  for (const rect of rects) {
    left = Math.min(left, rect.left)
    right = Math.max(right, rect.right)
  }
  return Number.isFinite(left) && Number.isFinite(right) ? { left, right } : null
}

function SortableItem({ id, disabled, sortingSuppressed, children }: SortableItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id, disabled })
  const setSortableNodeRef = useCallback(
    (node: HTMLElement | null) => {
      setNodeRef(node)
      setActivatorNodeRef(node)
    },
    [setActivatorNodeRef, setNodeRef]
  )

  return (
    <div
      ref={setSortableNodeRef}
      data-sidebar-sortable-id={id}
      data-dragging={isDragging ? 'true' : undefined}
      className={cn(
        'relative touch-none',
        isDragging && 'z-[75] opacity-35',
        isOver &&
          !sortingSuppressed &&
          !isDragging &&
          'before:absolute before:inset-x-2 before:-top-px before:z-[76] before:h-0.5 before:rounded-full before:bg-primary'
      )}
      style={{
        transform: sortingSuppressed ? undefined : CSS.Transform.toString(transform),
        transition: sortingSuppressed ? undefined : transition,
      }}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  )
}

function DraggableItem({ id, disabled, children }: Omit<SortableItemProps, 'sortingSuppressed'>) {
  const { listeners, setNodeRef, isDragging } = useDraggable({ id, disabled })
  return (
    <div
      ref={setNodeRef}
      data-pane-drag-id={id}
      data-dragging={isDragging ? 'true' : undefined}
      className={cn('relative touch-none', isDragging && 'z-[75] opacity-35')}
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
  getExternalDragData,
  renderItem,
  onMove,
  sortable = true,
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
  const [pointerDrag] = useState(createSidebarPointerDragSource)
  const { suppressed: sortingSuppressed } = useSyncExternalStore(
    pointerDrag.subscribe,
    pointerDrag.getSnapshot,
    pointerDrag.getSnapshot
  )
  const trackPointer = (event: PointerEvent) => pointerDrag.track(readPointerCoordinates(event))
  useWindowEvent('pointermove', trackPointer, { capture: true })
  useWindowEvent('pointerup', trackPointer, { capture: true })
  useWindowEvent('pointercancel', trackPointer, { capture: true })
  const itemById = useMemo(
    () => new Map(items.map(item => [getId(item), item] as const)),
    [getId, items]
  )
  const sensors = useSensors(
    useSensor(SidebarPointerSensor, {
      activationConstraint: { distance: SIDEBAR_SORTABLE_POINTER_DISTANCE },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )
  const pointerSensors = useSensors(
    useSensor(SidebarPointerSensor, {
      activationConstraint: { distance: SIDEBAR_SORTABLE_POINTER_DISTANCE },
    })
  )

  const stopPointerTracking = pointerDrag.stop
  const startPointerTracking = pointerDrag.start

  const sidebarCollisionDetection = useCallback<CollisionDetection>(
    args => {
      pointerDrag.setBounds(getHorizontalBounds(args.droppableRects.values()))
      if (
        args.pointerCoordinates &&
        !isWithinHorizontalBounds(args.pointerCoordinates, pointerDrag.getBounds())
      ) {
        return []
      }
      return closestCenter(args)
    },
    [pointerDrag]
  )

  const handleDragStart = ({ active, activatorEvent }: DragStartEvent) => {
    const activeId = String(active.id)
    setActiveId(activeId)
    const item = itemById.get(activeId)
    const externalData = item ? getExternalDragData?.(item) : undefined
    const pointerCoordinates = readPointerCoordinates(activatorEvent)
    if (externalData && pointerCoordinates) {
      const initialRect = active.rect.current.initial
      pointerDrag.setBounds(
        initialRect ? { left: initialRect.left, right: initialRect.right } : null
      )
      startPointerTracking(pointerCoordinates)
      dispatchWorkbenchSidebarPaneDragStart(externalData)
    }
  }
  const handleDragEnd = async ({ active, over }: DragEndEvent) => {
    setActiveId(null)
    const movedItem = itemById.get(String(active.id))
    if (!movedItem && pointerDrag.getSnapshot().active) {
      dispatchWorkbenchSidebarPaneDragCancel()
      stopPointerTracking()
      return
    }
    const externalData = movedItem ? getExternalDragData?.(movedItem) : undefined
    const pointerCoordinates = pointerDrag.getCoordinates()
    const pointerOutsideSidebar =
      pointerCoordinates !== null &&
      !isWithinHorizontalBounds(pointerCoordinates, pointerDrag.getBounds())
    if (externalData && pointerDrag.getSnapshot().active) {
      if (pointerCoordinates) {
        const dragEndData = {
          ...externalData,
          clientX: pointerCoordinates.x,
          clientY: pointerCoordinates.y,
          handled: false,
        }
        dispatchWorkbenchSidebarPaneDragEnd(dragEndData)
        stopPointerTracking()
        if (dragEndData.handled || pointerOutsideSidebar) return
      } else {
        dispatchWorkbenchSidebarPaneDragCancel()
        stopPointerTracking()
      }
    }
    if (!sortable || !onMove || !over || active.id === over.id) return
    const oldIndex = orderedIds.indexOf(String(active.id))
    const newIndex = orderedIds.indexOf(String(over.id))
    if (oldIndex < 0 || newIndex < 0) return

    const previousIds = orderedIds
    const nextIds = arrayMove(previousIds, oldIndex, newIndex)
    const beforeItem = itemById.get(nextIds[newIndex + 1] ?? '') ?? null
    if (!movedItem || !canDrag(movedItem)) return

    setOptimisticOrder({ sourceSignature, ids: nextIds })
    try {
      await onMove(movedItem, beforeItem)
    } catch {
      setOptimisticOrder({ sourceSignature, ids: previousIds })
    }
  }

  const activeItem = activeId ? itemById.get(activeId) : undefined

  if (!sortable) {
    return (
      <DndContext
        sensors={pointerSensors}
        autoScroll={getSidebarAutoScrollConfiguration(Boolean(getExternalDragData))}
        collisionDetection={getExternalDragData ? sidebarCollisionDetection : closestCenter}
        onDragStart={handleDragStart}
        onDragCancel={() => {
          setActiveId(null)
          pointerDrag.cancel()
        }}
        onDragEnd={event => void handleDragEnd(event)}
      >
        <div data-testid={testId} className={className}>
          {items.map(item => {
            const id = getId(item)
            return (
              <DraggableItem
                key={id}
                id={id}
                disabled={!canDrag(item) && !getExternalDragData?.(item)}
              >
                {renderItem(item)}
              </DraggableItem>
            )
          })}
        </div>
        <DragOverlay dropAnimation={null}>
          {activeItem ? (
            <div className="max-w-[280px] truncate rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary shadow-lg">
              {getLabel(activeItem)}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    )
  }

  return (
    <DndContext
      sensors={sensors}
      autoScroll={getSidebarAutoScrollConfiguration(Boolean(getExternalDragData))}
      collisionDetection={getExternalDragData ? sidebarCollisionDetection : closestCenter}
      onDragStart={handleDragStart}
      onDragCancel={() => {
        setActiveId(null)
        pointerDrag.cancel()
      }}
      onDragEnd={event => void handleDragEnd(event)}
    >
      <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
        <div data-testid={testId} className={className}>
          {orderedIds.map(id => {
            const item = itemById.get(id)
            if (!item) return null
            return (
              <SortableItem
                key={id}
                id={id}
                disabled={!canDrag(item) && !getExternalDragData?.(item)}
                sortingSuppressed={sortingSuppressed}
              >
                {renderItem(item)}
              </SortableItem>
            )
          })}
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {activeItem ? (
          <div className="max-w-[280px] truncate rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary shadow-lg">
            {getLabel(activeItem)}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
