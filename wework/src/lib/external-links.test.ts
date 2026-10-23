import { fireEvent, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  installExternalLinkHandler,
  isDingTalkUrl,
  isHttpUrl,
  isLocalHttpUrl,
  openExternalUrl,
} from './external-links'

const desktopHostMock = vi.hoisted(() => vi.fn())
const requestEmbeddedBrowserOpenMock = vi.hoisted(() => vi.fn())
const getAppPreferencesMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: desktopHostMock }))
vi.mock('./embedded-browser', () => ({
  requestEmbeddedBrowserOpen: requestEmbeddedBrowserOpenMock,
}))
vi.mock('@/desktop/appPreferences', () => ({
  getAppPreferences: getAppPreferencesMock,
}))

const openWindowMock = vi.fn()

afterEach(() => {
  document.body.innerHTML = ''
  delete window.__WEWORK_RUNTIME_CONFIG__
  desktopHostMock.mockReset()
  requestEmbeddedBrowserOpenMock.mockReset()
  requestEmbeddedBrowserOpenMock.mockReturnValue(true)
  getAppPreferencesMock.mockReset()
  getAppPreferencesMock.mockResolvedValue({
    browserExternalLinkTarget: 'system',
    browserLocalLinkTarget: 'wework',
  })
  openWindowMock.mockReset()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('external link helpers', () => {
  test('accepts only http and https URLs', () => {
    expect(isHttpUrl('https://example.com')).toBe(true)
    expect(isHttpUrl('http://example.com')).toBe(true)
    expect(isHttpUrl('mailto:user@example.com')).toBe(false)
    expect(isHttpUrl('/settings')).toBe(false)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
  })

  test('recognizes DingTalk client deep links', () => {
    expect(isDingTalkUrl('dingtalk://dingtalkclient/page/link?url=x')).toBe(true)
    expect(isDingTalkUrl('https://n.dingtalk.com/dingding/dd-todo')).toBe(false)
    expect(isDingTalkUrl('javascript:alert(1)')).toBe(false)
  })

  test('detects localhost URLs without treating private remote hosts as local', () => {
    expect(isLocalHttpUrl('http://localhost:3000')).toBe(true)
    expect(isLocalHttpUrl('https://app.localhost/path')).toBe(true)
    expect(isLocalHttpUrl('http://127.0.0.1:5173')).toBe(true)
    expect(isLocalHttpUrl('http://[::1]:8000')).toBe(true)
    expect(isLocalHttpUrl('http://192.168.1.20')).toBe(false)
    expect(isLocalHttpUrl('https://example.com')).toBe(false)
  })

  test('opens http URLs with the browser fallback outside Electron', async () => {
    vi.stubGlobal('open', openWindowMock)
    await expect(openExternalUrl('https://example.com/docs')).resolves.toBe(true)
    expect(openWindowMock).toHaveBeenCalledWith(
      'https://example.com/docs',
      '_blank',
      'noopener,noreferrer'
    )
    expect(desktopHostMock).not.toHaveBeenCalled()
  })

  test('does not infer browser open success from a noopener window handle', async () => {
    vi.stubGlobal('open', openWindowMock)
    openWindowMock.mockReturnValue(null)
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})

    await expect(openExternalUrl('https://example.com/docs')).resolves.toBe(true)

    expect(openWindowMock).toHaveBeenCalledWith(
      'https://example.com/docs',
      '_blank',
      'noopener,noreferrer'
    )
    expect(log).toHaveBeenCalledWith('[Wework][external-link]', {
      event: 'opened',
      source: 'unknown',
      url: 'https://example.com',
      target: 'browser',
    })
  })

  test('opens external links through the Electron host', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    await expect(openExternalUrl('https://example.com/docs')).resolves.toBe(true)
    expect(desktopHostMock).toHaveBeenCalledWith('shell.openExternal', {
      url: 'https://example.com/docs',
    })
  })

  test('opens DingTalk deep links through the Electron host', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const url = 'dingtalk://dingtalkclient/page/link?url=https%3A%2F%2Fn.dingtalk.com&pc_slide=true'

    await expect(openExternalUrl(url)).resolves.toBe(true)

    expect(desktopHostMock).toHaveBeenCalledWith('shell.openExternal', { url })
    expect(requestEmbeddedBrowserOpenMock).not.toHaveBeenCalled()
  })

  test.each([
    'javascript:alert(1)',
    'file:///C:/Users/viewer/private.txt',
    'mailto:user@example.com',
    '/settings',
  ])('rejects unsupported desktop links without opening a browser: %s', async url => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    vi.stubGlobal('open', openWindowMock)

    await expect(openExternalUrl(url)).resolves.toBe(false)

    expect(getAppPreferencesMock).not.toHaveBeenCalled()
    expect(requestEmbeddedBrowserOpenMock).not.toHaveBeenCalled()
    expect(desktopHostMock).not.toHaveBeenCalled()
    expect(openWindowMock).not.toHaveBeenCalled()
  })

  test('uses the current link preference on each click', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    getAppPreferencesMock
      .mockResolvedValueOnce({ browserExternalLinkTarget: 'wework' })
      .mockResolvedValueOnce({ browserExternalLinkTarget: 'system' })

    await openExternalUrl('https://example.com/docs')
    await openExternalUrl('https://example.com/docs')

    expect(getAppPreferencesMock).toHaveBeenCalledTimes(2)
    expect(requestEmbeddedBrowserOpenMock).toHaveBeenCalledExactlyOnceWith(
      'https://example.com/docs'
    )
    expect(desktopHostMock).toHaveBeenCalledExactlyOnceWith('shell.openExternal', {
      url: 'https://example.com/docs',
    })
  })

  test('routes configured localhost links into the Wework built-in browser', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    await expect(openExternalUrl('http://localhost:3000')).resolves.toBe(true)
    expect(requestEmbeddedBrowserOpenMock).toHaveBeenCalledWith('http://localhost:3000')
    expect(desktopHostMock).not.toHaveBeenCalled()
  })

  test('falls back to the system browser when no Wework browser panel is listening', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    requestEmbeddedBrowserOpenMock.mockReturnValue(false)
    await expect(openExternalUrl('http://localhost:3000')).resolves.toBe(true)
    expect(desktopHostMock).toHaveBeenCalledWith('shell.openExternal', {
      url: 'http://localhost:3000',
    })
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

  test('keeps URL credentials and private paths out of link diagnostics', async () => {
    vi.stubGlobal('open', openWindowMock)
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})

    await openExternalUrl(
      'https://alice:password@example.com/private-document?token=secret#private-section'
    )

    expect(log).toHaveBeenCalledWith(
      '[Wework][external-link]',
      expect.objectContaining({ event: 'opened', url: 'https://example.com' })
    )
  })

  test('preserves open failures without logging sensitive error messages', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const error = new Error('Failed to open https://example.com/private-document?token=secret')
    desktopHostMock.mockRejectedValueOnce(error)
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})

    await expect(openExternalUrl('https://example.com/private-document')).rejects.toBe(error)

    expect(log).toHaveBeenCalledWith(
      '[Wework][external-link]',
      expect.objectContaining({ event: 'failed', error: 'Error', url: 'https://example.com' })
    )
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-document')
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret')
  })
})
