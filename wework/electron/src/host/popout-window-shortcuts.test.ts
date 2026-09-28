import { describe, expect, test, vi } from 'vitest'
import { handlePopoutWindowInput } from './popout-window-shortcuts.js'

describe('Popout Window Escape', () => {
  const escape = {
    type: 'keyDown' as const,
    key: 'Escape',
    isComposing: false,
    alt: false,
    control: false,
    meta: false,
    shift: false,
  }

  test('dismisses before the renderer can consume Escape in a composer or menu', () => {
    const event = { preventDefault: vi.fn() }
    const dismiss = vi.fn()
    handlePopoutWindowInput(event, escape, dismiss)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(dismiss).toHaveBeenCalledOnce()
  })

  test.each([
    { type: 'keyUp' as const },
    { key: 'Enter' },
    { isComposing: true },
    { alt: true },
    { control: true },
    { meta: true },
    { shift: true },
  ])('preserves unrelated keys and IME cancellation: %j', override => {
    const event = { preventDefault: vi.fn() }
    const dismiss = vi.fn()
    handlePopoutWindowInput(event, { ...escape, ...override }, dismiss)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(dismiss).not.toHaveBeenCalled()
  })
})
