import { beforeEach, describe, expect, test, vi } from 'vitest'
import { openExternalUrl } from './external-links'
import { openCloudAuthorizationWindow } from './cloud-authorization-window'

vi.mock('./external-links', async importOriginal => ({
  ...(await importOriginal<typeof import('./external-links')>()),
  openExternalUrl: vi.fn(),
}))

const openExternalUrlMock = vi.mocked(openExternalUrl)

describe('openCloudAuthorizationWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    openExternalUrlMock.mockResolvedValue(true)
  })

  test('rejects non-http authorization urls', async () => {
    await expect(openCloudAuthorizationWindow('file:///tmp/auth.html')).resolves.toBeUndefined()

    expect(openExternalUrlMock).not.toHaveBeenCalled()
  })

  test('opens authorization in the system browser regardless of link preferences', async () => {
    await expect(openCloudAuthorizationWindow('https://example.com/auth')).resolves.toBeUndefined()

    expect(openExternalUrlMock).toHaveBeenCalledWith('https://example.com/auth', {
      target: 'system',
    })
  })
})
