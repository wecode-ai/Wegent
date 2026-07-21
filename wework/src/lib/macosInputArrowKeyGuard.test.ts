import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const isTauriRuntimeMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/runtime-environment', () => ({
  isTauriRuntime: isTauriRuntimeMock,
}))

import { installMacOSInputArrowKeyGuard } from './macosInputArrowKeyGuard'

describe('installMacOSInputArrowKeyGuard', () => {
  let userAgent = ''

  beforeEach(() => {
    userAgent = ''
    isTauriRuntimeMock.mockReset()
    vi.stubGlobal('navigator', {
      ...navigator,
      get userAgent() {
        return userAgent
      },
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  function createInput(
    value = '',
    selectionStart = 0,
    selectionEnd = selectionStart
  ): HTMLInputElement {
    const input = document.createElement('input')
    input.value = value
    input.setSelectionRange(selectionStart, selectionEnd)
    document.body.appendChild(input)
    return input
  }

  function dispatchArrowKey(target: HTMLElement, key: 'ArrowLeft' | 'ArrowRight'): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
    target.dispatchEvent(event)
    return event
  }

  test('is a no-op when not running in Tauri', () => {
    isTauriRuntimeMock.mockReturnValue(false)
    userAgent = 'Macintosh; Intel Mac OS X 10_15_7'
    const dispose = installMacOSInputArrowKeyGuard()
    const input = createInput('', 0, 0)
    const event = dispatchArrowKey(input, 'ArrowRight')
    expect(event.defaultPrevented).toBe(false)
    dispose()
  })

  test('is a no-op on non-macOS platforms', () => {
    isTauriRuntimeMock.mockReturnValue(true)
    userAgent = 'Windows NT 10.0; Win64; x64'
    const dispose = installMacOSInputArrowKeyGuard()
    const input = createInput('', 0, 0)
    const event = dispatchArrowKey(input, 'ArrowRight')
    expect(event.defaultPrevented).toBe(false)
    dispose()
  })

  test('prevents ArrowRight at the end of an input', () => {
    isTauriRuntimeMock.mockReturnValue(true)
    userAgent = 'Macintosh; Intel Mac OS X 10_15_7'
    const dispose = installMacOSInputArrowKeyGuard()
    const input = createInput('hello', 5, 5)
    const event = dispatchArrowKey(input, 'ArrowRight')
    expect(event.defaultPrevented).toBe(true)
    dispose()
  })

  test('prevents ArrowLeft at the start of an input', () => {
    isTauriRuntimeMock.mockReturnValue(true)
    userAgent = 'Macintosh; Intel Mac OS X 10_15_7'
    const dispose = installMacOSInputArrowKeyGuard()
    const input = createInput('hello', 0, 0)
    const event = dispatchArrowKey(input, 'ArrowLeft')
    expect(event.defaultPrevented).toBe(true)
    dispose()
  })

  test('does not prevent ArrowLeft in the middle of an input', () => {
    isTauriRuntimeMock.mockReturnValue(true)
    userAgent = 'Macintosh; Intel Mac OS X 10_15_7'
    const dispose = installMacOSInputArrowKeyGuard()
    const input = createInput('hello', 2, 2)
    const event = dispatchArrowKey(input, 'ArrowLeft')
    expect(event.defaultPrevented).toBe(false)
    dispose()
  })

  test('does not prevent ArrowRight before the end of an input', () => {
    isTauriRuntimeMock.mockReturnValue(true)
    userAgent = 'Macintosh; Intel Mac OS X 10_15_7'
    const dispose = installMacOSInputArrowKeyGuard()
    const input = createInput('hello', 2, 2)
    const event = dispatchArrowKey(input, 'ArrowRight')
    expect(event.defaultPrevented).toBe(false)
    dispose()
  })

  test('ignores non-input targets', () => {
    isTauriRuntimeMock.mockReturnValue(true)
    userAgent = 'Macintosh; Intel Mac OS X 10_15_7'
    const dispose = installMacOSInputArrowKeyGuard()
    const div = document.createElement('div')
    const event = dispatchArrowKey(div, 'ArrowRight')
    expect(event.defaultPrevented).toBe(false)
    dispose()
  })

  test('ignores IME composing events', () => {
    isTauriRuntimeMock.mockReturnValue(true)
    userAgent = 'Macintosh; Intel Mac OS X 10_15_7'
    const dispose = installMacOSInputArrowKeyGuard()
    const input = createInput('hello', 5, 5)
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      bubbles: true,
      cancelable: true,
    })
    Object.defineProperty(event, 'isComposing', { value: true })
    input.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    dispose()
  })

  test('ignores events with non-collapsed selection', () => {
    isTauriRuntimeMock.mockReturnValue(true)
    userAgent = 'Macintosh; Intel Mac OS X 10_15_7'
    const dispose = installMacOSInputArrowKeyGuard()
    const input = createInput('hello', 1, 4)
    const event = dispatchArrowKey(input, 'ArrowRight')
    expect(event.defaultPrevented).toBe(false)
    dispose()
  })

  test('ignores disabled and read-only inputs', () => {
    isTauriRuntimeMock.mockReturnValue(true)
    userAgent = 'Macintosh; Intel Mac OS X 10_15_7'
    const dispose = installMacOSInputArrowKeyGuard()
    const disabledInput = createInput('hello', 5, 5)
    disabledInput.disabled = true
    expect(dispatchArrowKey(disabledInput, 'ArrowRight').defaultPrevented).toBe(false)

    const readOnlyInput = createInput('hello', 0, 0)
    readOnlyInput.readOnly = true
    expect(dispatchArrowKey(readOnlyInput, 'ArrowLeft').defaultPrevented).toBe(false)
    dispose()
  })
})
