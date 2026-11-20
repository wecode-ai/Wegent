import { useTranslation } from '@/hooks/useTranslation'
import {
  SortableDragArea,
  SortableHandle,
  SortableItem,
  SortableRoot,
  type SortableChangeDetails,
} from '@wegent/collaboration/controls/Sortable'
import { useMemo, useRef, useState, type ReactNode } from 'react'
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
  const { bindList, sortingSuppressed, prepare, start, suppressCommit, end } =
    useSidebarSortablePaneDrag()
  const commit = (ids: string[], details: SortableChangeDetails) => {
    const moved = itemById.get(details.key)
    if (suppressCommit(details.event) || !moved || !canDrag(moved)) {
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
        setOptimisticOrder(current =>
          revision.current === request && current?.sourceSignature === sourceSignature
            ? { sourceSignature, ids: previous }
            : current
        )
      })
  }
  return (
    <SortableRoot
      ref={bindList}
      value={orderedIds}
      autoScroll={!getExternalDragData}
      aria-label={accessibleLabel}
      data-testid={testId}
      className={className}
      canStartPointer={(event, key) => {
        if (!event.isPrimary || event.button !== 0 || !isSidebarDragActivatorTarget(event.target))
          return false
        const item = itemById.get(key)
        if (item && getExternalDragData) prepare(key, getExternalDragData(item), event)
        return true
      }}
      onValueChange={commit}
      onMoveStart={(key, event) => {
        const item = itemById.get(key)
        if (item && getExternalDragData) start(key, getExternalDragData(item), event)
      }}
      onMoveEnd={key => end(key)}
    >
      {state =>
        (sortingSuppressed ? state.value : (state.moving?.order ?? state.value)).map(id => {
          const item = itemById.get(id)
          if (!item) return null
          const reorderable = canDrag(item)
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
                disabled={!reorderable && !getExternalDragData?.(item)}
                className="rounded-lg has-[>[data-slot=sortable-handle]:focus-visible]:outline has-[>[data-slot=sortable-handle]:focus-visible]:outline-2 has-[>[data-slot=sortable-handle]:focus-visible]:-outline-offset-2 has-[>[data-slot=sortable-handle]:focus-visible]:outline-focus"
              >
                {reorderable && (
                  <SortableHandle
                    aria-label={t('workbench.reorder_item', { name: getLabel(item) })}
                    data-testid={`${testId}-handle-${id}`}
                    className="sr-only pointer-events-none"
                  />
                )}
                <SortableDragArea className="touch-none">{renderItem(item)}</SortableDragArea>
              </SortableItem>
            </div>
          )
        })
      }
    </SortableRoot>
  )
}
