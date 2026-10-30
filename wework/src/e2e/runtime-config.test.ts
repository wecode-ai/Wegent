import { createElement } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CloudConnectionProvider } from '@/features/cloud-connection/CloudConnectionProvider'
import { useCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { runDesktopControlClient, seedDesktopE2ERuntime } from './automation'
import {
  getDesktopE2ERuntimeConfig,
  loadDesktopE2ERuntimeConfig,
  setDesktopE2ECloudSessionToken,
} from './runtime-config'

beforeEach(async () => {
  window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__ = {
    cloudBackendUrl: 'https://cloud.example',
    cloudToken: 'owner-token',
    controlUrl: 'http://127.0.0.1:43111',
  }
  await loadDesktopE2ERuntimeConfig()
})

afterEach(async () => {
  cleanup()
  window.sessionStorage.clear()
  window.localStorage.removeItem('wework.cloudConnection')
  delete window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__
  await loadDesktopE2ERuntimeConfig()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function CloudIdentity() {
  const cloud = useCloudConnection()
  return createElement('span', { 'data-testid': 'cloud-user-id' }, cloud.user?.id)
}

describe('desktop E2E account session reuse', () => {
  test('retains the selected account across renderer configuration reloads only', async () => {
    setDesktopE2ECloudSessionToken('recipient-token')
    await loadDesktopE2ERuntimeConfig()

    expect(getDesktopE2ERuntimeConfig()).toEqual({
      cloudBackendUrl: 'https://cloud.example',
      cloudToken: 'recipient-token',
      controlUrl: 'http://127.0.0.1:43111',
    })
    expect(window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__?.cloudToken).toBe('owner-token')
    window.sessionStorage.clear()
    expect(getDesktopE2ERuntimeConfig().cloudToken).toBe('owner-token')
  })

  test.each([{ controlUrl: undefined }, { disabled: true }])(
    'ignores session overrides without an enabled controller: %o',
    async patch => {
      setDesktopE2ECloudSessionToken('recipient-token')
      Object.assign(window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__!, patch)
      await loadDesktopE2ERuntimeConfig()

      expect(getDesktopE2ERuntimeConfig().cloudToken).toBe('owner-token')
      expect(() => setDesktopE2ECloudSessionToken('another-token')).toThrow(
        'requires an active desktop E2E controller'
      )
    }
  )

  test('rejects an empty account token without replacing the selected session', () => {
    setDesktopE2ECloudSessionToken('recipient-token')

    expect(() => setDesktopE2ECloudSessionToken('  ')).toThrow('requires a backend token')
    expect(getDesktopE2ERuntimeConfig().cloudToken).toBe('recipient-token')
  })

  test('resolves the selected account through the normal backend identity request', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 2, user_name: 'recipient' }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    setDesktopE2ECloudSessionToken('recipient-token')

    await seedDesktopE2ERuntime()

    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith(
      'https://cloud.example/api/users/me',
      expect.objectContaining({ headers: { Authorization: 'Bearer recipient-token' } })
    )
    expect(JSON.parse(window.localStorage.getItem('wework.cloudConnection')!).user.id).toBe(2)
  })

  test('propagates rejected account credentials instead of seeding another identity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })))
    setDesktopE2ECloudSessionToken('invalid-token')

    await expect(seedDesktopE2ERuntime()).rejects.toThrow('E2E cloud identity returned 401')
    expect(window.localStorage.getItem('wework.cloudConnection')).toBeNull()
  })

  test('restores each selected identity from native preferences after renderer reload', async () => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    let preferences = {
      cloudConnection: {
        backendUrl: 'https://cloud.example',
        apiBaseUrl: 'https://cloud.example/api',
        socketBaseUrl: 'https://cloud.example',
        socketPath: '/socket.io',
        user: { id: 1, user_name: 'owner' },
        connectedAt: new Date().toISOString(),
      },
    }
    for (const [token, user] of [
      ['recipient-token', { id: 2, user_name: 'recipient' }],
      ['owner-token', { id: 1, user_name: 'owner' }],
    ] as const) {
      let polls = 0
      let nativeReads = 0
      let nativeWriteStarted = false
      let finishNativeWrite!: () => void
      const nativeWrite = new Promise<void>(resolve => {
        finishNativeWrite = resolve
      })
      const results: Array<{ ok: boolean }> = []
      vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
        if (url.includes('/commands?')) {
          return ++polls === 1
            ? Response.json({ id: token, action: 'setCloudSessionToken', value: token })
            : new Response(null, { status: 410 })
        }
        if (url.endsWith('/results')) results.push(JSON.parse(String(options?.body)))
        if (url === '/wework/electron-host/v1/invoke') {
          const request = JSON.parse(String(options?.body))
          if (request.capability === 'preferences.get') nativeReads += 1
          if (request.capability === 'preferences.update') {
            nativeWriteStarted = true
            await nativeWrite
            preferences = { ...preferences, ...request.params.patch }
          }
          return Response.json({ ok: true, result: preferences })
        }
        if (url.endsWith('/users/me')) return Response.json(user)
        return Response.json({ web_url: 'https://cloud.example' })
      })

      const switching = runDesktopControlClient('http://127.0.0.1:43111', 'main')
      await waitFor(() => expect(nativeWriteStarted).toBe(true))
      expect(results).toHaveLength(0)
      finishNativeWrite()
      await switching

      expect(results).toEqual([expect.objectContaining({ ok: true })])
      expect(preferences.cloudConnection.user.id).toBe(user.id)
      expect(preferences.cloudConnection).not.toHaveProperty('token')
      await loadDesktopE2ERuntimeConfig()
      await seedDesktopE2ERuntime()
      const view = render(createElement(CloudConnectionProvider, null, createElement(CloudIdentity)))
      await waitFor(() => expect(nativeReads).toBeGreaterThan(0))
      await waitFor(() =>
        expect(screen.getByTestId('cloud-user-id')).toHaveTextContent(String(user.id))
      )
      expect(JSON.parse(window.localStorage.getItem('wework.cloudConnection')!).user.id).toBe(user.id)
      view.unmount()
    }
  })
})
