import { afterEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, waitFor } from '@testing-library/react'
import { installExternalLinkHandler, isHttpUrl, openExternalUrl } from './external-links'
import { openUrl } from '@tauri-apps/plugin-opener'

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
}))

const openWindowMock = vi.fn()

afterEach(() => {
  document.body.innerHTML = ''
  delete (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__
  vi.mocked(openUrl).mockReset()
  openWindowMock.mockReset()
  vi.unstubAllGlobals()
})

describe('external link helpers', () => {
  test('accepts only http and https URLs', () => {
    expect(isHttpUrl('https://example.com')).toBe(true)
    expect(isHttpUrl('http://example.com')).toBe(true)
    expect(isHttpUrl('mailto:user@example.com')).toBe(false)
    expect(isHttpUrl('/settings')).toBe(false)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
  })

  test('opens http URLs with browser fallback outside Tauri', async () => {
    vi.stubGlobal('open', openWindowMock)

    await expect(openExternalUrl('https://example.com/docs')).resolves.toBe(true)

    expect(openWindowMock).toHaveBeenCalledWith(
      'https://example.com/docs',
      '_blank',
      'noopener,noreferrer'
    )
    expect(openUrl).not.toHaveBeenCalled()
  })

  test('opens http URLs with the Tauri opener plugin in desktop runtime', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    vi.stubGlobal('open', openWindowMock)

    await expect(openExternalUrl('https://example.com/docs')).resolves.toBe(true)

    expect(openUrl).toHaveBeenCalledWith('https://example.com/docs')
    expect(openWindowMock).not.toHaveBeenCalled()
  })

  test('intercepts clicked http anchors through the shared opener', async () => {
    vi.stubGlobal('open', openWindowMock)
    const cleanup = installExternalLinkHandler()
    document.body.innerHTML = '<a href="https://example.com/path">Open</a>'

    fireEvent.click(document.querySelector('a')!)

    await waitFor(() =>
      expect(openWindowMock).toHaveBeenCalledWith(
        'https://example.com/path',
        '_blank',
        'noopener,noreferrer'
      )
    )
    cleanup()
  })
})
