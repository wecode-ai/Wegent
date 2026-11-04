import { afterEach, describe, expect, test } from 'vitest'
import { installPageZoomGuard } from './pageZoomGuard'

let cleanup: (() => void) | undefined

afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

function dispatchKey(key: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    cancelable: true,
    ...modifiers,
  })
  document.dispatchEvent(event)
  return event
}

describe('installPageZoomGuard', () => {
  test.each([['+', { ctrlKey: true }]])('prevents page zoom shortcut %s', (key, modifiers) => {
    cleanup = installPageZoomGuard(document)

    expect(dispatchKey(key, modifiers).defaultPrevented).toBe(true)
  })

  test('allows ordinary keyboard input', () => {
    cleanup = installPageZoomGuard(document)

    expect(dispatchKey('+').defaultPrevented).toBe(false)
    expect(dispatchKey('a', { ctrlKey: true }).defaultPrevented).toBe(false)
  })

  test.each([{ metaKey: true }])('prevents modifier-assisted wheel zoom', modifiers => {
    cleanup = installPageZoomGuard(document)
    const event = new WheelEvent('wheel', {
      cancelable: true,
      ...modifiers,
    })

    document.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
  })

  test('allows ordinary wheel scrolling', () => {
    cleanup = installPageZoomGuard(document)
    const event = new WheelEvent('wheel', { cancelable: true })

    document.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
  })
})
