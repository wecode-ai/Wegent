import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import { useConversationScrollController } from '../../../../packages/collaboration/src/conversation/useConversationScrollController'
import {
  cacheConversationScrollSnapshot,
  clearConversationViewportCache,
} from '../../../../packages/collaboration/src/conversation/conversationViewportCache'

const message = (content = 'Existing streamed history'): WorkbenchMessage => ({
  id: 'response',
  role: 'assistant',
  content,
  status: 'streaming',
  createdAt: '',
})

const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0

beforeEach(() => {
  clearConversationViewportCache()
  frames.clear()
  nextFrame = 0
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
    frames.delete(id)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  clearConversationViewportCache()
})

function createViewport() {
  const viewport = document.createElement('div')
  const geometry = { height: 2400, viewportHeight: 600 }
  Object.defineProperties(viewport, {
    clientHeight: { get: () => geometry.viewportHeight },
    scrollHeight: { get: () => geometry.height },
  })
  viewport.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
    viewport.scrollTop = Math.max(
      0,
      Math.min(Number(top), geometry.height - geometry.viewportHeight)
    )
  })
  return { viewport, geometry, externalScrollRef: { current: viewport } }
}

function advanceFrame(now: number) {
  act(() => {
    const callbacks = [...frames.values()]
    frames.clear()
    callbacks.forEach(callback => callback(now))
  })
}

test('positions existing streaming history immediately, including later row measurements', () => {
  const { viewport, geometry, externalScrollRef } = createViewport()
  const messages = [message()]
  const hook = renderHook(() =>
    useConversationScrollController({
      messages,
      conversationKey: 'first-open',
      externalScrollRef,
    })
  )

  expect.soft(viewport.scrollTop).toBe(1800)
  expect.soft(frames.size).toBe(0)
  geometry.height = 7400
  act(() => hook.result.current.handleContentLayoutChange())
  expect(viewport.scrollTop).toBe(6800)
  expect(frames.size).toBe(0)
})

test('prefetching older history on a short initial page retains following', () => {
  const { viewport, geometry, externalScrollRef } = createViewport()
  geometry.height = 600
  const messages = [message()]
  const hook = renderHook(() =>
    useConversationScrollController({
      messages,
      conversationKey: 'short-history-prefetch',
      externalScrollRef,
    })
  )
  act(() => hook.result.current.prepareForHistoryPrepend())
  geometry.height = 2400
  act(() => hook.result.current.handleContentLayoutChange())
  expect(viewport.scrollTop).toBe(1800)
  expect(hook.result.current.virtualAnchorToEnd).toBe(false)
})

test('switches to a running conversation at its bottom before any animation frame', () => {
  const { viewport, geometry, externalScrollRef } = createViewport()
  const hook = renderHook(
    props => useConversationScrollController({ ...props, externalScrollRef }),
    {
      initialProps: {
        conversationKey: 'completed',
        messages: [{ ...message(), status: 'done' as WorkbenchMessage['status'] }],
      },
    }
  )
  geometry.height = 12400
  hook.rerender({ conversationKey: 'running', messages: [message()] })

  expect(viewport.scrollTop).toBe(11800)
  expect(frames.size).toBe(0)
})

test('does not treat an equivalent message projection as new streamed content', () => {
  const { viewport, geometry, externalScrollRef } = createViewport()
  const hook = renderHook(
    props =>
      useConversationScrollController({
        ...props,
        externalScrollRef,
        conversationKey: 'same-history',
      }),
    { initialProps: { messages: [message()] } }
  )
  hook.rerender({ messages: [message()] })
  geometry.height = 7400
  act(() => hook.result.current.handleContentLayoutChange())

  expect(viewport.scrollTop).toBe(6800)
  expect(frames.size).toBe(0)
})

