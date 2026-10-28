import { beforeEach, describe, expect, test, vi } from 'vitest'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { openExternalUrl } from './external-links'
import { isElectronRuntime } from './runtime-environment'
import { openCloudAuthorizationWindow } from './cloud-authorization-window'

vi.mock('./external-links', async importOriginal => ({
  ...(await importOriginal<typeof import('./external-links')>()),
  openExternalUrl: vi.fn(),
}))
vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: vi.fn(async () => undefined) }))
vi.mock('./runtime-environment', async importOriginal => ({
  ...(await importOriginal<typeof import('./runtime-environment')>()),
  isElectronRuntime: vi.fn(() => false),
}))

const openExternalUrlMock = vi.mocked(openExternalUrl)
const invokeDesktopHostMock = vi.mocked(invokeDesktopHost)
const isElectronRuntimeMock = vi.mocked(isElectronRuntime)

describe('openCloudAuthorizationWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    openExternalUrlMock.mockResolvedValue(true)
    isElectronRuntimeMock.mockReturnValue(false)
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
    let release: () => void = () => {}
    invokeDesktopHostMock.mockReturnValue(
      new Promise<void>(resolve => {
        release = resolve
      }) as never
    )

    const handle = await openCloudAuthorizationWindow('https://example.com/auth')

    expect(invokeDesktopHostMock).toHaveBeenCalledWith('auth.openConnectorAuthorization', {
      url: 'https://example.com/auth',
    })
    expect(openExternalUrlMock).not.toHaveBeenCalled()
    // The caller keeps polling while the consent window is open.
    expect(handle?.closed).toBeInstanceOf(Promise)
    release()
    await expect(handle?.closed).resolves.toBeUndefined()
  })
})
