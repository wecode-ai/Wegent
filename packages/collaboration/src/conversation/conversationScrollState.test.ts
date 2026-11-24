// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import {
  createConversationScrollState,
  type ConversationScrollInput,
} from './conversationScrollState'
import { cacheConversationScrollSnapshot, evictConversationViewport } from './conversationViewportCache'
import type { ConversationVirtualizer } from './useConversationVirtualizer'

afterEach(() => vi.unstubAllGlobals())

it('offers to jump to latest after restoring a reading position without a native scroll event', () => {
  const key = 'restore-reading'
  cacheConversationScrollSnapshot(key, { pinnedToBottom: false, distanceFromBottomPx: 600 })
  const viewport = document.createElement('div')
  Object.defineProperties(viewport, {
    clientHeight: { value: 400 },
    scrollHeight: { value: 1600 },
  })
  const input: ConversationScrollInput = {
    messages: [{ id: 'reply', role: 'assistant', content: 'Done', status: 'done', createdAt: '' }],
    scrollRef: { current: viewport },
  }
  const state = createConversationScrollState(key, input)
  const dispose = state.subscribe(() => {})
  state.update(input, {
    scrollRef: input.scrollRef,
    externalScrollInteractionRef: undefined,
    contentRef: { current: null },
    virtualizerRef: { current: null },
    owner: { lease: null },
  })
  expect(viewport.scrollTop).toBe(600)
  expect(state.getSnapshot().showScrollButton).toBe(true)
  dispose()
  evictConversationViewport(key)
})

it('follows the measured transcript end without scrolling into temporary Markdown overflow', () => {
  const viewport = document.createElement('div')
  const content = viewport.appendChild(document.createElement('div'))
  const disconnect = vi.fn()
  let notifyResize: () => void = () => {
    throw new Error('The scroll owner did not observe layout')
  }
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        notifyResize = callback
      }
      observe() {}
      disconnect = disconnect
    }
  )
  let scrollHeight = 1603
  let virtualSize = 1602
  Object.defineProperties(viewport, {
    clientHeight: { value: 643 },
    scrollHeight: { get: () => scrollHeight },
  })
  viewport.scrollTop = 960
  const range = { endIndex: 0 }
  const virtualizer = {
    options: { count: 2, scrollMargin: 1 },
    range,
    getTotalSize: () => virtualSize,
    cancelScroll: vi.fn(),
  } as unknown as ConversationVirtualizer
  const input: ConversationScrollInput = {
    messages: [
      {
        id: 'reply',
        role: 'assistant',
        content: 'Done',
        status: 'done',
        createdAt: '',
      },
    ],
    scrollRef: { current: viewport },
  }
  const state = createConversationScrollState(null, input)
  const ports = {
    scrollRef: input.scrollRef,
    externalScrollInteractionRef: undefined,
    contentRef: { current: null },
    virtualizerRef: { current: virtualizer },
    owner: { lease: null },
  }
  const dispose = state.subscribe(() => {})
  state.update(input, ports)
  const releaseContent = state.bindContent(content, ports)

  // An unmeasured overscan row temporarily contributes a tall Markdown placeholder.
  scrollHeight = 1691
  notifyResize()
  expect(viewport.scrollTop).toBe(960)

  // On reopen, the settled last row's Markdown expands before the cached size updates.
  range.endIndex = 1
  state.handleVirtualLayoutChange()
  expect(viewport.scrollTop).toBe(1048)
  virtualSize = 1690
  notifyResize()
  expect(viewport.scrollTop).toBe(1048)
  releaseContent()
  expect(disconnect).toHaveBeenCalledOnce()
  dispose()
})

it('retargets native follow on layout changes and ignores earlier scrollend events', () => {
  const requestFrame = vi.fn((_callback: FrameRequestCallback) => 1)
  vi.stubGlobal('requestAnimationFrame', requestFrame)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const viewport = document.createElement('div')
  let scrollHeight = 640
  const scrollTo = vi.fn(({ top, behavior }: ScrollToOptions) => {
    if (behavior !== 'smooth') viewport.scrollTop = top ?? 0
  })
  Object.defineProperties(viewport, {
    clientHeight: { value: 640 },
    scrollHeight: { get: () => scrollHeight },
    scrollTo: { value: scrollTo },
  })
  const message = {
    id: 'reply',
    role: 'assistant',
    content: 'Start',
    status: 'done',
    createdAt: '',
  } as const
  const input = { messages: [message], scrollRef: { current: viewport } }
  const ports = {
    scrollRef: input.scrollRef,
    externalScrollInteractionRef: undefined,
    contentRef: { current: null },
    virtualizerRef: { current: null },
    owner: { lease: null },
  }
  const state = createConversationScrollState(null, input)
  const notify = () => {}
  const dispose = state.subscribe(notify)
  state.update(input, ports)
  scrollHeight = 2000
  state.update(
    { ...input, messages: [{ ...message, content: 'Start and continue', status: 'streaming' }] },
    ports
  )
  state.handleContentLayoutChange()
  expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 1360, behavior: 'smooth' })
  expect(state.getSnapshot().virtualAnchorToEnd).toBe(false)

  scrollHeight += 100
  state.handleVirtualLayoutChange()
  requestFrame.mock.lastCall?.[0](32)
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 1460, behavior: 'smooth' })
  viewport.scrollTop = 1360
  state.endInput()
  expect(state.getSnapshot().showScrollButton).toBe(false)
  viewport.scrollTop = 1460
  state.endInput()
  expect(state.getSnapshot().showScrollButton).toBe(false)

  scrollHeight += 200
  state.handleContentLayoutChange()
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 1660, behavior: 'smooth' })
  state.markInput(new WheelEvent('wheel', { deltaY: -40 }))
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 1460, behavior: 'instant' })
  expect(state.getSnapshot().mode).toBe('read')
  dispose()
})
