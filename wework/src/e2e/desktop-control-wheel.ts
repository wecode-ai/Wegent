export function dispatchDesktopControlWheel(element: HTMLElement, value: string): string {
  const { deltaX = 0, deltaY = 0 } = JSON.parse(value) as {
    deltaX?: number
    deltaY?: number
  }
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
    throw new Error('Wheel input requires finite deltaX and deltaY values')
  }
  const accepted = element.dispatchEvent(
    new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      composed: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaX,
      deltaY,
    })
  )
  return JSON.stringify({ defaultPrevented: !accepted })
}
