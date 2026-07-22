import { beforeEach, describe, expect, test, vi } from 'vitest'

import { openUrl } from '@tauri-apps/plugin-opener'
import { openSystemBrowserIfCurrent } from './systemBrowser'

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

const openWindowMock = vi.fn()

describe('openSystemBrowserIfCurrent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('open', openWindowMock)
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__')
  })

  test('opens the viewer with the Tauri system opener', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })

    await expect(
      openSystemBrowserIfCurrent('http://127.0.0.1:43123/vnc.html', () => true)
    ).resolves.toBe(true)

    expect(openUrl).toHaveBeenCalledWith('http://127.0.0.1:43123/vnc.html')
    expect(openWindowMock).not.toHaveBeenCalled()
  })

  test('does not invoke the system opener after the request becomes stale', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    })
    const isCurrent = vi.fn().mockReturnValue(false)

    await expect(
      openSystemBrowserIfCurrent('http://127.0.0.1:43123/vnc.html', isCurrent)
    ).resolves.toBe(false)

    expect(isCurrent).toHaveBeenCalledOnce()
    expect(openUrl).not.toHaveBeenCalled()
  })

  test('uses a browser tab outside the Tauri runtime', async () => {
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
