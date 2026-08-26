import { beforeEach, describe, expect, test, vi } from 'vitest'

import { openSystemBrowserIfCurrent } from './systemBrowser'

const openExternalUrlMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/external-links', () => ({
  isHttpUrl: (value: string) => /^https?:\/\//.test(value),
  openExternalUrl: openExternalUrlMock,
}))

const openWindowMock = vi.fn()

describe('openSystemBrowserIfCurrent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('open', openWindowMock)
    delete window.__WEWORK_RUNTIME_CONFIG__
    openExternalUrlMock.mockResolvedValue(true)
  })

  test('opens the viewer with the Electron system opener', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }

    await expect(
      openSystemBrowserIfCurrent('http://127.0.0.1:43123/vnc.html', () => true)
    ).resolves.toBe(true)

    expect(openExternalUrlMock).toHaveBeenCalledWith('http://127.0.0.1:43123/vnc.html', {
      target: 'system',
    })
    expect(openWindowMock).not.toHaveBeenCalled()
  })

  test('does not invoke the system opener after the request becomes stale', async () => {
    window.__WEWORK_RUNTIME_CONFIG__ = { desktopHost: 'electron' }
    const isCurrent = vi.fn().mockReturnValue(false)

    await expect(
      openSystemBrowserIfCurrent('http://127.0.0.1:43123/vnc.html', isCurrent)
    ).resolves.toBe(false)

    expect(isCurrent).toHaveBeenCalledOnce()
    expect(openExternalUrlMock).not.toHaveBeenCalled()
  })

  test('uses a browser tab outside the desktop runtime', async () => {
    await expect(
      openSystemBrowserIfCurrent('http://127.0.0.1:43123/vnc.html', () => true)
    ).resolves.toBe(true)

    expect(openWindowMock).toHaveBeenCalledWith(
      'http://127.0.0.1:43123/vnc.html',
      '_blank',
      'noopener,noreferrer'
    )
  })
})
