import {
  CONVERSATION_SCROLL_WRITE_SOURCE,
  recordConversationScrollWrite,
} from './conversationScrollWrite'

export function isConversationScrollInput(event: Event): boolean {
  if (
    event instanceof KeyboardEvent &&
    !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
  )
    return false
  return !(
    event.target instanceof Element &&
    event.target.closest('input, textarea, [contenteditable="true"]')
  )
}

export function getDistanceFromBottom(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop)
}

export function getDistanceFromTop(element: HTMLElement): number {
  return Math.max(0, element.scrollTop)
}

export function setDistanceFromBottom(
  element: HTMLElement,
  distanceFromBottomPx: number,
  behavior: ScrollBehavior
): void {
  const distance = Math.max(0, distanceFromBottomPx)
  const top = Math.max(0, element.scrollHeight - element.clientHeight - distance)
  recordConversationScrollWrite(
    element,
    CONVERSATION_SCROLL_WRITE_SOURCE.distanceFromBottom,
    top,
    () => {
      if (typeof element.scrollTo === 'function') {
        element.scrollTo({ top, behavior })
      } else {
        element.scrollTop = top
      }
    }
  )
}

export function getScrollViewportBounds(element: HTMLElement): {
  startPx: number
  endPx: number
} {
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
  const top = positionPx
  recordConversationScrollWrite(
    element,
    CONVERSATION_SCROLL_WRITE_SOURCE.contentPosition,
    top,
    () => {
      if (typeof element.scrollTo === 'function') {
        element.scrollTo({ top, behavior })
      } else {
        element.scrollTop = top
      }
    }
  )
}

function getContentScrollPosition(element: HTMLElement): number {
  return getDistanceFromTop(element)
}
