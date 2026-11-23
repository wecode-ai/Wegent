// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import {
  createConversationScrollState,
  type ConversationScrollInput,
} from './conversationScrollState'
import type { ConversationVirtualizer } from './useConversationVirtualizer'

afterEach(() => vi.unstubAllGlobals())

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
  const virtualizer = {
    options: { scrollMargin: 1 },
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
  const dispose = state.subscribe(() => {}, input, ports)
  const releaseContent = state.bindContent(content, ports)

  // An unmeasured overscan row temporarily contributes a tall Markdown placeholder.
  scrollHeight = 1691
  notifyResize()
  expect(viewport.scrollTop).toBe(960)

  // Real content becomes scrollable when its DOM range and virtual size catch up.
  virtualSize = 1622
  scrollHeight = 1623
  notifyResize()
  expect(viewport.scrollTop).toBe(980)
  releaseContent()
  expect(disconnect).toHaveBeenCalledOnce()
  dispose()
})

it('keeps the scroll button hidden during controller-owned follow steps', () => {
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1)
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  const viewport = document.createElement('div')
  let scrollHeight = 640
  Object.defineProperties(viewport, {
    clientHeight: { value: 640 },
    scrollHeight: { get: () => scrollHeight },
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
  const dispose = state.subscribe(notify, input, ports)
  scrollHeight = 2000
  const releaseStream = state.subscribe(
    notify,
    { ...input, messages: [{ ...message, content: 'Start and continue', status: 'streaming' }] },
    ports
  )
  state.handleContentLayoutChange()
  expect(state.getSnapshot().motionActive).toBe(true)
  state.endInput()
  expect(state.getSnapshot().showScrollButton).toBe(false)
  releaseStream()
  dispose()
})
