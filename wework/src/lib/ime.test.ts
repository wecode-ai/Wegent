import { describe, expect, test } from 'vitest'
import { isImeComposingEvent, isImeEnterEvent } from './ime'

describe('IME keyboard helpers', () => {
  test('detects React native composing state', () => {
    expect(
      isImeEnterEvent({
        key: 'Enter',
        nativeEvent: { isComposing: true },
      })
    ).toBe(true)
  })

  test('detects process key events used by IME confirmation', () => {
    expect(isImeEnterEvent({ key: 'Enter', keyCode: 229 })).toBe(true)
    expect(isImeComposingEvent({ nativeEvent: { which: 229 } })).toBe(true)
  })

  test('allows ordinary Enter events', () => {
    expect(isImeEnterEvent({ key: 'Enter' })).toBe(false)
    expect(isImeComposingEvent({ key: 'Enter' })).toBe(false)
  })
})
