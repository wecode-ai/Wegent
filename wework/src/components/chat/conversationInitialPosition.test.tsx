import { act, cleanup, renderHook } from '@testing-library/react'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { clearConversationViewportCache } from '../../../../packages/collaboration/src/conversation/conversationViewportCache'
import { useConversationScrollController } from '../../../../packages/collaboration/src/conversation/useConversationScrollController'

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

test('restoring unchanged streaming history follows footer resizing before paint', () => {
  const { viewport, geometry, externalScrollRef } = createViewport()
  const hook = renderHook(() =>
    useConversationScrollController({
      messages: [message()],
      externalScrollRef,
      conversationKey: 'restored-stream-footer',
    })
  )
  geometry.height += 22

  act(() => hook.result.current.handleVirtualLayoutChange())

  expect(viewport.scrollTop).toBe(geometry.height - geometry.viewportHeight)
  expect(frames.size).toBe(0)
})

test('prepending older history keeps unchanged live text in immediate restore mode', () => {
  const { viewport, geometry, externalScrollRef } = createViewport()
  const active = message()
  const hook = renderHook(
    messages =>
      useConversationScrollController({
        messages,
        externalScrollRef,
        conversationKey: 'restore-history-prepend',
      }),
    { initialProps: [active] }
  )
  geometry.height += 1000

  hook.rerender([{ ...message('Older history'), id: 'older', status: 'done' }, active])

  expect(viewport.scrollTop).toBe(geometry.height - geometry.viewportHeight)
  expect(frames.size).toBe(0)
})
