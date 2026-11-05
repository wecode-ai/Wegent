import { beforeEach, describe, expect, test, vi } from 'vitest'
import { invokeDesktopHost, subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import { openExternalUrl } from './external-links'
import { isElectronRuntime } from './runtime-environment'
import { openCloudAuthorizationWindow } from './cloud-authorization-window'

vi.mock('./external-links', async importOriginal => ({
  ...(await importOriginal<typeof import('./external-links')>()),
  openExternalUrl: vi.fn(),
}))
vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: vi.fn(async () => undefined),
  subscribeDesktopHostEvents: vi.fn(),
}))
vi.mock('./runtime-environment', async importOriginal => ({
  ...(await importOriginal<typeof import('./runtime-environment')>()),
  isElectronRuntime: vi.fn(() => false),
}))

const openExternalUrlMock = vi.mocked(openExternalUrl)
const invokeDesktopHostMock = vi.mocked(invokeDesktopHost)
const subscribeDesktopHostEventsMock = vi.mocked(subscribeDesktopHostEvents)
const isElectronRuntimeMock = vi.mocked(isElectronRuntime)

describe('openCloudAuthorizationWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    openExternalUrlMock.mockResolvedValue(true)
    isElectronRuntimeMock.mockReturnValue(false)
    subscribeDesktopHostEventsMock.mockReturnValue(() => undefined)
  })

  test('rejects non-http authorization urls', async () => {
    await expect(openCloudAuthorizationWindow('file:///tmp/auth.html')).resolves.toBeUndefined()

    expect(openExternalUrlMock).not.toHaveBeenCalled()
    expect(invokeDesktopHostMock).not.toHaveBeenCalled()
  })

  test('opens authorization in the system browser in a web build', async () => {
    await expect(openCloudAuthorizationWindow('https://example.com/auth')).resolves.toBeUndefined()

    expect(openExternalUrlMock).toHaveBeenCalledWith('https://example.com/auth', {
      target: 'system',
    })
    expect(invokeDesktopHostMock).not.toHaveBeenCalled()
  })

  test('keeps desktop consent inside the app window', async () => {
    isElectronRuntimeMock.mockReturnValue(true)
    vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => 'req-1' })
    const unsubscribe = vi.fn()
    subscribeDesktopHostEventsMock.mockReturnValue(unsubscribe)

    const handle = await openCloudAuthorizationWindow('https://example.com/auth')

    expect(invokeDesktopHostMock).toHaveBeenCalledWith('auth.openConnectorAuthorization', {
      url: 'https://example.com/auth',
      requestId: 'req-1',
    })
    expect(openExternalUrlMock).not.toHaveBeenCalled()
    // Nothing holds a long-lived host request that could time out mid-consent.
    expect(invokeDesktopHostMock).toHaveBeenCalledTimes(1)
    expect(subscribeDesktopHostEventsMock).toHaveBeenCalledTimes(1)
    expect(handle?.closed).toBeInstanceOf(Promise)

    const listener = subscribeDesktopHostEventsMock.mock.calls[0][0]
    listener({ sequence: 1, type: 'connectorAuthorization.closed', payload: { requestId: 'x' } })
    let settled = false
    void handle?.closed?.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    listener({
      sequence: 2,
      type: 'connectorAuthorization.closed',
      payload: { requestId: 'req-1' },
    })
    await expect(handle?.closed).resolves.toBeUndefined()
    expect(unsubscribe).toHaveBeenCalledTimes(1)

    invokeDesktopHostMock.mockResolvedValueOnce({ open: false })
    await expect(handle?.isOpen?.()).resolves.toBe(false)
    expect(invokeDesktopHostMock).toHaveBeenCalledWith('auth.getConnectorAuthorizationState', {
      requestId: 'req-1',
    })

    // Closing is scoped to this attempt so a failed attempt cannot close
    // another one's consent window.
    await handle?.close?.()
    expect(invokeDesktopHostMock).toHaveBeenCalledWith('auth.closeConnectorAuthorization', {
      requestId: 'req-1',
    })
  })
})
