import { afterEach, describe, expect, test } from 'vitest'
import { installPageZoomGuard } from './pageZoomGuard'

let cleanup: (() => void) | undefined

afterEach(() => {
  cleanup?.()
  cleanup = undefined
})

function dispatchKey(
  key: string,
  modifiers: { ctrlKey?: boolean; metaKey?: boolean } = {},
) {
  const event = new KeyboardEvent('keydown', {
    key,
    cancelable: true,
    ...modifiers,
  })
  document.dispatchEvent(event)
  return event
}

describe('installPageZoomGuard', () => {
  test.each([
    ['+', { ctrlKey: true }],
    ['=', { ctrlKey: true }],
    ['-', { ctrlKey: true }],
    ['0', { ctrlKey: true }],
    ['+', { metaKey: true }],
  ])('prevents page zoom shortcut %s', (key, modifiers) => {
    cleanup = installPageZoomGuard(document)

    expect(dispatchKey(key, modifiers).defaultPrevented).toBe(true)
  })

  test('allows ordinary keyboard input', () => {
    cleanup = installPageZoomGuard(document)

    expect(dispatchKey('+').defaultPrevented).toBe(false)
    expect(dispatchKey('a', { ctrlKey: true }).defaultPrevented).toBe(false)
  })

  test.each([{ ctrlKey: true }, { metaKey: true }])(
    'prevents modifier-assisted wheel zoom',
    modifiers => {
      cleanup = installPageZoomGuard(document)
      const event = new WheelEvent('wheel', {
        cancelable: true,
        ...modifiers,
      })

      document.dispatchEvent(event)

      expect(event.defaultPrevented).toBe(true)
    },
  )

  test('allows ordinary wheel scrolling', () => {
    cleanup = installPageZoomGuard(document)
    const event = new WheelEvent('wheel', { cancelable: true })

    document.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
  })

  test.each(['gesturestart', 'gesturechange'])(
    'prevents native %s page zoom',
    eventName => {
      cleanup = installPageZoomGuard(document)
      const event = new Event(eventName, { cancelable: true })

      document.dispatchEvent(event)

      expect(event.defaultPrevented).toBe(true)
    },
  )

  test('removes every listener during cleanup', () => {
    cleanup = installPageZoomGuard(document)
    cleanup()
    cleanup = undefined

    expect(dispatchKey('+', { ctrlKey: true }).defaultPrevented).toBe(false)

    const wheelEvent = new WheelEvent('wheel', {
      cancelable: true,
      ctrlKey: true,
    })
    document.dispatchEvent(wheelEvent)
    expect(wheelEvent.defaultPrevented).toBe(false)

    const gestureEvent = new Event('gesturestart', { cancelable: true })
    document.dispatchEvent(gestureEvent)
    expect(gestureEvent.defaultPrevented).toBe(false)
  })
})
