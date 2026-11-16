import { act, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useConversationScrollController } from '../../../../packages/collaboration/src/conversation/useConversationScrollController'
import { getConversationScrollSnapshot } from '@/features/workbench/runtimeConversationCache'

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
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
