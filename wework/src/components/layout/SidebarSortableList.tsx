import {
  SortableRoot,
  SortableItem,
  SortableHandle,
  SortableDragArea,
  type SortableChangeDetails,
} from '@wegent/collaboration/controls/Sortable'
import { GripVertical } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { isSidebarDragActivatorTarget } from './sidebarDragActivator'
import { useSidebarSortablePaneDrag } from './useSidebarSortablePaneDrag'
import type { WorkbenchSidebarPaneDragData } from './workbenchPaneDrag'

interface SidebarSortableListProps<T> {
  items: T[]
  getId(item: T): string
  getLabel(item: T): string
  canDrag?(item: T): boolean
  getExternalDragData?(item: T): WorkbenchSidebarPaneDragData
  renderItem(item: T): ReactNode
  onMove(item: T, beforeItem: T | null): Promise<void>
  className?: string
  testId: string
  accessibleLabel: string
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
  accessibleLabel,
}: SidebarSortableListProps<T>) {
  const { t } = useTranslation('common')
  const list = useRef<HTMLDivElement>(null)
  const sourceIds = useMemo(() => items.map(getId), [getId, items])
  const sourceSignature = sourceIds.join('\0')
  const itemById = useMemo(
    () => new Map(items.map(item => [getId(item), item] as const)),
    [getId, items]
  )
  const [optimisticOrder, setOptimisticOrder] = useState<{
    sourceSignature: string
    ids: string[]
  } | null>(null)
  const orderedIds =
    optimisticOrder?.sourceSignature === sourceSignature ? optimisticOrder.ids : sourceIds
  const revision = useRef(0)
  const mounted = useRef(false)
  const paneDrag = useSidebarSortablePaneDrag(list)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    revision.current++
  }, [sourceSignature])
  const commit = (ids: string[], details: SortableChangeDetails) => {
    const moved = itemById.get(details.key)
    if (paneDrag.suppressCommit(details.event) || !moved || !canDrag(moved)) {
      details.cancel()
      return
    }
    const previous = orderedIds
    const before = itemById.get(ids[details.toIndex + 1] ?? '') ?? null
    const request = ++revision.current
    setOptimisticOrder({ sourceSignature, ids })
    void Promise.resolve()
      .then(() => onMove(moved, before))
      .catch(() => {
        if (mounted.current && revision.current === request)
          setOptimisticOrder({ sourceSignature, ids: previous })
      })
  }
  return (
    <SortableRoot
      ref={list}
      value={orderedIds}
      autoScroll={!getExternalDragData}
      aria-label={accessibleLabel}
      data-testid={testId}
      className={className}
      canStartPointer={(event, key) => {
        if (!event.isPrimary || event.button !== 0 || !isSidebarDragActivatorTarget(event.target))
          return false
        const item = itemById.get(key)
        if (item && getExternalDragData) paneDrag.prepare(key, getExternalDragData(item), event)
        return true
      }}
      onValueChange={commit}
      onMoveStart={(key, event) => {
        const item = itemById.get(key)
        if (item && getExternalDragData) paneDrag.start(key, getExternalDragData(item), event)
      }}
      onMoveEnd={key => paneDrag.end(key)}
    >
      {state =>
        (paneDrag.sortingSuppressed ? state.value : (state.moving?.order ?? state.value)).map(
          id => {
            const item = itemById.get(id)
            if (!item) return null
            return (
              <div
                key={id}
                data-sidebar-sortable-id={id}
                data-dragging={state.moving?.key === id ? 'true' : undefined}
                className="relative"
              >
                <SortableItem
                  value={id}
                  label={getLabel(item)}
                  disabled={!canDrag(item) && !getExternalDragData?.(item)}
                >
                  <SortableHandle
                    disabled={!canDrag(item)}
                    onPointerDown={event => {
                      if (
                        event.isPrimary &&
                        event.button === 0 &&
                        canDrag(item) &&
                        getExternalDragData
                      )
                        paneDrag.prepare(id, getExternalDragData(item), event.nativeEvent)
                    }}
                    aria-label={t('workbench.reorder_item', { name: getLabel(item) })}
                    data-testid={`${testId}-handle-${id}`}
                    className="pointer-events-none absolute inset-y-0 right-0 z-10 opacity-0 focus:pointer-events-auto focus:bg-background focus:opacity-100 md:h-full md:min-h-0"
                  >
                    <GripVertical aria-hidden="true" />
                  </SortableHandle>
                  <SortableDragArea className="touch-none">{renderItem(item)}</SortableDragArea>
                </SortableItem>
              </div>
            )
          }
        )
      }
    </SortableRoot>
  )
}
