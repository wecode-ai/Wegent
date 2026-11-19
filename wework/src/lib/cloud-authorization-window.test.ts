// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { invokeDesktopHost, subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import { openExternalUrl } from './external-links'
import { openCloudAuthorizationWindow } from './cloud-authorization-window'

vi.mock('./external-links', async importOriginal => ({
  ...(await importOriginal<typeof import('./external-links')>()),
  openExternalUrl: vi.fn(),
}))
vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: vi.fn(),
  subscribeDesktopHostEvents: vi.fn(),
}))

const runtime = vi.hoisted(() => ({ electron: false }))
vi.mock('./runtime-environment', () => ({ isElectronRuntime: () => runtime.electron }))

describe('openCloudAuthorizationWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(openExternalUrl).mockResolvedValue(true)
  })

  describe.each([false, true])('Electron runtime: %s', electron => {
    beforeEach(() => {
      runtime.electron = electron
    })

    test.each([
      'http://192.168.1.40:3000/auth/wework/authorize?session_id=session-1',
      'http://cloud.internal:3000/auth/wework/authorize',
      'http://localhost:3000/auth/wework/authorize',
      'https://cloud.example/auth/wework/authorize',
    ])('opens cloud authorization in the system browser at %s', async url => {
      await expect(openCloudAuthorizationWindow(url)).resolves.toBeUndefined()

      expect(openExternalUrl).toHaveBeenCalledWith(url, { target: 'system' })
      expect(invokeDesktopHost).not.toHaveBeenCalled()
      expect(subscribeDesktopHostEvents).not.toHaveBeenCalled()
    })

    test.each(['file:///tmp/auth.html', 'javascript:alert(1)', 'data:text/html,auth', 'not a url'])(
      'rejects unsafe authorization URL %s',
      async url => {
        await expect(openCloudAuthorizationWindow(url)).resolves.toBeUndefined()

        expect(openExternalUrl).not.toHaveBeenCalled()
        expect(invokeDesktopHost).not.toHaveBeenCalled()
      }
    )
  })
})
