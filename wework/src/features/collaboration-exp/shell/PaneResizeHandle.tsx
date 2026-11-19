import { useWindowEvent } from '@wegent/collaboration/dom-events'
import { useRef } from 'react'
import { Separator } from 'react-resizable-panels'
import { useTranslation } from '@/hooks/useTranslation'

export interface PaneResizeHandleProps {
  id: string
  getLayout: () => Record<string, number>
  setLayout: (layout: Record<string, number>) => void
  resetLayout: () => void
}

export function PaneResizeHandle({ id, getLayout, setLayout, resetLayout }: PaneResizeHandleProps) {
  const { t } = useTranslation('collaborationExp')
  const drag = useRef<{
    layout: Record<string, number>
    element: HTMLElement
    pointerId: number
  } | null>(null)

  const cancelDrag = () => {
    const current = drag.current
    if (!current) return
    setLayout(current.layout)
    if (current.element.hasPointerCapture?.(current.pointerId))
      current.element.releasePointerCapture(current.pointerId)
    // End the shared library's pointer session as well as restoring its layout.
    current.element.ownerDocument.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        button: 0,
        buttons: 0,
        pointerId: current.pointerId,
      })
    )
    drag.current = null
  }
  useWindowEvent(
    'keydown',
    event => {
      if (event.key !== 'Escape' || !drag.current) return
      event.preventDefault()
      event.stopImmediatePropagation()
      cancelDrag()
    },
    { capture: true }
  )
  useWindowEvent('pointerup', () => {
    drag.current = null
  })
  useWindowEvent('pointercancel', cancelDrag)
  useWindowEvent('blur', cancelDrag)

  return (
    <Separator
      id={`collaboration-exp-resize-${id}`}
      data-testid={`collaboration-exp-resize-${id}`}
      disableDoubleClick
      aria-label={t('shell.resize')}
      className="experience-pane-separator"
      onPointerDownCapture={event => {
        if (event.button !== 0) return
        drag.current = {
          layout: { ...getLayout() },
          element: event.currentTarget,
          pointerId: event.pointerId,
        }
      }}
      onDoubleClick={resetLayout}
    />
  )
}
