import { afterEach, describe, expect, test } from 'vitest'
import { installDesktopNavigationGuard } from './desktopNavigationGuard'

let cleanup: (() => void) | undefined

afterEach(() => {
  cleanup?.()
  cleanup = undefined
  delete window.__WEWORK_RUNTIME_CONFIG__
  document.body.replaceChildren()
})

function enableDesktopRuntime() {
  window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
}

function dispatchBackspace(target: Element = document.body) {
  const event = new KeyboardEvent('keydown', {
    key: 'Backspace',
    bubbles: true,
    cancelable: true,
  })
  target.dispatchEvent(event)
  return event
}

describe('installDesktopNavigationGuard', () => {
  test('prevents Backspace navigation in the desktop app', () => {
    enableDesktopRuntime()
    cleanup = installDesktopNavigationGuard(document)

    expect(dispatchBackspace().defaultPrevented).toBe(true)
  })

  test('allows Backspace in editable elements', () => {
    enableDesktopRuntime()
    cleanup = installDesktopNavigationGuard(document)

    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    document.body.append(input, textarea, editable)

    expect(dispatchBackspace(input).defaultPrevented).toBe(false)
    expect(dispatchBackspace(textarea).defaultPrevented).toBe(false)
    expect(dispatchBackspace(editable).defaultPrevented).toBe(false)
  })

  test('does not change browser behavior outside the desktop app', () => {
    cleanup = installDesktopNavigationGuard(document)

    expect(dispatchBackspace().defaultPrevented).toBe(false)
  })

  test('removes the listener during cleanup', () => {
    enableDesktopRuntime()
    cleanup = installDesktopNavigationGuard(document)
    cleanup()
    cleanup = undefined

    expect(dispatchBackspace().defaultPrevented).toBe(false)
  })
})
