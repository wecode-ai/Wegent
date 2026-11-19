import { bindDrag } from '@ui-sdk/core'
import { useEffect, useRef, type PointerEvent } from 'react'
import { setPanelResizeShieldActive } from '@/lib/panel-resize-shield'

interface PanelResizeDragOptions {
  cursor: 'col-resize' | 'row-resize'
  onMove: (position: { x: number; y: number }) => void
  onFinish?: () => void
  onEnd?: (canceled: boolean) => void
}

export function usePanelResizeDrag() {
  const cleanupRef = useRef<(() => void) | undefined>(undefined)
  useEffect(() => () => cleanupRef.current?.(), [])

  const stopResize = () => cleanupRef.current?.()
  const startResize = <T extends HTMLElement>(
    event: PointerEvent<T>,
    { cursor, onMove, onFinish, onEnd }: PanelResizeDragOptions
  ) => {
    if (event.button !== 0) return
    stopResize()
    event.preventDefault()
    const previousCursor = document.body.style.cursor
    const previousSelection = document.body.style.userSelect
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      stop()
      cleanupRef.current = undefined
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousSelection
      setPanelResizeShieldActive(false)
      onFinish?.()
    }
    cleanupRef.current = finish
    document.body.style.cursor = cursor
    document.body.style.userSelect = 'none'
    setPanelResizeShieldActive(true)
    const stop = bindDrag(event.currentTarget, event.nativeEvent, {
      onMove: position => {
        if (!finished) onMove(position)
      },
      onEnd: (_event, canceled) => {
        finish()
        onEnd?.(canceled)
      },
    })
  }

  return { startResize, stopResize }
}
