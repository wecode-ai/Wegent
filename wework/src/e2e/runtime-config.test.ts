import { createElement, useEffect } from 'react'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { CloudConnectionProvider } from '@/features/cloud-connection/CloudConnectionProvider'
import { useCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { runDesktopControlClient, seedDesktopE2ERuntime } from './automation'
import {
  getDesktopE2ERuntimeConfig,
  loadDesktopE2ERuntimeConfig,
  setDesktopE2ECloudSessionToken,
  DESKTOP_E2E_CLOUD_SESSION_CHANGED_EVENT,
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
  test('switches the mounted provider in both directions and ignores the previous account refresh', async () => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    let preferences: Record<string, unknown> = {}
    let pendingCommand: string | null = null
    const previousRefresh = Promise.withResolvers<Response>()
    let holdOwnerRefresh = false
    let ownerRefreshStarted = false
    let mounts = 0
    function MountedIdentity() {
      useEffect(() => {
        mounts += 1
      }, [])
      return createElement(CloudIdentity)
    }
    vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
      if (url.includes('/commands?')) {
        const token = pendingCommand
        pendingCommand = null
        return token
          ? Response.json({ id: token, action: 'setCloudSessionToken', value: token })
          : new Response(null, { status: 410 })
      }
      if (url === '/wework/electron-host/v1/invoke') {
        const request = JSON.parse(String(options?.body))
        if (request.capability === 'preferences.update') {
          preferences = { ...preferences, ...request.params.patch }
        }
        return Response.json({ ok: true, result: preferences })
      }
      if (url.endsWith('/users/me')) {
        const recipient =
          (options?.headers as Record<string, string>).Authorization === 'Bearer recipient-token'
        if (!recipient && holdOwnerRefresh) {
          ownerRefreshStarted = true
          return previousRefresh.promise
        }
        return Response.json({
          id: recipient ? 2 : 1,
          user_name: recipient ? 'recipient' : 'owner',
        })
      }
      return Response.json({ web_url: 'https://cloud.example' })
    })
    await seedDesktopE2ERuntime()
    const initialConnection = {
      ...(preferences.cloudConnection as Record<string, unknown>),
      credentialMode: 'legacy_access_token',
      token: 'owner-token',
    }
    preferences.cloudConnection = initialConnection
    window.localStorage.setItem('wework.cloudConnection', JSON.stringify(initialConnection))
    holdOwnerRefresh = true
    render(createElement(CloudConnectionProvider, null, createElement(MountedIdentity)))
    await waitFor(() => expect(ownerRefreshStarted).toBe(true))
    expect(screen.getByTestId('cloud-user-id')).toHaveTextContent('1')

    pendingCommand = 'recipient-token'
    await runDesktopControlClient('http://127.0.0.1:43111', 'main')
    await waitFor(() => expect(screen.getByTestId('cloud-user-id')).toHaveTextContent('2'))
    await act(async () => {
      previousRefresh.resolve(Response.json({ id: 1, user_name: 'owner' }))
      await previousRefresh.promise
    })
    expect(screen.getByTestId('cloud-user-id')).toHaveTextContent('2')

    holdOwnerRefresh = false
    pendingCommand = 'owner-token'
    await runDesktopControlClient('http://127.0.0.1:43111', 'main')
    await waitFor(() => expect(screen.getByTestId('cloud-user-id')).toHaveTextContent('1'))
    expect(mounts).toBe(1)
    expect((preferences.cloudConnection as { user: { id: number } }).user.id).toBe(1)
  })

  test.each([false, true])(
    'ignores live session events outside an active controller (E2E=%s)',
    async e2e => {
      vi.stubEnv('VITE_WEWORK_E2E', String(e2e))
      const connection = {
        backendUrl: 'https://cloud.example',
        apiBaseUrl: 'https://cloud.example/api',
        socketBaseUrl: 'https://cloud.example',
        socketPath: '/socket.io',
        credentialMode: 'legacy_access_token',
        token: 'owner-token',
        user: { id: 1, user_name: 'owner' },
        connectedAt: new Date().toISOString(),
      }
      window.localStorage.setItem('wework.cloudConnection', JSON.stringify(connection))
      vi.stubGlobal('fetch', async (url: string) =>
        url === '/wework/electron-host/v1/invoke'
          ? Response.json({ ok: true, result: { cloudConnection: connection } })
          : Response.json({ ...connection.user, web_url: connection.backendUrl })
      )
      render(createElement(CloudConnectionProvider, null, createElement(CloudIdentity)))
      await waitFor(() => expect(screen.getByTestId('cloud-user-id')).toHaveTextContent('1'))
      setDesktopE2ECloudSessionToken('recipient-token')
      window.localStorage.setItem(
        'wework.cloudConnection',
        JSON.stringify({ ...connection, user: { id: 2 } })
      )
      if (e2e) window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__!.disabled = true
      await act(async () => {
        window.dispatchEvent(new Event(DESKTOP_E2E_CLOUD_SESSION_CHANGED_EVENT))
      })
      expect(screen.getByTestId('cloud-user-id')).toHaveTextContent('1')
    }
  )

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
      .mockResolvedValueOnce(Response.json({ ok: true, result: {} }))
      .mockResolvedValueOnce(Response.json({ id: 2, user_name: 'recipient' }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: {} }))
    vi.stubGlobal('fetch', fetch)
    setDesktopE2ECloudSessionToken('recipient-token')

    await seedDesktopE2ERuntime()

    expect(fetch).toHaveBeenCalledTimes(3)
    expect(fetch).toHaveBeenCalledWith(
      'https://cloud.example/api/users/me',
      expect.objectContaining({ headers: { Authorization: 'Bearer recipient-token' } })
    )
    expect(JSON.parse(window.localStorage.getItem('wework.cloudConnection')!).user.id).toBe(2)
  })

  test.each(['https://cloud.example', 'https://restored.example'])(
    'restores the native profile %s with the process-selected identity',
    async backendUrl => {
      vi.stubEnv('VITE_WEWORK_E2E', 'true')
      window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__!.cloudToken = 'recipient-token'
      let preferences = {
        cloudConnection: {
          backendUrl,
          apiBaseUrl: `${backendUrl}/api`,
          socketBaseUrl: 'https://socket.example',
          socketBaseUrlOverride: 'https://socket.example',
          socketPath: '/socket.io',
          user: { id: 1, user_name: 'owner' },
          connectedAt: new Date().toISOString(),
        },
      }
      let nativeReads = 0
      vi.stubGlobal('fetch', async (url: string, options?: RequestInit) => {
        if (url.endsWith('/users/me')) {
          expect(url).toBe(`${backendUrl}/api/users/me`)
          expect(options?.headers).toEqual({ Authorization: 'Bearer recipient-token' })
          return Response.json({ id: 3, user_name: 'recipient' })
        }
        if (url === '/wework/electron-host/v1/invoke') {
          const request = JSON.parse(String(options?.body))
          if (request.capability === 'preferences.update')
            preferences = { ...preferences, ...request.params.patch }
          if (request.capability === 'preferences.get') nativeReads += 1
          return Response.json({ ok: true, result: preferences })
        }
        return Response.json({ web_url: 'https://cloud.example' })
      })

      await seedDesktopE2ERuntime()
      const readsBeforeMount = nativeReads
      render(createElement(CloudConnectionProvider, null, createElement(CloudIdentity)))

      await waitFor(() => expect(nativeReads).toBeGreaterThan(readsBeforeMount))
      expect(preferences.cloudConnection.user.id).toBe(3)
      expect(preferences.cloudConnection.backendUrl).toBe(backendUrl)
      expect(preferences.cloudConnection.socketBaseUrlOverride).toBe('https://socket.example')
      expect(preferences.cloudConnection).not.toHaveProperty('token')
      await waitFor(() => expect(screen.getByTestId('cloud-user-id')).toHaveTextContent('3'))
      expect(JSON.parse(window.localStorage.getItem('wework.cloudConnection')!).user.id).toBe(3)
    }
  )

  test('propagates a native preference write failure before exposing the seeded identity', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ ok: true, result: {} }))
        .mockResolvedValueOnce(Response.json({ id: 3, user_name: 'recipient' }))
        .mockRejectedValueOnce(new Error('Native preferences unavailable'))
    )

    await expect(seedDesktopE2ERuntime()).rejects.toThrow('Native preferences unavailable')
    expect(window.localStorage.getItem('wework.cloudConnection')).toBeNull()
  })

  test('propagates rejected account credentials instead of seeding another identity', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({ ok: true, result: {} }))
        .mockResolvedValueOnce(new Response('{}', { status: 401 }))
    )
    setDesktopE2ECloudSessionToken('invalid-token')

    await expect(seedDesktopE2ERuntime()).rejects.toThrow('E2E cloud identity returned 401')
    expect(window.localStorage.getItem('wework.cloudConnection')).toBeNull()
  })

  test('restores each selected identity from native preferences after renderer reload', async () => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    let preferences = {
      cloudConnection: {
        backendUrl: 'https://previous.example',
        apiBaseUrl: 'https://previous.example/api',
        socketBaseUrl: 'https://previous.example',
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
      expect(preferences.cloudConnection.backendUrl).toBe('https://cloud.example')
      expect(preferences.cloudConnection).not.toHaveProperty('token')
      await loadDesktopE2ERuntimeConfig()
      await seedDesktopE2ERuntime()
      const view = render(
        createElement(CloudConnectionProvider, null, createElement(CloudIdentity))
      )
      await waitFor(() => expect(nativeReads).toBeGreaterThan(0))
      await waitFor(() =>
        expect(screen.getByTestId('cloud-user-id')).toHaveTextContent(String(user.id))
      )
      expect(JSON.parse(window.localStorage.getItem('wework.cloudConnection')!).user.id).toBe(
        user.id
      )
      view.unmount()
    }
  })
})
