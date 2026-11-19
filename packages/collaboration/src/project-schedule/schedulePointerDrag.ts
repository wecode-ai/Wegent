import {
  bindDrag,
  bindDragPreview,
  createAutoScroll,
  type DragPreview,
} from '@ui-sdk/core'
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
} from 'react'
import { useCollaborationPortalTheme } from '../theme'
import { applyCollaborationPortalTheme } from '../theme/applyPortalTheme'

export interface SchedulePointerController {
  start(id: string): void
  move(id: string, delta: { x: number; y: number }, over: string | null): void
  end(id: string, over: string | null, canceled: boolean): void
  activeId: string | null
  delta: { x: number; y: number }
}
export const SchedulePointerContext =
  createContext<SchedulePointerController | null>(null)

function dateTarget(
  node: HTMLElement,
  event: globalThis.PointerEvent,
): string | null {
  for (const hit of node.ownerDocument.elementsFromPoint(
    event.clientX,
    event.clientY,
  )) {
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
  const [node, setElement] = useState<HTMLElement | null>(null)
  const latest = useRef({ context, disabled, theme })
  const cleanup = useRef<(() => void) | null>(null)
  useEffect(() => {
    latest.current = { context, disabled, theme }
  }, [context, disabled, theme])
  useEffect(() => () => cleanup.current?.(), [])
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
              !node ||
              !context ||
              event.button !== 0 ||
              event.isPrimary === false
            )
              return
            cleanup.current?.()
            const down = event.nativeEvent
            let started = false
            let last = down
            let copy: DragPreview | undefined
            const update = (move: globalThis.PointerEvent) => {
              last = move
              copy?.move(move.clientX, move.clientY)
              latest.current.context?.move(
                id,
                {
                  x: move.clientX - down.clientX,
                  y: move.clientY - down.clientY,
                },
                dateTarget(node, move),
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
                if (latest.current.disabled) return false
                started = true
                latest.current.context?.start(id)
                if (preview) {
                  copy = bindDragPreview(node, {
                    x: down.clientX,
                    y: down.clientY,
                  })
                  for (const child of copy.el.querySelectorAll('[data-testid]'))
                    child.removeAttribute('data-testid')
                  copy.el.setAttribute(
                    'data-testid',
                    'collaboration-schedule-undated-drag-overlay',
                  )
                  const currentTheme = latest.current.theme
                  applyCollaborationPortalTheme(copy.el, currentTheme)
                  copy.el.classList.add('cursor-grabbing', 'shadow-sm')
                }
              },
              onMove: (sample) => {
                update(sample.event)
                scroll.update(sample.x, sample.y)
              },
              onEnd: (up, canceled) => {
                scroll.stop()
                copy?.remove()
                cleanup.current = null
                if (started)
                  latest.current.context?.end(
                    id,
                    dateTarget(node, up),
                    canceled || latest.current.disabled,
                  )
              },
            })
            cleanup.current = () => {
              stop()
              scroll.stop()
              copy?.remove()
              if (started) latest.current.context?.end(id, null, true)
            }
          },
        },
  }
}
