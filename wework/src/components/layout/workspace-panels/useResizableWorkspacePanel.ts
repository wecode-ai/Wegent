import { useState, type PointerEvent } from 'react'

const RIGHT_SPLIT_CHAT_DEFAULT_WIDTH = 420
const RIGHT_SPLIT_CHAT_MIN_WIDTH = 360
const RIGHT_SPLIT_CHAT_MAX_WIDTH = 620
const BOTTOM_DEFAULT_HEIGHT = 320
const BOTTOM_MIN_HEIGHT = 220
const BOTTOM_MAX_HEIGHT = 560

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export function useResizableRightSplitChat() {
  const [width, setWidth] = useState(RIGHT_SPLIT_CHAT_DEFAULT_WIDTH)

  const handleResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()

    const startX = event.clientX
    const startWidth = width

    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      setWidth(
        clamp(
          startWidth + moveEvent.clientX - startX,
          RIGHT_SPLIT_CHAT_MIN_WIDTH,
          RIGHT_SPLIT_CHAT_MAX_WIDTH,
        ),
      )
    }

    const handleUp = () => {
      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerup', handleUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('pointermove', handleMove)
    document.addEventListener('pointerup', handleUp)
  }

  return { width, handleResizeStart }
}

export function useResizableBottomPanel() {
  const [height, setHeight] = useState(BOTTOM_DEFAULT_HEIGHT)

  const handleResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()

    const startY = event.clientY
    const startHeight = height

    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      setHeight(clamp(startHeight + startY - moveEvent.clientY, BOTTOM_MIN_HEIGHT, BOTTOM_MAX_HEIGHT))
    }

    const handleUp = () => {
      document.removeEventListener('pointermove', handleMove)
      document.removeEventListener('pointerup', handleUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('pointermove', handleMove)
    document.addEventListener('pointerup', handleUp)
  }

  return { height, handleResizeStart }
}
