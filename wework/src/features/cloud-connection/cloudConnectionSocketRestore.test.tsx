import { useEffect } from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudConnectionProvider } from './CloudConnectionProvider'
import { saveStoredCloudConnection } from './cloudConnectionStorage'
import { useCloudConnection } from './useCloudConnection'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  getPreferences: vi.fn(),
  updatePreferences: vi.fn(),
  refreshAccessToken: vi.fn(),
}))

vi.mock('@/api/http', async importOriginal => ({
  ...(await importOriginal<typeof import('@/api/http')>()),
  createHttpClient: () => ({ get: mocks.get }),
}))

vi.mock('@/desktop/appPreferences', async importOriginal => ({
  ...(await importOriginal<typeof import('@/desktop/appPreferences')>()),
  getAppPreferences: mocks.getPreferences,
  updateAppPreferences: mocks.updatePreferences,
}))

vi.mock('@/desktop/cloudCredentials', async importOriginal => ({
  ...(await importOriginal<typeof import('@/desktop/cloudCredentials')>()),
  refreshDesktopCloudAccessToken: mocks.refreshAccessToken,
}))

function SocketProbe({ observe }: { observe: (url: string) => void }) {
  const cloud = useCloudConnection()
  useEffect(() => {
    if (cloud.isConnected && cloud.socketBaseUrl) observe(cloud.socketBaseUrl)
  }, [cloud.isConnected, cloud.socketBaseUrl, observe])
  return null
}

describe('restoring the resolved cloud Socket address', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.clear()
    mocks.updatePreferences.mockResolvedValue(undefined)
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    ['localStorage', 'legacy_access_token'],
    ['localStorage', 'desktop_refresh'],
    ['desktop preferences', 'legacy_access_token'],
    ['desktop preferences', 'desktop_refresh'],
  ] as const)(
    'preserves the resolved address from %s with %s credentials until metadata changes it',
    async (source, credentialMode) => {
      const token = `header.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`
      const stored = {
        backendUrl: 'http://127.0.0.1:8000',
        apiBaseUrl: 'http://127.0.0.1:8000/api',
        socketBaseUrl: 'http://localhost:9000',
        socketPath: '/socket.io',
        credentialMode,
        token: credentialMode === 'legacy_access_token' ? token : undefined,
        user: { id: 7, user_name: 'alice', email: 'alice@example.com' },
        connectedAt: '2026-10-26T00:00:00.000Z',
      }
      if (source === 'localStorage') saveStoredCloudConnection(stored)
      mocks.getPreferences.mockResolvedValue({
        cloudConnection: source === 'desktop preferences' ? stored : null,
      })
      mocks.refreshAccessToken.mockResolvedValue({
        accessToken: token,
        tokenType: 'bearer',
        expiresIn: 3600,
      })
      let resolveMetadata!: (value: { web_url: string; socket_url: string }) => void
      const metadata = new Promise<{ web_url: string; socket_url: string }>(resolve => {
        resolveMetadata = resolve
      })
      mocks.get.mockImplementation((endpoint: string) => {
        if (endpoint === '/auth/wework/config') return metadata
        if (endpoint === '/users/me') return Promise.resolve(stored.user)
        throw new Error(`Unexpected GET ${endpoint}`)
      })
      const observed: string[] = []
      const observe = (url: string) => observed.push(url)

      render(
        <CloudConnectionProvider>
          <SocketProbe observe={observe} />
        </CloudConnectionProvider>
      )

      await waitFor(() => {
        expect(observed.length).toBeGreaterThan(0)
        expect(mocks.get).toHaveBeenCalledWith('/auth/wework/config', {
          redirectOnUnauthorized: false,
        })
      })
      expect(new Set(observed)).toEqual(new Set([stored.socketBaseUrl]))
      expect(JSON.parse(localStorage.getItem('wework.cloudConnection')!).socketBaseUrl).toBe(
        stored.socketBaseUrl
      )

      // A real server-side address change still replaces the saved resolution.
      await act(async () => {
        resolveMetadata({
          web_url: 'http://127.0.0.1:3000',
          socket_url: 'http://localhost:9001',
        })
        await metadata
      })
      await waitFor(() => expect(observed.at(-1)).toBe('http://localhost:9001'))
      expect(new Set(observed)).toEqual(new Set([stored.socketBaseUrl, 'http://localhost:9001']))
      expect(JSON.parse(localStorage.getItem('wework.cloudConnection')!).socketBaseUrl).toBe(
        'http://localhost:9001'
      )
    }
  )
})
