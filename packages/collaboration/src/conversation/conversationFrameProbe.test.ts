// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  getConversationDiagnosticsSnapshot,
  recordConversationScrollDiagnostic,
  resetConversationDiagnosticsForTest,
  startConversationDiagnosticCapture,
} from './conversationDiagnostics'
import {
  setConversationFrameProbeEnabled,
  startConversationFrameProbe,
  stopConversationFrameProbe,
  type ConversationFrameProbeState,
} from './conversationFrameProbe'
import { getTextOffsetRect } from './conversationScrollGeometry'

vi.mock('./conversationScrollGeometry', () => ({ getTextOffsetRect: vi.fn() }))

let now = 100
let nextFrameId = 1
let frames: Map<number, FrameRequestCallback>

function frame() {
  const pending = [...frames.values()]
  frames.clear()
  for (const callback of pending) callback(now)
}

function reader() {
  const scroller = document.createElement('div')
  scroller.dataset.scrollOrigin = 'top'
  scroller.innerHTML =
    '<article data-index="8" data-message-id="private-message"><p>private transcript</p></article>'
  const element = scroller.querySelector('p')!
  document.body.append(scroller)
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 600 },
    clientWidth: { configurable: true, value: 700 },
    scrollHeight: { configurable: true, value: 2_000 },
    scrollTop: { configurable: true, writable: true, value: 200 },
  })
  let top = 120
  const viewportRect = vi
    .spyOn(scroller, 'getBoundingClientRect')
    .mockImplementation(() => new DOMRect(0, 100, 700, 600))
  const anchorRect = vi
    .spyOn(element, 'getBoundingClientRect')
    .mockImplementation(() => new DOMRect(0, top, 700, 24))
  const state: ConversationFrameProbeState = {
    anchor: {
      messageId: 'private-message',
      element,
      anchorIndex: 3,
      textOffset: null,
      offsetFromScrollerTop: 20,
      scrollTopPx: 200,
    },
    userSelfOffset: 0,
    bottomOrigin: false,
  }
  const readState = vi.fn(() => state)
  return {
    scroller,
    element,
    state,
    readState,
    viewportRect,
    anchorRect,
    setTop: (value: number) => {
      top = value
    },
  }
}

function latest() {
  return getConversationDiagnosticsSnapshot()!
    .events.filter(event => event.name === 'anchor-frame')
    .at(-1)!
}

