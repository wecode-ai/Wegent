import { bindDrag } from '@ui-sdk/core'
import { useRef, type PointerEvent } from 'react'
import { setPanelResizeShieldActive } from '@/lib/panel-resize-shield'

interface PanelResizeDragOptions {
  cursor: 'col-resize' | 'row-resize'
  onMove: (position: { x: number; y: number }) => void
  onFinish?: () => void
  onEnd?: (canceled: boolean) => void
}

export function usePanelResizeDrag() {
  const cleanupRef = useRef<(() => void) | undefined>(undefined)

  const stopResize = () => cleanupRef.current?.()
  const startResize = <T extends HTMLElement>(
    event: PointerEvent<T>,
    { cursor, onMove, onFinish, onEnd }: PanelResizeDragOptions
  ) => {
    if (event.button !== 0) return
    stopResize()
    event.preventDefault()
    const target = event.currentTarget
    const owner = target.ownerDocument
    const previousCursor = owner.body.style.cursor
    const previousSelection = owner.body.style.userSelect
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      stop()
      attached.disconnect()
      cleanupRef.current = undefined
      owner.body.style.cursor = previousCursor
      owner.body.style.userSelect = previousSelection
      setPanelResizeShieldActive(false)
      onFinish?.()
    }
    cleanupRef.current = finish
    owner.body.style.cursor = cursor
    owner.body.style.userSelect = 'none'
    setPanelResizeShieldActive(true)
    const attached = new MutationObserver(() => {
      if (!target.isConnected) finish()
    })
    attached.observe(owner, { childList: true, subtree: true })
    const stop = bindDrag(target, event.nativeEvent, {
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
