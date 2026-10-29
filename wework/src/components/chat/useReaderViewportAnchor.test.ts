import { act, renderHook } from '@testing-library/react'
import { expect, test } from 'vitest'
import { useReaderViewportAnchor } from '../../../../packages/collaboration/src/conversation/useReaderViewportAnchor'
import type { UserViewportAnchor } from '../../../../packages/collaboration/src/conversation/scrollableMessageTypes'

test('applies a layout correction once when the reader moves away from the bottom', () => {
  const scroller = document.createElement('div')
  scroller.dataset.scrollOrigin = 'top'
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
    })
  )
  try {
    act(() => result.current.captureUserViewportAnchor())
    expect(anchor.current?.scrollTopPx).toBe(0)
    // A native user scroll and a content layout shift can arrive before the same observation.
    scroller.scrollTop = 1062
    height -= 48
    layoutShift = 48
    act(() => result.current.restoreReaderPositionFromLayout())
    expect(scroller.scrollTop).toBe(1110)
    act(() => result.current.restoreReaderPositionFromLayout())
    expect(scroller.scrollTop).toBe(1110)
  } finally {
    unmount()
    scroller.remove()
  }
})

test('corrects only text reflow left after actual virtualizer compensation', () => {
  const scroller = document.createElement('div')
  scroller.innerHTML = '<article data-message-id="message"><p data-scroll-anchor>Text</p></article>'
  document.body.append(scroller)
  Object.defineProperties(scroller, {
    clientHeight: { value: 200 },
    clientWidth: { value: 800 },
    scrollHeight: { value: 2000 },
  })
  scroller.scrollTop = 200
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 800, 200)
  let contentTop = 260
  scroller.querySelector('p')!.getBoundingClientRect = () =>
    new DOMRect(0, contentTop - scroller.scrollTop, 600, 24)
  const selfOffset = { current: 0 }
  const anchor = { current: null as UserViewportAnchor | null }
  const hook = renderHook(() =>
    useReaderViewportAnchor({
      activeScrollRefRef: { current: { current: scroller } },
      contentRef: { current: scroller },
      userViewportAnchorRef: anchor,
      selfScrollOffsetRef: selfOffset,
      lastMeasuredLayoutRef: { current: null },
      lastScrollPositionRef: { current: null },
    })
  )
  try {
    act(() => hook.result.current.captureUserViewportAnchor())
    expect(anchor.current).not.toBeNull()
    contentTop += 100
    scroller.scrollTop += 100
    selfOffset.current += 100
    act(() => hook.result.current.restoreReaderPositionFromLayout())
    expect(scroller.scrollTop).toBe(300)
    contentTop += 30
    act(() => hook.result.current.restoreReaderPositionFromLayout())
    expect(scroller.scrollTop).toBe(330)
    act(() => hook.result.current.restoreReaderPositionFromLayout())
    expect(scroller.scrollTop).toBe(330)
  } finally {
    hook.unmount()
    scroller.remove()
  }
})