describe('opt-in conversation frame probe', () => {
  beforeEach(() => {
    now = 100
    nextFrameId = 1
    frames = new Map()
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        const id = nextFrameId++
        frames.set(id, callback)
        return id
      })
    )
    vi.stubGlobal(
      'cancelAnimationFrame',
      vi.fn((id: number) => frames.delete(id))
    )
    setConversationFrameProbeEnabled(false)
    resetConversationDiagnosticsForTest()
    vi.mocked(getTextOffsetRect).mockReturnValue(null)
  })

  afterEach(() => {
    setConversationFrameProbeEnabled(false)
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  test('does no scheduling, state reads, or geometry reads until explicitly enabled and input is active', () => {
    const current = reader()
    startConversationDiagnosticCapture()
    startConversationFrameProbe(current.scroller, current.readState)
    expect(requestAnimationFrame).not.toHaveBeenCalled()
    expect(current.readState).not.toHaveBeenCalled()
    expect(current.viewportRect).not.toHaveBeenCalled()
    expect(current.anchorRect).not.toHaveBeenCalled()

    resetConversationDiagnosticsForTest()
    setConversationFrameProbeEnabled(true)
    startConversationFrameProbe(current.scroller, current.readState)
    expect(requestAnimationFrame).not.toHaveBeenCalled()
    expect(getConversationDiagnosticsSnapshot()).toBeNull()
  })

  test('captures actual node, text geometry, expected offset, and numeric metadata without mutating reader state', () => {
    const current = reader()
    current.state.anchor!.textOffset = 4
    current.state.userSelfOffset = 10
    current.scroller.scrollTop = 230
    vi.mocked(getTextOffsetRect).mockReturnValue(new DOMRect(0, 103, 9, 24))
    const original = structuredClone({
      ...current.state,
      anchor: { ...current.state.anchor, element: null },
    })
    setConversationFrameProbeEnabled(true)
    startConversationDiagnosticCapture()
    recordConversationScrollDiagnostic('scroll-input', current.scroller, {
      deltaY: -82,
    })
    now += 16
    startConversationFrameProbe(current.scroller, current.readState)
    frame()

    expect(latest().details).toMatchObject({
      rowIndex: 8,
      connected: true,
      textOffset: 4,
      textRectFound: true,
      anchorOffset: 3,
      sampledAnchorOffset: 20,
      sampledScrollTop: 200,
      selfScrollOffset: 10,
      readerScrollTop: 20,
      expectedAnchorOffset: 0,
      frameShift: 3,
      scrollTop: 230,
      scrollHeight: 2_000,
      scrollerTop: 100,
      scrollerHeight: 600,
      lastWheelDeltaY: -82,
      lastWheelAgeMs: 16,
    })
    expect(latest().details.anchorNodeId).toBeGreaterThan(0)
    expect(latest().timestampUnixMs).toBeGreaterThan(0)
    expect(
      Object.values(latest().details).every(
        value =>
          value === null ||
          typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value))
      )
    ).toBe(true)
    expect(JSON.stringify(getConversationDiagnosticsSnapshot())).not.toMatch(
      /private|messageId|transcript|element/
    )
    expect({
      ...current.state,
      anchor: { ...current.state.anchor, element: null },
    }).toEqual(original)
    expect(current.scroller.scrollTop).toBe(230)
    expect(current.viewportRect).toHaveBeenCalledTimes(1)
  })

  test('uses one loop and transfers it to the latest reader without obsolete cleanup stopping it', () => {
    const first = reader()
    const second = reader()
    setConversationFrameProbeEnabled(true)
    startConversationDiagnosticCapture()
    startConversationFrameProbe(first.scroller, first.readState)
    startConversationFrameProbe(first.scroller, first.readState)
    startConversationFrameProbe(second.scroller, second.readState)
    stopConversationFrameProbe(first.readState)
    expect(frames.size).toBe(1)
    frame()
    expect(first.readState).not.toHaveBeenCalled()
    expect(second.readState).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(1)
    stopConversationFrameProbe(second.readState)
    expect(frames.size).toBe(0)
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1)
  })

  test('stops at the input deadline without reading expired geometry or renewing capture', () => {
    const current = reader()
    setConversationFrameProbeEnabled(true)
    startConversationDiagnosticCapture()
    startConversationFrameProbe(current.scroller, current.readState)
    now = 10_099
    frame()
    expect(current.readState).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(1)
    now = 10_100
    frame()
    expect(current.readState).toHaveBeenCalledTimes(1)
    expect(current.viewportRect).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(0)

    startConversationDiagnosticCapture()
    startConversationFrameProbe(current.scroller, current.readState)
    frame()
    expect(current.readState).toHaveBeenCalledTimes(2)
  })

  test('new reader input extends the existing single loop, while disabling cancels it', () => {
    const current = reader()
    setConversationFrameProbeEnabled(true)
    startConversationDiagnosticCapture()
    startConversationFrameProbe(current.scroller, current.readState)
    now = 9_100
    frame()
    startConversationDiagnosticCapture()
    startConversationFrameProbe(current.scroller, current.readState)
    now = 18_100
    frame()
    expect(current.readState).toHaveBeenCalledTimes(2)
    expect(frames.size).toBe(1)
    setConversationFrameProbeEnabled(false)
    expect(frames.size).toBe(0)
  })

  test('remeasures the previous exact character when capture advances to another line of the same node', () => {
    const current = reader()
    current.state.anchor!.textOffset = 4
    let layoutShift = 0
    vi.mocked(getTextOffsetRect).mockImplementation(
      (_element, offset) => new DOMRect(0, (offset === 4 ? 120 : 144) + layoutShift, 9, 24)
    )
    setConversationFrameProbeEnabled(true)
    startConversationDiagnosticCapture()
    startConversationFrameProbe(current.scroller, current.readState)
    frame()
    current.state.anchor = {
      ...current.state.anchor!,
      textOffset: 12,
      offsetFromScrollerTop: 44,
    }
    frame()
    expect(latest().details).toMatchObject({
      textOffset: 12,
      trackedTextOffset: 4,
      samePoint: false,
      frameShift: 0,
      frameLayoutShift: 0,
    })

    layoutShift = 5
    current.state.anchor = {
      ...current.state.anchor!,
      offsetFromScrollerTop: 49,
    }
    frame()
    expect(latest().details).toMatchObject({
      frameShift: 0,
      trackedTextOffset: 12,
      frameLayoutShift: 5,
    })
  })

  test('cancels ordinary reader motion and keeps detached-node identity separate from its replacement', () => {
    const current = reader()
    setConversationFrameProbeEnabled(true)
    startConversationDiagnosticCapture()
    startConversationFrameProbe(current.scroller, current.readState)
    frame()
    const originalId = latest().details.anchorNodeId
    current.scroller.scrollTop += 30
    current.setTop(90)
    frame()
    expect(latest().details).toMatchObject({
      frameShift: 0,
      frameLayoutShift: 0,
      frameScrollTopDelta: 30,
    })

    current.element.remove()
    const replacement = document.createElement('p')
    current.scroller.querySelector('article')!.append(replacement)
    replacement.getBoundingClientRect = () => new DOMRect(0, 144, 700, 24)
    current.state.anchor = {
      ...current.state.anchor!,
      element: replacement,
      offsetFromScrollerTop: 44,
      scrollTopPx: 230,
    }
    frame()
    expect(latest().details).toMatchObject({
      connected: true,
      trackedConnected: false,
      trackedNodeId: originalId,
      frameLayoutShift: null,
    })
    expect(latest().details.anchorNodeId).not.toBe(originalId)
  })

  test('reports a lost anchor without measuring it and stops when the viewport unmounts', () => {
    const current = reader()
    current.element.remove()
    setConversationFrameProbeEnabled(true)
    startConversationDiagnosticCapture()
    startConversationFrameProbe(current.scroller, current.readState)
    frame()
    expect(latest().details).toMatchObject({
      connected: false,
      anchorOffset: null,
      frameShift: null,
    })
    expect(current.anchorRect).not.toHaveBeenCalled()
    current.scroller.remove()
    frame()
    expect(frames.size).toBe(0)
    expect(current.viewportRect).toHaveBeenCalledTimes(1)
  })

  test('computes bottom-origin range clamping as observation without adopting it into controller state', () => {
    const current = reader()
    current.state.bottomOrigin = true
    current.state.anchor!.scrollTopPx = -1_600
    current.scroller.scrollTop = -1_400
    setConversationFrameProbeEnabled(true)
    startConversationDiagnosticCapture()
    startConversationFrameProbe(current.scroller, current.readState)
    frame()
    expect(latest().details).toMatchObject({
      rangeClampOffset: 200,
      readerScrollTop: 0,
      frameShift: 0,
      bottomOrigin: true,
    })
    expect(current.state.userSelfOffset).toBe(0)
    expect(current.state.anchor!.scrollTopPx).toBe(-1_600)
  })

  test('keeps the existing 400-event ring bounded during frame capture', () => {
    const current = reader()
    setConversationFrameProbeEnabled(true)
    startConversationDiagnosticCapture()
    startConversationFrameProbe(current.scroller, current.readState)
    for (let index = 0; index < 425; index++) frame()
    const snapshot = getConversationDiagnosticsSnapshot()!
    expect(snapshot.events).toHaveLength(400)
    expect(snapshot.droppedEventCount).toBe(25)
    expect(snapshot.events[0].sequence).toBe(26)
  })
})
