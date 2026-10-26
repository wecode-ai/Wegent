import { act, renderHook } from '@testing-library/react'
import { expect, test } from 'vitest'
import { useReaderViewportAnchor } from '../../../../packages/collaboration/src/conversation/useReaderViewportAnchor'
import type { UserViewportAnchor } from '../../../../packages/collaboration/src/conversation/scrollableMessageTypes'

test('applies a layout correction once when the reader moves away from the bottom', () => {
  const scroller = document.createElement('div')
  scroller.dataset.scrollOrigin = 'bottom'
  scroller.innerHTML = '<article data-message-id="message"><p data-scroll-anchor>Text</p></article>'
  document.body.append(scroller)
  let height = 3284
  let layoutShift = 0
  Object.defineProperties(scroller, {
    clientHeight: { value: 642 },
    clientWidth: { value: 1039 },
    scrollHeight: { get: () => height },
  })
  scroller.getBoundingClientRect = () => new DOMRect(0, 76, 1039, 642)
  const paragraph = scroller.querySelector('p')!
  paragraph.getBoundingClientRect = () =>
    new DOMRect(0, 76 + layoutShift - scroller.scrollTop, 623, 48)
  const anchor = { current: null as UserViewportAnchor | null }
  const { result, unmount } = renderHook(() =>
    useReaderViewportAnchor({
      activeScrollRefRef: { current: { current: scroller } },
      contentRef: { current: scroller },
      userViewportAnchorRef: anchor,
      selfScrollOffsetRef: { current: 0 },
      lastMeasuredLayoutRef: { current: null },
      lastScrollPositionRef: { current: null },
      bottomOrigin: true,
    })
  )
  try {
    act(() => result.current.captureUserViewportAnchor())
    expect(anchor.current?.scrollTopPx).toBe(0)
    // CI recorded a native user scroll followed by a 48px bottom-origin layout shift.
    scroller.scrollTop = -1062
    height -= 48
    layoutShift = 48
    act(() => result.current.restoreReaderPositionFromLayout())
    expect(scroller.scrollTop).toBe(-1014)
    act(() => result.current.restoreReaderPositionFromLayout())
    expect(scroller.scrollTop).toBe(-1014)
  } finally {
    unmount()
    scroller.remove()
  }
})
