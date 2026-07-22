import { afterEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, waitFor } from '@testing-library/react'
import {
  installExternalLinkHandler,
  isHttpUrl,
  isLocalHttpUrl,
  openExternalUrl,
} from './external-links'
import { openUrl } from '@tauri-apps/plugin-opener'

const requestEmbeddedBrowserOpenMock = vi.hoisted(() => vi.fn())
const getAppPreferencesMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
}))

vi.mock('./embedded-browser', () => ({
  requestEmbeddedBrowserOpen: requestEmbeddedBrowserOpenMock,
}))

vi.mock('@/tauri/appPreferences', () => ({
  getAppPreferences: getAppPreferencesMock,
}))

const openWindowMock = vi.fn()

afterEach(() => {
  document.body.innerHTML = ''
  delete (window as Window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__
  vi.mocked(openUrl).mockReset()
  requestEmbeddedBrowserOpenMock.mockReset()
  requestEmbeddedBrowserOpenMock.mockReturnValue(true)
  getAppPreferencesMock.mockReset()
  getAppPreferencesMock.mockResolvedValue({
    browserExternalLinkTarget: 'system',
    browserLocalLinkTarget: 'wework',
  })
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

  test('detects localhost URLs without treating private remote hosts as local', () => {
    expect(isLocalHttpUrl('http://localhost:3000')).toBe(true)
    expect(isLocalHttpUrl('https://app.localhost/path')).toBe(true)
    expect(isLocalHttpUrl('http://127.0.0.1:5173')).toBe(true)
    expect(isLocalHttpUrl('http://[::1]:8000')).toBe(true)
    expect(isLocalHttpUrl('http://192.168.1.20')).toBe(false)
    expect(isLocalHttpUrl('https://example.com')).toBe(false)
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

  test('routes configured localhost links into the Wework built-in browser', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    await expect(openExternalUrl('http://localhost:3000')).resolves.toBe(true)

    expect(requestEmbeddedBrowserOpenMock).toHaveBeenCalledWith('http://localhost:3000')
    expect(openUrl).not.toHaveBeenCalled()
  })

  test('falls back to the system browser when no Wework browser panel is listening', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    requestEmbeddedBrowserOpenMock.mockReturnValue(false)

    await expect(openExternalUrl('http://localhost:3000')).resolves.toBe(true)

    expect(requestEmbeddedBrowserOpenMock).toHaveBeenCalledWith('http://localhost:3000')
    expect(openUrl).toHaveBeenCalledWith('http://localhost:3000')
  })

  test('supports forcing the system browser from the browser toolbar', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    await expect(openExternalUrl('http://localhost:3000', { target: 'system' })).resolves.toBe(true)

    expect(openUrl).toHaveBeenCalledWith('http://localhost:3000')
    expect(requestEmbeddedBrowserOpenMock).not.toHaveBeenCalled()
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
