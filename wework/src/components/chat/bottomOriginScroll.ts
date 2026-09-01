export function getDistanceFromBottom(element: HTMLElement, bottomOrigin: boolean): number {
  if (bottomOrigin) {
    return Math.max(0, -element.scrollTop)
  }
  return Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop)
}

export function getDistanceFromTop(element: HTMLElement, bottomOrigin: boolean): number {
  if (!bottomOrigin) return Math.max(0, element.scrollTop)
  const maximumOffset = Math.max(0, element.scrollHeight - element.clientHeight)
  return Math.max(0, maximumOffset + element.scrollTop)
}

export function setDistanceFromBottom(
  element: HTMLElement,
  distanceFromBottomPx: number,
  behavior: ScrollBehavior,
  bottomOrigin: boolean
): void {
  const distance = Math.max(0, distanceFromBottomPx)
  const top = bottomOrigin
    ? -distance
    : Math.max(0, element.scrollHeight - element.clientHeight - distance)
  if (typeof element.scrollTo === 'function') {
    element.scrollTo({ top, behavior })
  } else {
    element.scrollTop = top
  }
}

export function getScrollViewportBounds(element: HTMLElement): { startPx: number; endPx: number } {
  const startPx = getContentScrollPosition(element)
  return {
    startPx,
    endPx: startPx + element.clientHeight,
  }
}

export function getContentPositionForViewportY(element: HTMLElement, viewportY: number): number {
  return Math.max(
    0,
    getContentScrollPosition(element) + viewportY - element.getBoundingClientRect().top
  )
}

export function scrollToContentPosition(
  element: HTMLElement,
  positionPx: number,
  behavior: ScrollBehavior
): void {
  const top = hasBottomScrollOrigin(element)
    ? positionPx - Math.max(0, element.scrollHeight - element.clientHeight)
    : positionPx
  if (typeof element.scrollTo === 'function') {
    element.scrollTo({ top, behavior })
  } else {
    element.scrollTop = top
  }
}

export function hasBottomScrollOrigin(element: HTMLElement): boolean {
  return element.dataset.scrollOrigin === 'bottom'
}

function getContentScrollPosition(element: HTMLElement): number {
  return getDistanceFromTop(element, hasBottomScrollOrigin(element))
}
