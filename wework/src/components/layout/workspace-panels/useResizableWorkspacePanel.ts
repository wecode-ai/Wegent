import { useState, type PointerEvent } from 'react'

const RIGHT_DEFAULT_WIDTH = 560
const RIGHT_MIN_WIDTH = 480
const RIGHT_MAX_WIDTH = 760
const BOTTOM_DEFAULT_HEIGHT = 320
const BOTTOM_MIN_HEIGHT = 220
const BOTTOM_MAX_HEIGHT = 560

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export function useResizableRightPanel() {
  const [width, setWidth] = useState(RIGHT_DEFAULT_WIDTH)

  const handleResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()

    const startX = event.clientX
    const startWidth = width

    const handleMove = (moveEvent: globalThis.PointerEvent) => {
      setWidth(clamp(startWidth + startX - moveEvent.clientX, RIGHT_MIN_WIDTH, RIGHT_MAX_WIDTH))
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
