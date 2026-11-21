import { bindDrag, bindDragPreview, createAutoScroll, type DragPreview } from '@ui-sdk/core'
import { createContext, useContext, useCallback, useRef, type PointerEvent } from 'react'
import { useCollaborationPortalTheme } from '../theme'
import { applyCollaborationPortalTheme } from '../theme/applyPortalTheme'

export interface SchedulePointerController {
  start(id: string): void
  move(id: string, delta: { x: number; y: number }, over: string | null): void
  end(id: string, over: string | null, canceled: boolean): void
  activeId: string | null
  delta: { x: number; y: number }
}
export const SchedulePointerContext = createContext<SchedulePointerController | null>(null)

function dateTarget(node: HTMLElement, event: globalThis.PointerEvent): string | null {
  for (const hit of node.ownerDocument.elementsFromPoint(event.clientX, event.clientY)) {
    const zone = hit.closest<HTMLElement>('[data-schedule-drop-id]')
    if (zone?.dataset.scheduleDropId) return zone.dataset.scheduleDropId
  }
  return null
}

export function useSchedulePointerDrag({
  id,
  disabled,
  preview = false,
}: {
  id: string
  disabled: boolean
  preview?: boolean
}) {
  const context = useContext(SchedulePointerContext)
  const theme = useCollaborationPortalTheme()
  const cleanup = useRef<(() => void) | null>(null)
  const startDrag = context?.start
  const moveDrag = context?.move
  const endDrag = context?.end
  const setElement = useCallback(
    (node: HTMLElement | null) => {
      if (!node || disabled || !startDrag || !moveDrag || !endDrag) return
      return () => {
        const cancel = cleanup.current
        cleanup.current = null
        cancel?.()
      }
    },
    [disabled, endDrag, moveDrag, startDrag]
  )
  const dragging = context?.activeId === id
  return {
    setElement,
    isDragging: dragging,
    transform: dragging ? context.delta : null,
    buttonProps: disabled
      ? {}
      : {
          'aria-pressed': dragging,
          onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
            if (
              !startDrag ||
              !moveDrag ||
              !endDrag ||
              event.button !== 0 ||
              event.isPrimary === false
            )
              return
            cleanup.current?.()
            const node = event.currentTarget
            const down = event.nativeEvent
            let started = false
            let last = down
            let copy: DragPreview | undefined
            const update = (move: globalThis.PointerEvent) => {
              last = move
              copy?.move(move.clientX, move.clientY)
              moveDrag(
                id,
                {
                  x: move.clientX - down.clientX,
                  y: move.clientY - down.clientY,
                },
                dateTarget(node, move)
              )
            }
            const scroll = createAutoScroll({
              ignore: () => node,
              onScroll: () => update(last),
            })
            const stop = bindDrag(node, down, {
              threshold: 6,
              cancelOnEscape: true,
              onStart: () => {
                started = true
                startDrag(id)
                if (preview) {
                  copy = bindDragPreview(node, {
                    x: down.clientX,
                    y: down.clientY,
                  })
                  for (const child of copy.el.querySelectorAll('[data-testid]'))
                    child.removeAttribute('data-testid')
                  copy.el.setAttribute('data-testid', 'collaboration-schedule-undated-drag-overlay')
                  applyCollaborationPortalTheme(copy.el, theme)
                  copy.el.classList.add('cursor-grabbing', 'shadow-sm')
                }
              },
              onMove: sample => {
                update(sample.event)
                scroll.update(sample.x, sample.y)
              },
              onEnd: (up, canceled) => {
                scroll.stop()
                copy?.remove()
                cleanup.current = null
                if (started) endDrag(id, dateTarget(node, up), canceled)
              },
            })
            cleanup.current = () => {
              stop()
              scroll.stop()
              copy?.remove()
              if (started) endDrag(id, null, true)
            }
          },
        },
  }
}
