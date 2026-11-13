import { WEWORK_OPEN_SCHEME_EVENT } from '@/features/notifications/schemeEvents'
import { fireEvent, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  installExternalLinkHandler,
  isHttpUrl,
  isLocalHttpUrl,
  openExternalUrl,
  openInExternalBrowser,
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
  test.each([
    'wework-conversation://%7B%22deviceId%22%3A%22device%22%2C%22taskId%22%3A%22task%22%7D',
    'wework-issue://project/issue',
  ])(
    'keeps validated internal reference handlers reachable without browser navigation: %s',
    href => {
      const cleanup = installExternalLinkHandler()
      const anchor = document.createElement('a')
      anchor.href = href
      document.body.append(anchor)
      const handler = vi.fn()
      anchor.addEventListener('click', handler)
      const event = new MouseEvent('click', { bubbles: true, cancelable: true })
      anchor.dispatchEvent(event)
      expect(handler).toHaveBeenCalledOnce()
      expect(event.defaultPrevented).toBe(true)
      expect(desktopHostMock).not.toHaveBeenCalled()
      expect(openWindowMock).not.toHaveBeenCalled()
      cleanup()
    }
  )

  test.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\nscript:alert(1)',
    'data:text/html,test',
    'file:///private/key',
    'vbscript:test',
  ])('blocks document navigation before renderer handlers for %s', href => {
    const cleanup = installExternalLinkHandler()
    const anchor = document.createElement('a')
    anchor.href = href
    const nested = document.createElement('span')
    anchor.append(nested)
    document.body.append(anchor)
    const listener = vi.fn((event: Event) => event.stopPropagation())
    anchor.addEventListener('click', listener)
    for (const type of ['click', 'auxclick']) {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: type === 'click' ? 0 : 1,
      })
      nested.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }
    expect(listener).not.toHaveBeenCalled()
    cleanup()
  })
  test('blocks unsafe document links inside open shadow roots', () => {
    const cleanup = installExternalLinkHandler()
    const host = document.createElement('div')
    document.body.append(host)
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<a href="javascript:alert(1)">link</a>'
    const event = new MouseEvent('click', { bubbles: true, composed: true, cancelable: true })
    shadow.querySelector('a')!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    cleanup()
  })

  test('blocks SVG links with namespaced href attributes before their handlers run', () => {
    const cleanup = installExternalLinkHandler()
    document.body.innerHTML =
      '<svg><a xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="javascript:alert(1)"><text>Open</text></a></svg>'
    const handler = vi.fn()
    const anchor = document.querySelector('a')!
    anchor.addEventListener('click', handler)
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    anchor.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(handler).not.toHaveBeenCalled()
    cleanup()
  })
  test.each(['file:///Users/', 'file:///Users/example/test.txt', 'https://example.com/'])(
    'sends explicit browser-toolbar target %s to the browser capability',
    async url => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      await openInExternalBrowser(url)
      expect(desktopHostMock).toHaveBeenCalledWith('browser.openExternal', { url })
      expect(getAppPreferencesMock).not.toHaveBeenCalled()
      expect(requestEmbeddedBrowserOpenMock).not.toHaveBeenCalled()
    }
  )

  test('propagates an external browser failure so the toolbar can show it', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    desktopHostMock.mockRejectedValueOnce(new Error('Browser unavailable'))
    await expect(openInExternalBrowser('file:///Users/')).rejects.toThrow('Browser unavailable')
  })

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

  test('routes Wework links into the shared in-app scheme navigator', async () => {
    const opened = vi.fn()
    window.addEventListener(WEWORK_OPEN_SCHEME_EVENT, opened)
    try {
      await expect(openExternalUrl('wework://apps/wegent')).resolves.toBe(true)
      expect(opened).toHaveBeenCalledOnce()
      expect((opened.mock.calls[0][0] as CustomEvent<string>).detail).toBe('wework://apps/wegent')
      expect(desktopHostMock).not.toHaveBeenCalled()
      expect(openWindowMock).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(WEWORK_OPEN_SCHEME_EVENT, opened)
    }
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

  test.each([
    { href: '', cancelNavigation: true },
    { href: '#', cancelNavigation: true },
    { href: ' # ', cancelNavigation: true },
    { href: '#section', cancelNavigation: false },
    { href: ' #section ', cancelNavigation: false },
  ])(
    'preserves fragment behavior without opening another browser for $href',
    ({ href, cancelNavigation }) => {
      window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
      const cleanup = installExternalLinkHandler()
      const originalUrl = window.location.href
      const base = document.createElement('base')
      base.href = `${window.location.origin}/`
      document.head.append(base)
      window.history.replaceState(null, '', '/wework/app/runtime-tasks')
      try {
        const anchor = document.createElement('a')
        anchor.setAttribute('href', href)
        document.body.append(anchor)
        const event = new MouseEvent('click', { bubbles: true, cancelable: true })
        anchor.dispatchEvent(event)
        expect(event.defaultPrevented).toBe(cancelNavigation)
        expect(getAppPreferencesMock).not.toHaveBeenCalled()
        expect(requestEmbeddedBrowserOpenMock).not.toHaveBeenCalled()
        expect(desktopHostMock).not.toHaveBeenCalled()
      } finally {
        cleanup()
        base.remove()
        window.history.replaceState(null, '', originalUrl)
      }
    }
  )

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
