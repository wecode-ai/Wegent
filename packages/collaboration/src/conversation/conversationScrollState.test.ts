// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import {
  createConversationScrollState,
  type ConversationScrollInput,
} from './conversationScrollState'
import {
  cacheConversationScrollSnapshot,
  evictConversationViewport,
  getConversationScrollSnapshot,
} from './conversationViewportCache'
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

it('seeks the saved Markdown placeholder after reopening and restores its text when rendered', () => {
  const key = 'restore-windowed-reader'
  const snapshot = {
    pinnedToBottom: false,
    distanceFromBottomPx: 600,
    anchor: {
      messageId: 'reply',
      itemId: 'message-item',
      chunkIndex: '3',
      anchorIndex: 0,
      text: 'Saved paragraph',
      textOffset: null,
      offsetFromScrollerTop: 12,
    },
  }
  cacheConversationScrollSnapshot(key, snapshot)
  const viewport = document.createElement('div')
  viewport.innerHTML = `
    <div data-message-id="reply">
      <div data-runtime-item-id="message-item">
        <div data-markdown-chunk-index="3">
          <div data-markdown-window-placeholder>Saved paragraph</div>
        </div>
      </div>
    </div>`
  Object.defineProperties(viewport, {
    clientHeight: { value: 400 },
    scrollHeight: { value: 3200 },
  })
  viewport.getBoundingClientRect = () => new DOMRect(0, 50, 600, 400)
  const chunk = viewport.querySelector<HTMLElement>('[data-markdown-chunk-index]')!
  chunk.getBoundingClientRect = () => new DOMRect(0, 50 + 1800 - viewport.scrollTop, 600, 800)
  const input: ConversationScrollInput = {
    messages: [
      {
        id: 'reply',
        role: 'assistant',
        content: snapshot.anchor.text,
        status: 'done',
        createdAt: '',
      },
    ],
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
  expect(viewport.scrollTop).toBe(1800)

  // The estimated placeholder cannot provide a semantic anchor yet. Native
  // scrollend must not replace the saved one with an unrelated visible position.
  state.endInput()
  expect(getConversationScrollSnapshot(key)).toEqual(snapshot)

  chunk.innerHTML = '<p data-scroll-anchor>Saved paragraph</p>'
  const paragraph = chunk.querySelector<HTMLElement>('[data-scroll-anchor]')!
  paragraph.getBoundingClientRect = () => new DOMRect(0, 50 + 1880 - viewport.scrollTop, 600, 24)
  state.handleVirtualLayoutChange()
  expect(viewport.scrollTop).toBe(1868)
  expect(paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top).toBe(12)
  state.endInput()
  expect(getConversationScrollSnapshot(key)).toEqual(snapshot)

  dispose()
  evictConversationViewport(key)
})

it.each(['done', 'streaming'] as const)('restores the visible %s tail in the same commit', status => {
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
        status,
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

  // On reopen, the last row's Markdown expands before the cached size updates.
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

it('restores the bottom immediately after width changes even while streaming', () => {
  let nextFrameId = 0
  const requestFrame = vi.fn((_callback: FrameRequestCallback) => ++nextFrameId)
  const cancelFrame = vi.fn()
  vi.stubGlobal('requestAnimationFrame', requestFrame)
  vi.stubGlobal('cancelAnimationFrame', cancelFrame)
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
      disconnect() {}
    }
  )
  const viewport = document.createElement('div')
  const content = viewport.appendChild(document.createElement('div'))
  let width = 736
  let scrollHeight = 640
  const scrollTo = vi.fn(({ top, behavior }: ScrollToOptions) => {
    if (behavior !== 'smooth') viewport.scrollTop = top ?? 0
  })
  Object.defineProperties(viewport, {
    clientWidth: { get: () => width },
    clientHeight: { value: 640 },
    scrollHeight: { get: () => scrollHeight },
    scrollTo: { value: scrollTo },
  })
  const message = {
    id: 'reply',
    role: 'assistant',
    content: 'Start',
    status: 'streaming',
    createdAt: '',
  } as const
  const input = { messages: [message], scrollRef: { current: viewport } }
  const ports = {
    scrollRef: input.scrollRef,
    externalScrollInteractionRef: undefined,
    contentRef: { current: content },
    virtualizerRef: { current: null },
    owner: { lease: null },
  }
  const state = createConversationScrollState(null, input)
  const dispose = state.subscribe(() => {})
  state.update(input, ports)
  const releaseContent = state.bindContent(content, ports)

  scrollHeight = 2000
  state.update({ ...input, messages: [{ ...message, content: 'Start and continue' }] }, ports)
  requestFrame.mock.lastCall?.[0](16)
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 1360, behavior: 'smooth' })

  // A native width observation can arrive before the virtual list finishes its
  // new row measurements. Cancel the old smooth target and its queued retarget.
  scrollHeight += 100
  notifyResize()
  const pendingFrameId = nextFrameId
  width = 420
  scrollHeight = 3200
  notifyResize()
  expect(cancelFrame).toHaveBeenCalledWith(pendingFrameId)
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 2560, behavior: 'instant' })
  expect(viewport.scrollTop).toBe(2560)

  // The completed geometry batch is authoritative even when its scroll viewport
  // width has already been observed.
  scrollHeight = 3400
  state.handleVirtualLayoutChange('resize')
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 2760, behavior: 'instant' })
  expect(viewport.scrollTop).toBe(2760)
  expect(state.getSnapshot().mode).toBe('follow')

  scrollHeight += 200
  state.update(
    {
      ...input,
      messages: [{ ...message, content: 'Start and continue again' }],
    },
    ports
  )
  requestFrame.mock.lastCall?.[0](32)
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 2960, behavior: 'smooth' })
  releaseContent()
  dispose()
})
