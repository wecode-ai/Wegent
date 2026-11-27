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
import { createMarkdownWindowingScope } from '../markdown/MarkdownWindowingScope'
import { createMessageListViewportPort } from './messageListViewportPort'
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

it.each(['message-item', null] as const)('restores same-height anchor for %s', itemId => {
  const key = 'restore-windowed-reader'
  const snapshot = {
    pinnedToBottom: false,
    distanceFromBottomPx: 600,
    anchor: {
      messageId: 'reply',
      itemId,
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
    <div data-message-row data-index="0">
      <div data-message-id="reply">
        <div data-runtime-item-id="message-item">
          <div data-markdown-chunk-index="2"><p data-scroll-anchor>Other paragraph</p></div>
          <div data-markdown-chunk-index="3">
            <div data-markdown-window-placeholder>Saved paragraph</div>
          </div>
        </div>
        <div data-runtime-item-id="other-item">
          <div data-markdown-chunk-index="3"><p data-scroll-anchor>Other item</p></div>
        </div>
      </div>
    </div>`
  Object.defineProperties(viewport, {
    clientHeight: { value: 400 },
    scrollHeight: { value: 3200 },
  })
  const readViewport = vi.fn(() => new DOMRect(0, 50, 600, 400))
  viewport.getBoundingClientRect = readViewport
  const chunk = viewport.querySelector<HTMLElement>(
    '[data-runtime-item-id="message-item"] [data-markdown-chunk-index="3"]'
  )!
  const precedingChunk = viewport.querySelector<HTMLElement>('[data-markdown-chunk-index="2"]')!
  const otherItemChunk = viewport.querySelector<HTMLElement>(
    '[data-runtime-item-id="other-item"] [data-markdown-chunk-index="3"]'
  )!
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

  const port = createMessageListViewportPort()
  const scope = createMarkdownWindowingScope(input.scrollRef, (element, materialized) =>
    port.chunkLayout(scope, element, materialized)
  )
  const onLayoutChange = vi.fn(state.handleVirtualLayoutChange)
  const release = port.attach(viewport)
  try {
    port.update({
      scope,
      virtual: true,
      ready: true,
      layoutKey: 'layout',
      layoutWidth: 600,
      layoutPropertiesKey: 'properties',
      measurementKey: null,
      measurementLayout: { key: 'layout', messages: new Map() },
      virtualizer: { options: { enabled: true } } as ConversationVirtualizer,
      rows: [{ key: 'reply', index: 0, start: 0, end: 3200, size: 3200, lane: 0 }],
      totalSize: 3200,
      scrollElementRef: input.scrollRef,
      measureRow: vi.fn(),
      measureRows: vi.fn(),
      onLayoutChange,
    })
    // An earlier Markdown commit already reconciled this native scroll height.
    scope.onChunkLayout(precedingChunk)
    expect(viewport.scrollTop).toBe(1800)
    // The placeholder cannot provide a semantic anchor yet. Native scrollend
    // must not replace the saved one with an unrelated visible position.
    state.endInput()
    expect(getConversationScrollSnapshot(key)).toEqual(snapshot)

    // A queued materialization that is no longer rendered must not be replayed.
    onLayoutChange.mockClear()
    scope.onChunkLayout(chunk, true)
    expect(onLayoutChange).not.toHaveBeenCalled()

    chunk.innerHTML = '<p data-scroll-anchor>Saved paragraph</p>'
    const paragraph = chunk.querySelector<HTMLElement>('[data-scroll-anchor]')!
    paragraph.getBoundingClientRect = () => new DOMRect(0, 50 + 1880 - viewport.scrollTop, 600, 24)
    // Materialization of a different chunk cannot own this reading anchor.
    readViewport.mockClear()
    scope.onChunkLayout(precedingChunk, true)
    scope.onChunkLayout(otherItemChunk, true)
    expect(viewport.scrollTop).toBe(1800)
    expect(readViewport).not.toHaveBeenCalled()
    scope.onChunkLayout(chunk, true)
    expect(viewport.scrollHeight).toBe(3200)
    expect(viewport.scrollTop).toBe(1868)
    expect(paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top).toBe(12)
    state.endInput()
    expect(getConversationScrollSnapshot(key)).toEqual(snapshot)

    onLayoutChange.mockClear()
    // Ordinary same-height chunks still use the range deduplication.
    scope.onChunkLayout(chunk)
    expect(onLayoutChange).not.toHaveBeenCalled()
  } finally {
    release()
    dispose()
    evictConversationViewport(key)
  }
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
  const readScrollHeight = vi.fn(() => scrollHeight)
  Object.defineProperties(viewport, {
    clientHeight: { value: 643 },
    scrollHeight: { get: readScrollHeight },
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
  readScrollHeight.mockClear()
  state.handleVirtualLayoutChange({ materializedChunk: content })
  expect(readScrollHeight).not.toHaveBeenCalled()
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
  const previousFrameCount = requestFrame.mock.calls.length
  state.update(
    {
      ...input,
      messages: [{ ...message, content: 'Start and continue again' }],
    },
    ports
  )
  expect(requestFrame).toHaveBeenCalledTimes(previousFrameCount + 1)
  requestFrame.mock.calls[previousFrameCount][0](32)
  expect(scrollTo).toHaveBeenLastCalledWith({ top: 2960, behavior: 'smooth' })
  releaseContent()
  dispose()
})
