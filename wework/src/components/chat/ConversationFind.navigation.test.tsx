import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { resetConversationDiagnosticsForTest } from '@wegent/collaboration/conversation/conversationDiagnostics'
import {
  conversationSearchRanges,
  useConversationSearchTarget,
  type ConversationSearchTarget,
} from '../../../../packages/collaboration/src/conversation/useConversationSearchTarget'

function navigationFrames() {
  let nextId = 1
  const frames = new Map<number, FrameRequestCallback>()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    const id = nextId++
    frames.set(id, callback)
    return id
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
    frames.delete(id)
  })
  return () => {
    const pending = [...frames.values()]
    frames.clear()
    act(() => pending.forEach(callback => callback(performance.now())))
  }
}

afterEach(() => {
  cleanup()
  resetConversationDiagnosticsForTest()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('conversation find navigation', () => {
  test('reports a missing visible range once and ignores cancelled navigation', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const frame = navigationFrames()
    const content = document.createElement('div')
    content.innerHTML =
      '<article data-message-id="target"><div data-testid="assistant-message-content">different</div></article>'
    const scroller = document.createElement('div')
    const failure = vi.fn()
    const target = {
      query: 'needle',
      messageId: 'target',
      occurrence: 0,
      matchCounts: new Map([['target', 1]]),
    }
    const props = {
      target,
      navigationPaused: false,
      contentRef: { current: content },
      scrollRef: { current: scroller },
      onNavigationTargetChange: vi.fn(),
      onNavigationFailure: failure,
    }
    const { rerender } = renderHook(props => useConversationSearchTarget(props), {
      initialProps: props,
    })
    frame()
    act(() => vi.advanceTimersByTime(1500))
    expect(failure).toHaveBeenCalledExactlyOnceWith(target)
    act(() => vi.advanceTimersByTime(1500))
    expect(failure).toHaveBeenCalledOnce()
    rerender({ ...props, target: { ...target }, navigationPaused: true })
    frame()
    act(() => vi.advanceTimersByTime(1500))
    expect(failure).toHaveBeenCalledOnce()
  })

  test('waits for a mounted match, then keeps its diagram section as the anchor through SVG rendering', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const frame = navigationFrames()
    const scroller = document.createElement('div')
    scroller.scrollTo = vi.fn()
    Object.defineProperties(scroller, {
      scrollHeight: { value: 2000 },
      clientHeight: { value: 300 },
    })
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect)
    const content = document.createElement('div')
    content.innerHTML =
      '<article data-message-id="target"><div data-testid="assistant-message-content"><p>not ready</p></div></article>'
    const article = content.querySelector('article')!
    vi.spyOn(article, 'getBoundingClientRect').mockReturnValue({ top: 700, height: 600 } as DOMRect)
    const navigation = vi.fn()
    const { unmount } = renderHook(() =>
      useConversationSearchTarget({
        target: {
          query: 'keyword',
          messageId: 'target',
          occurrence: 0,
          matchCounts: new Map([['target', 1]]),
        },
        contentRef: { current: content },
        scrollRef: { current: scroller },
        onNavigationTargetChange: navigation,
      })
    )
    frame()
    frame()
    expect(scroller.scrollTo).not.toHaveBeenCalled()
    const body = article.querySelector('div')!
    await act(async () => {
      body.innerHTML =
        '<section><span hidden data-diagram-search-source>keyword</span><div data-search-excluded><span>keyword</span><img alt="keyword" /></div></section>'
      await Promise.resolve()
    })
    const section = body.querySelector('section')!
    let diagramTop = 700
    vi.spyOn(section, 'getBoundingClientRect').mockImplementation(
      () => ({ top: diagramTop, height: 384 }) as DOMRect
    )
    const ranges = conversationSearchRanges(article, 'keyword', 10)
    expect(ranges).toHaveLength(1)
    expect(ranges[0].startContainer.parentElement?.hasAttribute('data-diagram-search-source')).toBe(
      true
    )
    act(() => vi.advanceTimersByTime(80))
    frame()
    frame()
    expect(scroller.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 750, behavior: 'auto' })
    // Renderer changes must not invalidate the fixed section anchor or restart its two frames.
    await act(async () => {
      body.querySelector('[data-search-excluded]')!.innerHTML = '<img alt="keyword rendered" />'
      await Promise.resolve()
    })
    diagramTop = 400
    // A known match remains navigable even if rendering stalls longer than the missing-match timeout.
    act(() => vi.advanceTimersByTime(1600))
    frame()
    expect(scroller.scrollTo).toHaveBeenCalledTimes(1)
    frame()
    expect(scroller.scrollTo).toHaveBeenLastCalledWith({ top: 342, behavior: 'smooth' })
    expect(scroller.scrollTo).toHaveBeenCalledTimes(2)
    expect(navigation).toHaveBeenLastCalledWith('target')
    act(() => scroller.dispatchEvent(new Event('scrollend')))
    expect(navigation).toHaveBeenLastCalledWith(null)
    unmount()
    expect(scroller.scrollTo).toHaveBeenCalledTimes(2)
  })

  test.each(['pause', 'replace', 'timeout'] as const)(
    'cancels pending match preparation on %s without stopping native scroll',
    async reason => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const frame = navigationFrames()
      const scroller = document.createElement('div')
      scroller.scrollTo = vi.fn()
      Object.defineProperties(scroller, {
        scrollHeight: { value: 1000 },
        clientHeight: { value: 300 },
      })
      vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect)
      const content = document.createElement('div')
      content.innerHTML =
        '<article data-message-id="target"><div data-testid="assistant-message-content"><p>keyword</p></div></article>'
      const createRange = document.createRange.bind(document)
      vi.spyOn(document, 'createRange').mockImplementation(() => {
        const range = createRange()
        range.getBoundingClientRect = () => ({ top: 100, height: 20 }) as DOMRect
        return range
      })
      const navigation = vi.fn()
      const props = {
        target: {
          query: reason === 'timeout' ? 'missing' : 'keyword',
          messageId: 'target',
          occurrence: 0,
          matchCounts: new Map([['target', 1]]),
        } as ConversationSearchTarget | null,
        contentRef: { current: content },
        scrollRef: { current: scroller },
        navigationPaused: false,
        onNavigationTargetChange: navigation,
      }
      const { rerender } = renderHook(props => useConversationSearchTarget(props), {
        initialProps: props,
      })
      frame()
      frame()
      frame()
      expect(scroller.scrollTo).not.toHaveBeenCalled()
      if (reason === 'pause') rerender({ ...props, navigationPaused: true })
      else if (reason === 'replace')
        rerender({ ...props, target: { ...props.target!, query: 'missing' } })
      else act(() => vi.advanceTimersByTime(1500))
      frame()
      frame()
      frame()
      act(() => vi.advanceTimersByTime(1500))
      frame()
      expect(scroller.scrollTo).not.toHaveBeenCalled()
      expect(navigation).toHaveBeenLastCalledWith(null)
    }
  )

  test.each(['removed', 'unmeasured'] as const)(
    'releases navigation when a prepared match becomes %s',
    async state => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const frame = navigationFrames()
      const scroller = document.createElement('div')
      scroller.scrollTo = vi.fn()
      Object.defineProperties(scroller, {
        scrollHeight: { value: 1000 },
        clientHeight: { value: 300 },
      })
      vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect)
      const content = document.createElement('div')
      content.innerHTML =
        '<article data-message-id="target"><div data-testid="assistant-message-content"><p>keyword</p></div></article>'
      let rangeHeight = 20
      const createRange = document.createRange.bind(document)
      vi.spyOn(document, 'createRange').mockImplementation(() => {
        const range = createRange()
        range.getBoundingClientRect = () => ({ top: 200, height: rangeHeight }) as DOMRect
        return range
      })
      const navigation = vi.fn()
      renderHook(() =>
        useConversationSearchTarget({
          target: {
            query: 'keyword',
            messageId: 'target',
            occurrence: 0,
            matchCounts: new Map([['target', 1]]),
          },
          contentRef: { current: content },
          scrollRef: { current: scroller },
          onNavigationTargetChange: navigation,
        })
      )
      frame()
      frame()
      await act(async () => {
        if (state === 'removed') content.querySelector('p')!.textContent = 'not ready'
        else rangeHeight = 0
        await Promise.resolve()
      })
      frame()
      act(() => vi.advanceTimersByTime(1499))
      expect(navigation).toHaveBeenLastCalledWith('target')
      act(() => vi.advanceTimersByTime(1))
      frame()
      frame()
      expect(scroller.scrollTo).not.toHaveBeenCalled()
      expect(navigation.mock.calls).toEqual([['target'], [null]])
    }
  )

  test('completes its fixed preparation frames during continuing mutations and resizes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const frame = navigationFrames()
    let onResize!: ResizeObserverCallback
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          onResize = callback
        }
        observe = vi.fn()
        disconnect = vi.fn()
      }
    )
    const scroller = document.createElement('div')
    scroller.scrollTo = vi.fn()
    Object.defineProperties(scroller, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 300 },
    })
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 0 } as DOMRect)
    const content = document.createElement('div')
    content.innerHTML =
      '<article data-message-id="target"><div data-testid="assistant-message-content"><p>keyword</p><span></span></div></article>'
    const createRange = document.createRange.bind(document)
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = createRange()
      range.getBoundingClientRect = () => ({ top: 200, height: 20 }) as DOMRect
      return range
    })
    const navigation = vi.fn()
    renderHook(() =>
      useConversationSearchTarget({
        target: {
          query: 'keyword',
          messageId: 'target',
          occurrence: 0,
          matchCounts: new Map([['target', 1]]),
        },
        contentRef: { current: content },
        scrollRef: { current: scroller },
        onNavigationTargetChange: navigation,
      })
    )
    frame()
    frame()
    for (let index = 0; index < 2; index += 1) {
      await act(async () => {
        content.querySelector('span')!.textContent = `stream ${index}`
        onResize([], {} as ResizeObserver)
        await Promise.resolve()
      })
      frame()
    }
    expect(scroller.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 60, behavior: 'smooth' })
    expect(navigation).toHaveBeenLastCalledWith('target')
    act(() => scroller.dispatchEvent(new Event('scrollend')))
    expect(navigation).toHaveBeenLastCalledWith(null)
  })

  test.each([false, true])(
    'centers the selected occurrence with reduced motion=%s',
    async reducedMotion => {
      const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
      vi.spyOn(window, 'matchMedia').mockReturnValue({ ...preference, matches: reducedMotion })
      const highlights = new Map<string, Set<Range>>()
      vi.stubGlobal('CSS', { ...globalThis.CSS, highlights })
      vi.stubGlobal(
        'Highlight',
        class extends Set<Range> {
          constructor(...ranges: Range[]) {
            super(ranges)
          }
        }
      )
      const walk = vi.spyOn(document, 'createTreeWalker')
      let rangeTop = -300
      let onResize!: ResizeObserverCallback
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(callback: ResizeObserverCallback) {
            onResize = callback
          }
          observe = vi.fn()
          disconnect = vi.fn()
        }
      )
      const createRange = document.createRange.bind(document)
      vi.spyOn(document, 'createRange').mockImplementation(() => {
        const range = createRange()
        range.getBoundingClientRect = () =>
          (range.startContainer.nodeType === Node.TEXT_NODE
            ? { top: rangeTop, height: 20 }
            : { top: 0, height: 0 }) as DOMRect
        return range
      })
      const scroller = document.createElement('div')
      scroller.scrollTop = 900
      Object.defineProperties(scroller, {
        scrollHeight: { value: 1200 },
        clientHeight: { value: 300 },
      })
      vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect)
      scroller.scrollTo = vi.fn()
      const content = document.createElement('div')
      content.innerHTML =
        '<article data-message-id="ignored"><div data-testid="assistant-message-content"><p>输出 输出</p></div></article><article data-message-id="target"><div data-testid="assistant-message-content"><p>输出 输出</p></div></article>'
      const targetArticle = content.querySelector('[data-message-id="target"]')!
      vi.spyOn(targetArticle, 'getBoundingClientRect').mockReturnValue({
        top: -400,
        height: 200,
      } as DOMRect)
      const messageContent = targetArticle.querySelector(
        '[data-testid="assistant-message-content"]'
      )
      const ignoredContent = content.querySelector('[data-message-id="ignored"] div')
      const scanCount = () => walk.mock.calls.filter(([root]) => root === messageContent).length
      const navigation = vi.fn()
      const props = {
        target: {
          query: '输出',
          messageId: 'target',
          occurrence: 1,
          matchCounts: new Map([['target', 2]]),
        } as ConversationSearchTarget | null,
        contentRef: { current: content },
        scrollRef: { current: scroller },
        onNavigationTargetChange: navigation,
        navigationPaused: false,
      }
      const { rerender } = renderHook(props => useConversationSearchTarget(props), {
        initialProps: props,
      })
      await waitFor(() =>
        expect(scroller.scrollTo).toHaveBeenCalledWith({
          top: 360,
          behavior: reducedMotion ? 'auto' : 'smooth',
        })
      )
      expect(vi.mocked(scroller.scrollTo).mock.calls.map(([options]) => options)).toEqual(
        reducedMotion
          ? [{ top: 360, behavior: 'auto' }]
          : [
              { top: 350, behavior: 'auto' },
              { top: 360, behavior: 'smooth' },
            ]
      )
      const active = [...highlights.entries()].find(([name]) => name.endsWith('-active'))?.[1]
      expect([...(active ?? [])].map(range => range.startOffset)).toEqual([3])
      expect(scanCount()).toBe(1)
      expect(walk.mock.calls.some(([root]) => root === ignoredContent)).toBe(false)
      const scrollCount = vi.mocked(scroller.scrollTo).mock.calls.length
      rangeTop = -200
      await act(async () => {
        onResize([], {} as ResizeObserver)
        await new Promise(requestAnimationFrame)
      })
      expect(scroller.scrollTo).toHaveBeenCalledTimes(scrollCount)
      expect(scanCount()).toBe(1)
      await act(async () => {
        targetArticle.querySelector('p')!.textContent = '输出 输出 输出'
        await Promise.resolve()
        onResize([], {} as ResizeObserver)
      })
      await waitFor(() => expect(scanCount()).toBe(2))
      expect(scroller.scrollTo).toHaveBeenCalledTimes(scrollCount)
      expect([...highlights.entries()].find(([name]) => !name.endsWith('-active'))?.[1].size).toBe(
        2
      )
      targetArticle.querySelector('p')!.setAttribute('aria-hidden', 'true')
      await waitFor(() => expect(scanCount()).toBe(3))
      expect([...highlights.values()].every(ranges => ranges.size === 0)).toBe(true)
      targetArticle.querySelector('p')!.removeAttribute('aria-hidden')
      await waitFor(() => expect(scanCount()).toBe(4))
      expect([...highlights.entries()].find(([name]) => !name.endsWith('-active'))?.[1].size).toBe(
        2
      )
      const updatedProps = {
        ...props,
        target: { ...props.target!, matchCounts: new Map([['target', 3]]) },
      }
      rerender(updatedProps)
      await waitFor(() => expect(scanCount()).toBe(5))
      expect([...highlights.entries()].find(([name]) => !name.endsWith('-active'))?.[1].size).toBe(
        3
      )
      expect(walk.mock.calls.some(([root]) => root === ignoredContent)).toBe(false)
      const retainedHighlights = [...highlights.values()]
      rerender({ ...updatedProps, navigationPaused: true })
      const pausedHighlights = [...highlights.values()]
      expect(pausedHighlights).toHaveLength(retainedHighlights.length)
      pausedHighlights.forEach((ranges, index) => expect(ranges).toBe(retainedHighlights[index]))
      expect(navigation).toHaveBeenLastCalledWith(null)
      const pausedScrollCount = vi.mocked(scroller.scrollTo).mock.calls.length
      await act(async () => {
        onResize([], {} as ResizeObserver)
        await new Promise(requestAnimationFrame)
      })
      expect(scanCount()).toBe(5)
      expect(scroller.scrollTo).toHaveBeenCalledTimes(pausedScrollCount)
      rerender(updatedProps)
      await act(async () => {
        onResize([], {} as ResizeObserver)
        await new Promise(requestAnimationFrame)
      })
      expect(scroller.scrollTo).toHaveBeenCalledTimes(pausedScrollCount)
      rerender({ ...updatedProps, target: { ...updatedProps.target, occurrence: 0 } })
      await waitFor(() => expect(scanCount()).toBe(6))
      await waitFor(() =>
        expect(vi.mocked(scroller.scrollTo).mock.calls.length).toBeGreaterThan(pausedScrollCount)
      )
      const finalScrollCount = vi.mocked(scroller.scrollTo).mock.calls.length
      rerender({ ...props, target: null })
      expect(highlights.size).toBe(0)
      expect(navigation).toHaveBeenLastCalledWith(null)
      expect(scroller.scrollTo).toHaveBeenCalledTimes(finalScrollCount)
    }
  )
})
