import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const diagnosticsScript = readFileSync(
  join(process.cwd(), 'src-tauri/src/embedded_browser_diagnostics.js'),
  'utf8'
)

function installDiagnosticsScript() {
  new Function('window', `with (window) { ${diagnosticsScript} }`)(window)
}

describe('embedded browser diagnostics runtime', () => {
  const originalOpen = window.open

  beforeEach(() => {
    document.body.innerHTML = ''
    delete (window as Window & { __WEWORK_BROWSER_DIAGNOSTICS_INSTALLED__?: boolean })
      .__WEWORK_BROWSER_DIAGNOSTICS_INSTALLED__
    window.open = vi.fn() as typeof window.open
  })

  afterEach(() => {
    window.open = originalOpen
  })

  test('intercepts target blank links before the Tauri opener plugin', () => {
    installDiagnosticsScript()
    const openerPluginListener = vi.fn()
    window.addEventListener('click', openerPluginListener)
    document.body.innerHTML = '<a href="https://example.test/path" target="_blank">Open</a>'

    document.querySelector('a')!.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
      })
    )

    expect(window.open).toHaveBeenCalledWith(
      'https://example.test/path',
      '_blank',
      'noopener,noreferrer'
    )
    expect(openerPluginListener).not.toHaveBeenCalled()
  })

  test('leaves ordinary same-tab links to the page', () => {
    installDiagnosticsScript()
    document.body.innerHTML = '<a href="https://example.test/path">Open</a>'

    document.querySelector('a')!.dispatchEvent(
      new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        button: 0,
      })
    )

    expect(window.open).not.toHaveBeenCalled()
  })

  test('patches the Tauri opener bridge into an in-browser popup', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke },
    })

    installDiagnosticsScript()

    await window.__TAURI_INTERNALS__.invoke('plugin:opener|open_url', {
      url: 'https://example.test/popup',
    })

    expect(window.open).toHaveBeenCalledWith(
      'https://example.test/popup',
      '_blank',
      'noopener,noreferrer'
    )
    expect(invoke).not.toHaveBeenCalled()
  })
})
