import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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

interface SidebarSortableListProps<T> {
  items: T[]
  getId: (item: T) => string
  getLabel: (item: T) => string
  canDrag?: (item: T) => boolean
  getExternalDragData?: (item: T) => WorkbenchSidebarPaneDragData
  renderItem: (item: T) => ReactNode
  onMove: (item: T, beforeItem: T | null) => Promise<void>
  className?: string
  testId: string
}

interface SortableItemProps {
  id: string
  disabled: boolean
  sortingSuppressed: boolean
  children: ReactNode
}

interface PointerCoordinates {
  x: number
  y: number
}

interface HorizontalBounds {
  left: number
  right: number
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

function isWithinHorizontalBounds(
  coordinates: PointerCoordinates,
  bounds: HorizontalBounds | null
) {
  return !bounds || (coordinates.x >= bounds.left && coordinates.x <= bounds.right)
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

export function SidebarSortableList<T>({
  items,
  getId,
  getLabel,
  canDrag = () => true,
  getExternalDragData,
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
  const [sortingSuppressed, setSortingSuppressed] = useState(false)
  const pointerCoordinatesRef = useRef<PointerCoordinates | null>(null)
  const horizontalBoundsRef = useRef<HorizontalBounds | null>(null)
  const externalDragActiveRef = useRef(false)
  const pointerTrackingCleanupRef = useRef<(() => void) | null>(null)
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

  const clearPointerListeners = useCallback(() => {
    pointerTrackingCleanupRef.current?.()
    pointerTrackingCleanupRef.current = null
  }, [])

  const stopPointerTracking = useCallback(() => {
    clearPointerListeners()
    pointerCoordinatesRef.current = null
    externalDragActiveRef.current = false
    setSortingSuppressed(false)
  }, [clearPointerListeners])

  useEffect(() => clearPointerListeners, [clearPointerListeners])

  const startPointerTracking = useCallback(
    (initialCoordinates: PointerCoordinates) => {
      stopPointerTracking()
      externalDragActiveRef.current = true
      pointerCoordinatesRef.current = initialCoordinates
      const trackPointer = (event: PointerEvent) => {
        const coordinates = readPointerCoordinates(event)
        if (!coordinates) return
        pointerCoordinatesRef.current = coordinates
        setSortingSuppressed(!isWithinHorizontalBounds(coordinates, horizontalBoundsRef.current))
      }
      window.addEventListener('pointermove', trackPointer, true)
      window.addEventListener('pointerup', trackPointer, true)
      window.addEventListener('pointercancel', trackPointer, true)
      pointerTrackingCleanupRef.current = () => {
        window.removeEventListener('pointermove', trackPointer, true)
        window.removeEventListener('pointerup', trackPointer, true)
        window.removeEventListener('pointercancel', trackPointer, true)
      }
    },
    [stopPointerTracking]
  )

  const sidebarCollisionDetection = useCallback<CollisionDetection>(args => {
    horizontalBoundsRef.current = getHorizontalBounds(args.droppableRects.values())
    if (
      args.pointerCoordinates &&
      !isWithinHorizontalBounds(args.pointerCoordinates, horizontalBoundsRef.current)
    ) {
      return []
    }
    return closestCenter(args)
  }, [])

  const handleDragStart = ({ active, activatorEvent }: DragStartEvent) => {
    const activeId = String(active.id)
    setActiveId(activeId)
    const item = itemById.get(activeId)
    const externalData = item ? getExternalDragData?.(item) : undefined
    const pointerCoordinates = readPointerCoordinates(activatorEvent)
    if (externalData && pointerCoordinates) {
      const initialRect = active.rect.current.initial
      horizontalBoundsRef.current = initialRect
        ? { left: initialRect.left, right: initialRect.right }
        : null
      startPointerTracking(pointerCoordinates)
      dispatchWorkbenchSidebarPaneDragStart(externalData)
    }
  }
  const handleDragEnd = async ({ active, over }: DragEndEvent) => {
    setActiveId(null)
    const movedItem = itemById.get(String(active.id))
    const externalData = movedItem ? getExternalDragData?.(movedItem) : undefined
    const pointerCoordinates = pointerCoordinatesRef.current
    const pointerOutsideSidebar =
      pointerCoordinates !== null &&
      !isWithinHorizontalBounds(pointerCoordinates, horizontalBoundsRef.current)
    if (externalData && externalDragActiveRef.current) {
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
    if (!over || active.id === over.id) return
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

  return (
    <DndContext
      sensors={sensors}
      autoScroll={getSidebarAutoScrollConfiguration(Boolean(getExternalDragData))}
      collisionDetection={getExternalDragData ? sidebarCollisionDetection : closestCenter}
      onDragStart={handleDragStart}
      onDragCancel={() => {
        setActiveId(null)
        if (externalDragActiveRef.current) dispatchWorkbenchSidebarPaneDragCancel()
        stopPointerTracking()
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
