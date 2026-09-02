import { afterEach, describe, expect, test, vi } from 'vitest'
import { installXtermMacKeybindings } from './xtermMacKeybindings'

type CustomKeyEventHandler = (event: KeyboardEvent) => boolean

function installForPlatform(platform: string, userAgent: string) {
  vi.stubGlobal('navigator', { platform, userAgent })
  let handler: CustomKeyEventHandler | null = null
  const terminal = {
    attachCustomKeyEventHandler: vi.fn((nextHandler: CustomKeyEventHandler) => {
      handler = nextHandler
    }),
  }
  const writeData = vi.fn()

  installXtermMacKeybindings({ terminal, writeData })

  return { handler, terminal, writeData }
}

function createKeyEvent(
  key: string,
  overrides: Partial<KeyboardEvent> = {}
): KeyboardEvent & {
  preventDefault: ReturnType<typeof vi.fn>
  stopPropagation: ReturnType<typeof vi.fn>
} {
  return {
    type: 'keydown',
    key,
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent & {
    preventDefault: ReturnType<typeof vi.fn>
    stopPropagation: ReturnType<typeof vi.fn>
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('installXtermMacKeybindings', () => {
  test.each([
    ['ArrowLeft', '\x1bb'],
    ['ArrowRight', '\x1bf'],
  ])('maps macOS Option+%s to shell word navigation', (key, expectedData) => {
    const { handler, writeData } = installForPlatform(
      'MacIntel',
      'Macintosh; Intel Mac OS X 10_15_7'
    )
    const event = createKeyEvent(key)

    expect(handler?.(event)).toBe(false)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(event.stopPropagation).toHaveBeenCalledTimes(1)
    expect(writeData).toHaveBeenCalledWith(expectedData)
  })

  test.each([
    ['ArrowLeft', '\x01'],
    ['ArrowUp', '\x01'],
    ['ArrowRight', '\x05'],
    ['ArrowDown', '\x05'],
    ['Backspace', '\x15'],
    ['Delete', '\x0b'],
  ])('maps macOS Command+%s to ChatGPT terminal navigation', (key, expectedData) => {
    const { handler, writeData } = installForPlatform(
      'MacIntel',
      'Macintosh; Intel Mac OS X 10_15_7'
    )
    const event = createKeyEvent(key, { altKey: false, metaKey: true })

    expect(handler?.(event)).toBe(false)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(event.stopPropagation).toHaveBeenCalledTimes(1)
    expect(writeData).toHaveBeenCalledWith(expectedData)
  })

  test.each([
    ['keyup', { type: 'keyup' }],
    ['unmodified arrow', { altKey: false }],
    ['Control+Option', { ctrlKey: true }],
    ['Command+Option', { metaKey: true }],
    ['Shift+Option', { shiftKey: true }],
    ['unrelated key', { key: 'ArrowUp' }],
    ['unrelated Command key', { altKey: false, metaKey: true, key: 'Enter' }],
  ])('leaves %s to xterm', (_label, overrides) => {
    const { handler, writeData } = installForPlatform(
      'MacIntel',
      'Macintosh; Intel Mac OS X 10_15_7'
    )
    const event = createKeyEvent('ArrowLeft', overrides)

    expect(handler?.(event)).toBe(true)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(event.stopPropagation).not.toHaveBeenCalled()
    expect(writeData).not.toHaveBeenCalled()
  })

  test('does not install the override outside macOS', () => {
    const { handler, terminal } = installForPlatform('Win32', 'Windows NT 10.0; Win64; x64')

    expect(handler).toBeNull()
    expect(terminal.attachCustomKeyEventHandler).not.toHaveBeenCalled()
  })
})