test('positions asynchronously loaded history without treating hydration as streamed growth', () => {
  const { viewport, geometry, externalScrollRef } = createViewport()
  geometry.height = 600
  const hook = renderHook(
    props =>
      useConversationScrollController({
        ...props,
        externalScrollRef,
        conversationKey: 'loading',
      }),
    { initialProps: { messages: [] as WorkbenchMessage[], loading: true } }
  )
  geometry.height = 4400
  hook.rerender({ messages: [message('Partial history')], loading: true })
  expect.soft(viewport.scrollTop).toBe(3800)
  geometry.height = 8400
  hook.rerender({ messages: [message('Full history')], loading: true })
  expect.soft(viewport.scrollTop).toBe(7800)
  geometry.height = 9400
  hook.rerender({ messages: [message('Full history')], loading: false })
  expect(viewport.scrollTop).toBe(8800)
  expect(frames.size).toBe(0)
})

test('preserves an explicitly saved reading position in a running conversation', () => {
  const { viewport, geometry, externalScrollRef } = createViewport()
  cacheConversationScrollSnapshot('reader', { pinnedToBottom: false, distanceFromBottomPx: 800 })
  const hook = renderHook(() =>
    useConversationScrollController({
      messages: [message()],
      externalScrollRef,
      conversationKey: 'reader',
    })
  )

  expect(viewport.scrollTop).toBe(1000)
  geometry.height = 4400
  act(() => hook.result.current.handleContentLayoutChange())
  expect(viewport.scrollTop).toBe(3000)
  expect(frames.size).toBe(0)
})

test('resumes a hidden running pane at its latest position without replaying background growth', () => {
  const { viewport, geometry, externalScrollRef } = createViewport()
  const hook = renderHook(
    props =>
      useConversationScrollController({
        ...props,
        externalScrollRef,
        conversationKey: 'hidden-running-pane',
      }),
    { initialProps: { messages: [message()], autoScrollSuspended: false } }
  )
  viewport.scrollTop = 1800
  hook.rerender({ messages: [message()], autoScrollSuspended: true })
  geometry.height = 8400
  hook.rerender({ messages: [message('New background tokens')], autoScrollSuspended: true })
  expect(viewport.scrollTop).toBe(1800)
  hook.rerender({ messages: [message('New background tokens')], autoScrollSuspended: false })

  expect(viewport.scrollTop).toBe(7800)
  expect(frames.size).toBe(0)
})

test('suspending an active pane cancels its in-flight streaming animation', () => {
  const { viewport, geometry, externalScrollRef } = createViewport()
  const hook = renderHook(
    props =>
      useConversationScrollController({
        ...props,
        externalScrollRef,
        conversationKey: 'suspended-motion',
      }),
    { initialProps: { messages: [message()], autoScrollSuspended: false } }
  )
  viewport.scrollTop = 1800
  geometry.height = 3400
  const messages = [message('New foreground tokens')]
  hook.rerender({ messages, autoScrollSuspended: false })
  expect(frames.size).toBe(1)
  hook.rerender({ messages, autoScrollSuspended: true })
  expect(frames.size).toBe(0)
})

test('animates new streamed content and cancels that motion when switching conversations', () => {
  const { viewport, geometry, externalScrollRef } = createViewport()
  const hook = renderHook(
    props => useConversationScrollController({ ...props, externalScrollRef }),
    { initialProps: { messages: [message()], conversationKey: 'active' } }
  )
  // Establish the already-visible end independently of the initial-position assertion above.
  viewport.scrollTop = 1800
  geometry.height = 3400
  hook.rerender({
    messages: [message('Existing history plus new tokens')],
    conversationKey: 'active',
  })
  expect(viewport.scrollTop).toBe(1800)
  expect(frames.size).toBe(1)
  advanceFrame(16)
  expect(viewport.scrollTop).toBeGreaterThan(1800)
  expect(viewport.scrollTop).toBeLessThan(2800)

  geometry.height = 6400
  hook.rerender({ messages: [message('Other running history')], conversationKey: 'other' })
  expect(viewport.scrollTop).toBe(5800)
  expect(frames.size).toBe(0)
  advanceFrame(32)
  expect(viewport.scrollTop).toBe(5800)
})
