import { act, cleanup, fireEvent, renderHook } from '@testing-library/react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { useConversationSearchTarget } from '../../../../packages/collaboration/src/conversation/useConversationSearchTarget'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

test.each([2523, 87])(
  'keeps instant search protected through native offset read-back (initial offset %s)',
  initialOffset => {
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      frames.set(++nextFrame, callback)
      return nextFrame
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => frames.delete(id))
    const frame = () => {
      const pending = [...frames.values()]
      frames.clear()
      act(() => pending.forEach(callback => callback(performance.now())))
    }
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    vi.spyOn(window, 'matchMedia').mockReturnValue({ ...preference, matches: true })
    const scroller = document.createElement('div')
    const content = document.createElement('div')
    content.innerHTML =
      '<article data-message-id="target"><div data-testid="assistant-message-content">needle</div></article>'
    scroller.append(content)
    document.body.append(scroller)
    Object.defineProperties(scroller, {
      clientHeight: { value: 800 },
      offsetHeight: { value: 800 },
      offsetWidth: { value: 900 },
      scrollHeight: { value: 4994 },
    })
    scroller.scrollTop = initialOffset
    scroller.getBoundingClientRect = () => new DOMRect(0, 0, 900, 800)
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      scroller.scrollTop = Number(top)
    })
    const createRange = document.createRange.bind(document)
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = createRange()
      range.getBoundingClientRect = () => new DOMRect(0, 477.5 - scroller.scrollTop, 100, 19)
      return range
    })
    const navigation = vi.fn()
    const target = {
      query: 'needle',
      messageId: 'target',
      occurrence: 0,
      matchCounts: new Map([['target', 1]]),
    }
    const contentRef = { current: content }
    const scrollRef = { current: scroller }
    const { result } = renderHook(() => {
      const engine = useVirtualizer<HTMLDivElement, HTMLElement>({
        count: 6,
        getScrollElement: () => scroller,
        estimateSize: index => [99, 144, 800, 800, 800, 2271][index],
        gap: 16,
        initialRect: { width: 900, height: 800 },
        initialOffset,
      })
      const onNavigationTargetChange = useCallback(
        (messageId: string | null) => {
          navigation(messageId)
          engine.shouldAdjustScrollPositionOnItemSizeChange = messageId ? () => false : undefined
        },
        [engine]
      )
      useConversationSearchTarget({
        target,
        contentRef,
        scrollRef,
        navigationPaused: false,
        onNavigationTargetChange,
      })
      return engine
    })
    vi.mocked(scroller.scrollTo).mockClear()
    for (let index = 0; index < 4; index += 1) {
      frame()
      if (vi.mocked(scroller.scrollTo).mock.calls.length) break
    }
    expect(scroller.scrollTo).toHaveBeenLastCalledWith({ top: 87, behavior: 'auto' })
    expect(result.current.getScrollOffset()).toBe(initialOffset)

    act(() => result.current.resizeItem(1, 48))
    expect(scroller.scrollTop).toBe(87)
    expect(navigation).toHaveBeenLastCalledWith('target')
    fireEvent.scroll(scroller)
    expect(result.current.getScrollOffset()).toBe(87)
    frame()
    expect(navigation).toHaveBeenLastCalledWith(null)
    expect(result.current.shouldAdjustScrollPositionOnItemSizeChange).toBeUndefined()
    act(() => result.current.resizeItem(1, 24))
    expect(scroller.scrollTop).toBe(87)
  }
)
