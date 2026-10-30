import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { seedDesktopE2ERuntime } from './automation'
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
  window.sessionStorage.clear()
  window.localStorage.removeItem('wework.cloudConnection')
  delete window.__WEWORK_DESKTOP_E2E_RUNTIME_CONFIG__
  await loadDesktopE2ERuntimeConfig()
  vi.unstubAllGlobals()
})

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
})
