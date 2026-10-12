import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  getConversationDiagnosticsSnapshot,
  resetConversationDiagnosticsForTest,
  startConversationDiagnosticCapture,
} from '../../../../packages/collaboration/src/conversation/conversationDiagnostics'
import {
  CONVERSATION_SCROLL_WRITE_SOURCE,
  recordConversationScrollWrite,
} from '../../../../packages/collaboration/src/conversation/conversationScrollWrite'

function createScroller() {
  const element = document.createElement('div')
  element.dataset.scrollOrigin = 'bottom'
  element.innerHTML =
    '<article data-message-id="private-message"><p>Private transcript</p></article>'
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 791 },
    clientWidth: { configurable: true, value: 1200 },
    scrollHeight: { configurable: true, value: 26656 },
    scrollTop: { configurable: true, writable: true, value: -320 },
  })
  return element
}

describe('conversation scroll write diagnostics', () => {
  beforeEach(() => resetConversationDiagnosticsForTest())
  afterEach(() => vi.restoreAllMocks())

  test('invokes the write once without additional reads or metadata evaluation when disabled', () => {
    const element = createScroller()
    for (const property of ['scrollTop', 'scrollHeight', 'clientHeight', 'clientWidth']) {
      Object.defineProperty(element, property, {
        configurable: true,
        get: () => {
          throw new Error('Unexpected diagnostic read')
        },
      })
    }
    const write = vi.fn(() => 42)
    const details = vi.fn(() => ({ totalSize: 26410 }))

    expect(
      recordConversationScrollWrite(
        element,
        CONVERSATION_SCROLL_WRITE_SOURCE.virtualizerOffset,
        -200,
        write,
        details
      )
    ).toBe(42)

    expect(write).toHaveBeenCalledOnce()
    expect(details).not.toHaveBeenCalled()
    expect(getConversationDiagnosticsSnapshot()).toBeNull()
  })

  test('records the actual applied offset and only numeric or boolean details', () => {
    startConversationDiagnosticCapture()
    const element = createScroller()
    const write = vi.fn(() => {
      element.scrollTop = -450
      return 42
    })
    const details = vi.fn(() => ({ totalSize: 26410, virtualMaximumOffset: 25619 }))

    expect(
      recordConversationScrollWrite(
        element,
        CONVERSATION_SCROLL_WRITE_SOURCE.virtualizerOffset,
        -500,
        write,
        details
      )
    ).toBe(42)

    expect(write).toHaveBeenCalledOnce()
    expect(details).toHaveBeenCalledOnce()
    const events = getConversationDiagnosticsSnapshot()!.events
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      name: 'scroll-write',
      details: {
        writeSource: 1,
        previousScrollTop: -320,
        targetScrollTop: -500,
        scrollTop: -450,
        appliedCorrection: -130,
        scrollHeight: 26656,
        clientHeight: 791,
        clientWidth: 1200,
        rootHeight: 791,
        totalSize: 26410,
        virtualMaximumOffset: 25619,
      },
    })
    expect(Object.values(events[0].details).every(value => typeof value !== 'string')).toBe(true)
    expect(JSON.stringify(events)).not.toMatch(/private-message|Private transcript/)
  })

  test('records a smooth intent even when no offset changes synchronously', () => {
    startConversationDiagnosticCapture()
    const element = createScroller()
    element.scrollTo = vi.fn()

    recordConversationScrollWrite(
      element,
      CONVERSATION_SCROLL_WRITE_SOURCE.contentPosition,
      -800,
      () => element.scrollTo({ top: -800, behavior: 'smooth' })
    )

    expect(element.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: -800, behavior: 'smooth' })
    expect(getConversationDiagnosticsSnapshot()!.events[0].details).toMatchObject({
      previousScrollTop: -320,
      targetScrollTop: -800,
      appliedCorrection: 0,
      scrollTop: -320,
    })
  })

  test.each([false, true])('preserves thrown callback errors when capture is %s', enabled => {
    if (enabled) startConversationDiagnosticCapture()
    const error = new Error('Write failed')
    const write = vi.fn(() => {
      throw error
    })

    expect(() =>
      recordConversationScrollWrite(
        createScroller(),
        CONVERSATION_SCROLL_WRITE_SOURCE.controllerBottom,
        null,
        write
      )
    ).toThrow(error)
    expect(write).toHaveBeenCalledOnce()
    expect(
      getConversationDiagnosticsSnapshot()?.events[0].details.targetScrollTop ?? null
    ).toBeNull()
  })
})
