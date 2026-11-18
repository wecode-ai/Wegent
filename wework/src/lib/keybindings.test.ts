import { describe, expect, test } from 'vitest'
import { keybindingFromKeyboardEvent, normalizeKeybinding } from './keybindings'

function keyboardEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    code: '',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent
}

describe('keybindingFromKeyboardEvent', () => {
  test('records shifted shortcuts from physical keys for native accelerators', () => {
    const event = keyboardEvent({
      key: '@',
      code: 'Digit2',
      metaKey: true,
      shiftKey: true,
    })

    expect(normalizeKeybinding(keybindingFromKeyboardEvent(event, true))).toBe('Shift+Command+2')
  })
})
