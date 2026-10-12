// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  getConversationDiagnosticContext,
  getConversationDiagnosticScroller,
  getConversationDiagnosticWheelInput,
  getConversationDiagnosticsSnapshot,
  isConversationDiagnosticsEnabled,
  recordConversationDiagnostic,
  recordConversationScrollDiagnostic,
  resetConversationDiagnosticsForTest,
  startConversationDiagnosticCapture,
} from './conversationDiagnostics'

describe('conversation diagnostics', () => {
  beforeEach(() => resetConversationDiagnosticsForTest())
  afterEach(() => vi.restoreAllMocks())

  test('records only around reader interaction and extends capture on new input', () => {
    let now = 100
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    recordConversationDiagnostic('scroll-position', { scrollTop: 10 })
    expect(getConversationDiagnosticsSnapshot()).toBeNull()

    startConversationDiagnosticCapture()
    now += 9_000
    recordConversationDiagnostic('scroll-position', { scrollTop: 20 })
    startConversationDiagnosticCapture()
    now += 9_000
    expect(isConversationDiagnosticsEnabled()).toBe(true)
    recordConversationDiagnostic('scroll-position', { scrollTop: 30 })
    now += 1_001
    expect(isConversationDiagnosticsEnabled()).toBe(false)
    recordConversationDiagnostic('scroll-position', { scrollTop: 40 })
    expect(
      getConversationDiagnosticsSnapshot()?.events.map(event => event.details.scrollTop)
    ).toEqual([20, 30])
  })

  test('retains bounded chronological events and returns independent snapshots', () => {
    startConversationDiagnosticCapture()
    for (let index = 0; index < 425; index++) {
      recordConversationDiagnostic('virtual-measurement', { rowIndex: index })
    }
    const snapshot = getConversationDiagnosticsSnapshot()!
    expect(snapshot.events).toHaveLength(400)
    expect(snapshot.droppedEventCount).toBe(25)
    expect(snapshot.events[0].sequence).toBe(26)
    expect(snapshot.events[399].details.rowIndex).toBe(424)
    snapshot.events[0].details.rowIndex = -99
    expect(getConversationDiagnosticsSnapshot()?.events[0].details.rowIndex).toBe(25)
  })

  test('keeps latest wheel direction per viewport without accumulating duplicate input', () => {
    let now = 100
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const first = document.createElement('div')
    const second = document.createElement('div')
    expect(getConversationDiagnosticWheelInput(first)).toEqual({
      lastWheelDeltaY: null,
      lastWheelAgeMs: null,
    })
    startConversationDiagnosticCapture()
    recordConversationScrollDiagnostic('scroll-input', first, { deltaY: -82 })
    recordConversationScrollDiagnostic('scroll-input', first, { deltaY: -82 })
    recordConversationScrollDiagnostic('scroll-input', second, { deltaY: 56 })
    now += 16
    recordConversationScrollDiagnostic('scroll-position', first, {
      deltaY: 900,
    })
    recordConversationScrollDiagnostic('scroll-input', first, { deltaY: NaN })
    expect(getConversationDiagnosticWheelInput(first)).toEqual({
      lastWheelDeltaY: -82,
      lastWheelAgeMs: 16,
    })
    expect(getConversationDiagnosticWheelInput(second).lastWheelDeltaY).toBe(56)
    resetConversationDiagnosticsForTest()
    expect(getConversationDiagnosticWheelInput(first).lastWheelDeltaY).toBeNull()
  })

  test('never retains message content, paths, identifiers, or non-finite values', () => {
    startConversationDiagnosticCapture()
    recordConversationDiagnostic('markdown-layout', {
      content: 'private transcript',
      path: '/private/workspace',
      messageId: 'private-message-id',
      scrollerId: 1,
      height: 123.456,
      rendered: true,
      retainedHeight: null,
      width: Infinity,
      contentLength: 'private transcript',
      rowIndex: NaN,
    })
    expect(getConversationDiagnosticsSnapshot()?.events[0].details).toEqual({
      scrollerId: 1,
      height: 123.46,
      rendered: true,
      retainedHeight: null,
    })
  })

  test('correlates externally scrolled rows, Markdown, and anchors with their visible viewport', () => {
    const viewport = document.createElement('div')
    viewport.dataset.scrollOrigin = 'bottom'
    viewport.className = 'overflow-y-auto'
    viewport.innerHTML =
      '<div data-scroll-origin="bottom" class="overflow-visible"><article data-index="7"><div data-markdown-window-chunk><p data-scroll-anchor>Private text</p></div></article></div>'
    const inner = viewport.firstElementChild!
    const row = inner.firstElementChild!
    const chunk = row.firstElementChild!
    const anchor = chunk.firstElementChild!
    const viewportContext = getConversationDiagnosticContext(viewport)

    expect(getConversationDiagnosticScroller(chunk)).toBe(viewport)
    expect(getConversationDiagnosticContext(inner).scrollerId).toBe(viewportContext.scrollerId)
    for (const element of [row, chunk, anchor]) {
      expect(getConversationDiagnosticContext(element)).toEqual({
        scrollerId: viewportContext.scrollerId,
        rowIndex: 7,
      })
    }
    const otherViewport = document.createElement('div')
    otherViewport.dataset.scrollOrigin = 'bottom'
    expect(getConversationDiagnosticContext(otherViewport).scrollerId).not.toBe(
      viewportContext.scrollerId
    )
  })

  test('keeps an independent nested scrolling viewport distinct from its outer viewport', () => {
    const outer = document.createElement('div')
    outer.dataset.scrollOrigin = 'bottom'
    outer.innerHTML =
      '<div data-scroll-origin="top" class="overflow-y-auto"><article data-index="3"><p>Text</p></article></div>'
    const inner = outer.firstElementChild!
    const paragraph = inner.querySelector('p')!

    expect(getConversationDiagnosticScroller(paragraph)).toBe(inner)
    expect(getConversationDiagnosticContext(paragraph)).toEqual({
      scrollerId: getConversationDiagnosticContext(inner).scrollerId,
      rowIndex: 3,
    })
    expect(getConversationDiagnosticContext(inner).scrollerId).not.toBe(
      getConversationDiagnosticContext(outer).scrollerId
    )
  })

  test('recognizes inline visible overflow and respects an independent inline scroll override', () => {
    const outer = document.createElement('div')
    outer.dataset.scrollOrigin = 'bottom'
    outer.innerHTML =
      '<div data-scroll-origin="bottom" style="overflow-y: visible"><p>Text</p></div>'
    const inner = outer.firstElementChild as HTMLElement
    const paragraph = inner.firstElementChild!

    expect(getConversationDiagnosticScroller(paragraph)).toBe(outer)
    inner.className = 'overflow-visible'
    inner.style.overflowY = 'auto'
    expect(getConversationDiagnosticScroller(paragraph)).toBe(inner)
  })

  test('resolves diagnostic ownership without computed styles or layout reads', () => {
    const viewport = document.createElement('div')
    viewport.dataset.scrollOrigin = 'bottom'
    viewport.innerHTML =
      '<div data-scroll-origin="bottom" class="overflow-y-visible"><p>Text</p></div>'
    const paragraph = viewport.querySelector('p')!
    const computedStyle = vi.spyOn(window, 'getComputedStyle')
    const layoutRead = vi.spyOn(viewport, 'getBoundingClientRect')

    expect(getConversationDiagnosticScroller(paragraph)).toBe(viewport)
    expect(getConversationDiagnosticContext(paragraph).scrollerId).toBeGreaterThan(0)
    expect(computedStyle).not.toHaveBeenCalled()
    expect(layoutRead).not.toHaveBeenCalled()
    expect(getConversationDiagnosticScroller(null)).toBeNull()
    expect(getConversationDiagnosticContext(null)).toEqual({
      scrollerId: 0,
      rowIndex: -1,
    })
  })
})
