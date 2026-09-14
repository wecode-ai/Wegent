import { afterEach, describe, expect, test } from 'vitest'
import { fillDesktopControlElement, isWeworkAutomationEnabled } from './automation'

afterEach(() => {
  delete window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__
})

describe('Electron desktop E2E automation', () => {
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
    let value = ''
    Object.defineProperty(editor, 'value', {
      configurable: true,
      get: () => value,
      set: nextValue => {
        value = String(nextValue)
      },
    })
    document.body.append(editor)

    await fillDesktopControlElement(editor, 'WEWORK_DESKTOP_E2E_WINDOWS_DRIVE_LINK')

    expect(value).toBe('WEWORK_DESKTOP_E2E_WINDOWS_DRIVE_LINK')
  })
})
