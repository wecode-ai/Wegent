import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'

import {
  cacheConversationScrollSnapshot,
  getConversationScrollSnapshot,
  type ConversationScrollSnapshot,
} from './conversationViewportCache'
import { getDistanceFromBottom } from './bottomOriginScroll'

import {
  SCROLLED_TO_BOTTOM_THRESHOLD,
  SCROLL_ANCHOR_SELECTOR,
  type UserViewportAnchor,
} from './scrollableMessageTypes'
export function scrollPositionKey(
  conversationKey: string | number | null | undefined
): string | null {
  return conversationKey == null ? null : String(conversationKey)
}

export function findLatestGuidanceMessageId(messages: WorkbenchMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.runtimeGuidance === true) return message.id
  }
  return null
}

export function setConversationScrollSnapshot(key: string, snapshot: ConversationScrollSnapshot) {
  cacheConversationScrollSnapshot(key, snapshot)
}

export function getInitialDistanceFromBottomPx(key: string | null): number {
  if (key === null) return 0
  const distance = getConversationScrollSnapshot(key)?.distanceFromBottomPx
  return typeof distance === 'number' && Number.isFinite(distance) ? Math.max(0, distance) : 0
}

export function createUserViewportAnchor(
  scroller: HTMLElement,
  content: HTMLElement
): UserViewportAnchor | null {
  const scrollerRect = scroller.getBoundingClientRect()
  const visibleAnchor = Array.from(
    content.querySelectorAll<HTMLElement>(SCROLL_ANCHOR_SELECTOR)
  ).find(anchor => {
    const rect = anchor.getBoundingClientRect()
    return rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom
  })
  if (!visibleAnchor) return null

  const message = visibleAnchor.closest<HTMLElement>('[data-message-id]')
  const messageId = message?.dataset.messageId
  if (!message || !messageId) return null
  const anchors = Array.from(message.querySelectorAll<HTMLElement>(SCROLL_ANCHOR_SELECTOR))
  const anchorIndex = anchors.indexOf(visibleAnchor)
  if (anchorIndex < 0) return null
  const textPosition = getViewportTextPosition(visibleAnchor, scrollerRect)

  return {
    messageId,
    anchorIndex,
    offsetFromScrollerTop:
      (textPosition?.rect.top ?? visibleAnchor.getBoundingClientRect().top) - scrollerRect.top,
    textOffset: textPosition?.offset ?? null,
    scrollTopPx: scroller.scrollTop,
  }
}

export function findUserViewportAnchor(
  content: HTMLElement,
  anchor: UserViewportAnchor
): HTMLElement | null {
  const message = Array.from(content.querySelectorAll<HTMLElement>('[data-message-id]')).find(
    candidate => candidate.dataset.messageId === anchor.messageId
  )
  if (!message) return null
  return (
    Array.from(message.querySelectorAll<HTMLElement>(SCROLL_ANCHOR_SELECTOR))[anchor.anchorIndex] ??
    null
  )
}

export function getViewportTextPosition(
  element: HTMLElement,
  scrollerRect: DOMRect
): { offset: number; rect: DOMRect } | null {
  const elementRect = element.getBoundingClientRect()
  const y = Math.max(elementRect.top + 1, scrollerRect.top + 1)
  const left = Math.max(elementRect.left + 1, scrollerRect.left + 1)
  const right = Math.min(elementRect.right - 1, scrollerRect.right - 1)
  if (right < left) return null

  const documentWithCaretRange = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  const xCandidates = [left, (left + right) / 2, right]
  for (const x of xCandidates) {
    const range = documentWithCaretRange.caretRangeFromPoint?.(x, y)
    if (!range || !element.contains(range.startContainer)) continue
    const offset = getTextOffset(element, range.startContainer, range.startOffset)
    if (offset === null) continue
    const rect = getTextOffsetRect(element, offset, y)
    if (rect) return { offset, rect }
  }
  return null
}

export function getTextOffset(
  root: HTMLElement,
  target: Node,
  targetOffset: number
): number | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let offset = 0
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node === target) {
      return offset + Math.min(targetOffset, node.textContent?.length ?? 0)
    }
    offset += node.textContent?.length ?? 0
  }
  return null
}

export function getTextOffsetRect(
  root: HTMLElement,
  textOffset: number,
  targetY?: number
): DOMRect | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let remainingOffset = textOffset
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textLength = node.textContent?.length ?? 0
    if (remainingOffset > textLength) {
      remainingOffset -= textLength
      continue
    }
    if (textLength === 0) continue

    const startOffset = Math.min(remainingOffset, textLength - 1)
    const range = document.createRange()
    range.setStart(node, startOffset)
    range.setEnd(node, startOffset + 1)
    const rects = Array.from(range.getClientRects())
    if (rects.length === 0) return null
    if (targetY === undefined) return rects[0] ?? null
    return (
      rects.find(rect => rect.top <= targetY && rect.bottom >= targetY) ??
      rects.reduce((closest, rect) =>
        Math.abs(rect.top - targetY) < Math.abs(closest.top - targetY) ? rect : closest
      )
    )
  }
  return null
}

export function createScrollSnapshot(
  scroller: HTMLElement,
  bottomOrigin: boolean
): ConversationScrollSnapshot {
  const distanceFromBottomPx = getDistanceFromBottom(scroller, bottomOrigin)
  return {
    distanceFromBottomPx,
    pinnedToBottom: distanceFromBottomPx <= SCROLLED_TO_BOTTOM_THRESHOLD,
  }
}

export function findLatestUserMessageId(messages: WorkbenchMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') return messages[index].id
  }
  return null
}

export function getMaximumScrollOffset(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight)
}
