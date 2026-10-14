import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  fillDesktopControlElement,
  isWeworkAutomationEnabled,
  runDesktopControlClient,
} from './automation'

afterEach(() => {
  delete window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__
  vi.unstubAllGlobals()
})

describe('Electron desktop E2E automation', () => {
  test('acknowledges a completed action before polling for another command', async () => {
    const button = document.createElement('button')
    button.dataset.testid = 'control-ordering-button'
    const clicked = vi.fn()
    button.onclick = clicked
    document.body.append(button)
    let acknowledgeResult!: (value: Response) => void
    const resultAcknowledgement = new Promise<Response>(resolve => {
      acknowledgeResult = resolve
    })
    let polls = 0
    const fetch = vi.fn((url: string) => {
      if (url.includes('/commands?')) {
        polls += 1
        if (polls > 1) return new Promise<Response>(() => {})
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'ordered-click',
              action: 'click',
              selector: '[data-testid="control-ordering-button"]',
            })
          )
        )
      }
      if (url.endsWith('/results')) return resultAcknowledgement
      return Promise.resolve(new Response('{}'))
    })
    vi.stubGlobal('fetch', fetch)
    void runDesktopControlClient('http://127.0.0.1:43111', 'main')
    try {
      await vi.waitFor(() => expect(clicked).toHaveBeenCalledOnce())
      expect(polls).toBe(1)
      acknowledgeResult(new Response('{}'))
      await vi.waitFor(() => expect(polls).toBe(2))
    } finally {
      button.remove()
    }
  })

  test('is enabled by an injected runtime control URL', () => {
    window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__ = {
      controlUrl: 'http://127.0.0.1:43111',
    }

    expect(isWeworkAutomationEnabled()).toBe(true)
  })

  test('is disabled explicitly for isolated plugin development instances', () => {
    window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__ = {
      controlUrl: 'http://127.0.0.1:43111',
      disabled: true,
    }

    expect(isWeworkAutomationEnabled()).toBe(false)
  })

  test('allows an isolated plugin development instance to opt into desktop control', () => {
    window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__ = {
      controlUrl: 'http://127.0.0.1:43111',
      windowLabel: 'plugin-development-example',
    }

    expect(isWeworkAutomationEnabled()).toBe(true)
  })

  test('fills a contenteditable through its atomic value setter when available', async () => {
    const editor = document.createElement('div')
    editor.contentEditable = 'true'
    const updateApplicationState = vi.fn()
    Object.defineProperty(editor, 'value', {
      configurable: true,
      set: nextValue => {
        updateApplicationState(String(nextValue))
      },
    })
    document.body.append(editor)

    await fillDesktopControlElement(editor, 'WEWORK_DESKTOP_E2E_WINDOWS_DRIVE_LINK')

    expect(updateApplicationState).toHaveBeenCalledWith('WEWORK_DESKTOP_E2E_WINDOWS_DRIVE_LINK')
  })
})
