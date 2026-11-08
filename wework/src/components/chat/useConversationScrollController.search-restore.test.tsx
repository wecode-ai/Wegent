import { act, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useConversationScrollController } from '../../../../packages/collaboration/src/conversation/useConversationScrollController'
import { getConversationScrollSnapshot } from '@/features/workbench/runtimeConversationCache'
import { useConversationVirtualizer } from '@wegent/collaboration/conversation/useConversationVirtualizer'
import { scrollToContentPosition } from '@wegent/collaboration/conversation/conversationViewportScroll'

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

test('reads the completed search position before a row resize can compensate a stale offset', () => {
  const viewport = document.createElement('div')
  const list = document.createElement('div')
  viewport.append(list)
  document.body.append(viewport)
  Object.defineProperties(viewport, {
    clientHeight: { value: 200 },
    clientWidth: { value: 800 },
    offsetHeight: { value: 200 },
    offsetWidth: { value: 800 },
    scrollHeight: { value: 3000 },
  })
  viewport.getBoundingClientRect = () => new DOMRect(0, 0, 800, 200)
  list.getBoundingClientRect = () => new DOMRect(0, -viewport.scrollTop, 800, 3000)
  viewport.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
    viewport.scrollTop = Number(top)
  })
  const scrollElementRef = { current: viewport }
  const listRef = { current: list }
  const hook = renderHook(() => {
    const controller = useConversationScrollController({
      conversationKey: 'search-offset-before-measurement',
      externalScrollRef: scrollElementRef,
      messages: [],
      autoScrollSuspended: true,
    })
    const { virtualizer } = useConversationVirtualizer({
      enabled: true,
      count: 3,
      estimateSize: () => 1000,
      scrollElementRef,
      listRef,
      virtualizerRef: controller.virtualizerRef,
      initialDistanceFromBottomPx: 0,
      anchorTo: controller.virtualAnchor,
      scrollEndThreshold: -1,
    })
    return { controller, virtualizer }
  })
  act(() => {
    hook.result.current.controller.handleTurnNavigationScrollTargetChange('match')
    hook.result.current.virtualizer.scrollToOffset(2500)
    fireEvent.scroll(viewport)
  })
  expect(hook.result.current.virtualizer.scrollOffset).toBe(2500)
  act(() => {
    // Search uses the shared writer before its asynchronous native scroll event.
    scrollToContentPosition(viewport, 87, 'auto')
    hook.result.current.controller.handleTurnNavigationScrollTargetChange(null)
  })
  act(() => hook.result.current.virtualizer.resizeItem(1, 24))
  expect(viewport.scrollTop).toBe(87)
  expect(hook.result.current.virtualizer.scrollOffset).toBe(87)
  hook.unmount()
})

test('saves actual follow position without remeasuring geometry after a scroll write', () => {
  const viewport = document.createElement('div')
  document.body.append(viewport)
  Object.defineProperties(viewport, {
    clientHeight: { value: 200 },
    scrollHeight: { value: 1200, configurable: true },
  })
  viewport.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
    viewport.scrollTop = Number(top)
  })
  const conversationKey = 'follow-save-without-layout'
  const current = renderHook(() =>
    useConversationScrollController({
      conversationKey,
      externalScrollRef: { current: viewport },
      messages: [
        {
          id: 'latest',
          role: 'assistant',
          content: 'Latest answer',
          status: 'done',
          createdAt: '2026-10-28T00:00:00.000Z',
        },
      ],
    })
  )
  let wroteOffset = false
  const measureAfterWrite = vi.fn()
  Object.defineProperty(viewport, 'scrollHeight', {
    get: () => {
      if (wroteOffset) measureAfterWrite()
      return 1400
    },
    configurable: true,
  })
  viewport.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
    viewport.scrollTop = Number(top)
    wroteOffset = true
  })

  act(() => current.result.current.handleContentLayoutChange())

  expect(wroteOffset).toBe(true)
  expect(measureAfterWrite).not.toHaveBeenCalled()
  expect(getConversationScrollSnapshot(conversationKey)).toEqual({
    pinnedToBottom: true,
    distanceFromBottomPx: 0,
  })
  expect(current.result.current.showScrollButton).toBe(false)
  current.unmount()
})

test.each(['follow', 'read'] as const)(
  'keeps the original %s snapshot while suspended search navigation uses the viewport',
  mode => {
    const viewport = document.createElement('div')
    document.body.append(viewport)
    Object.defineProperties(viewport, {
      clientHeight: { value: 200 },
      scrollHeight: { value: 1200 },
    })
    viewport.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      viewport.scrollTop = Number(top)
    })
    const props = {
      conversationKey: `search-restore-${mode}`,
      externalScrollRef: { current: viewport },
      messages: [
        {
          id: 'latest',
          role: 'assistant' as const,
          content: 'Latest answer',
          status: 'done' as const,
          createdAt: '2026-10-28T00:00:00.000Z',
        },
      ],
      autoScrollSuspended: false,
      initialScrollPosition: 'restore' as const,
    }
    const current = renderHook(props => useConversationScrollController(props), {
      initialProps: props,
    })
    if (mode === 'read') {
      fireEvent.wheel(viewport, { deltaY: -100 })
      viewport.scrollTop = 600
      fireEvent.scroll(viewport)
      fireEvent(viewport, new Event('scrollend'))
    }
    const originalTop = viewport.scrollTop
    const original = getConversationScrollSnapshot(props.conversationKey)
    expect(original?.pinnedToBottom).toBe(mode === 'follow')
    current.rerender({ ...props, autoScrollSuspended: true })
    act(() => {
      current.result.current.handleTurnNavigationScrollTargetChange('older')
      viewport.scrollTop = 0
      current.result.current.handleTurnNavigationScrollTargetChange(null)
    })
    expect(getConversationScrollSnapshot(props.conversationKey)).toEqual(original)

    current.rerender({
      ...props,
      conversationKey: `${props.conversationKey}:find`,
      autoScrollSuspended: true,
    })
    current.rerender(props)
    expect(viewport.scrollTop).toBe(originalTop)
    expect(getConversationScrollSnapshot(props.conversationKey)).toEqual(original)
    current.unmount()
  }
)
