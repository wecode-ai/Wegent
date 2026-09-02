import { p256 } from '@noble/curves/nist.js'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useWegentAuth, type WegentAuthState } from './useWegentAuth'
import { encodeBase64Url, publicKeyFromPrivate } from './deviceProof'

// React 19 requires the act environment flag for async act() flushing.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CREDENTIAL_KEY = 'wegent.mobile.cloud-credentials.v2'
const BACKEND_INPUT = 'https://example.com'
const API_BASE = 'https://example.com/api'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const harness = vi.hoisted(() => ({
  secureStore: new Map<string, string>(),
  secureStoreWriteGate: {
    hangOnToken: null as string | null,
    entered: false,
    release: (): void => undefined,
  },
  backendAddress: { current: 'https://example.com' },
  fetchState: {
    usersMeCalls: 0,
    claimCalls: 0,
    usersMeDeferred: null as Deferred<Response> | null,
    claimDeferred: null as Deferred<Response> | null,
  },
}))

vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => harness.secureStore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    const gate = harness.secureStoreWriteGate
    if (gate.hangOnToken && value.includes(gate.hangOnToken) && !gate.entered) {
      gate.entered = true
      await new Promise<void>(resolve => {
        gate.release = resolve
      })
    }
    harness.secureStore.set(key, value)
  },
  deleteItemAsync: async (key: string) => {
    harness.secureStore.delete(key)
  },
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
}))

vi.mock('expo-crypto', () => ({
  randomUUID: () => 'test-uuid',
  getRandomBytes: (count: number) => new Uint8Array(count).fill(1),
}))

vi.mock('expo-web-browser', () => ({
  openBrowserAsync: vi.fn(async () => undefined),
  dismissBrowser: vi.fn(),
  WebBrowserPresentationStyle: { FORM_SHEET: 'formSheet' },
}))

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: () => ({ remove: () => undefined }),
  },
}))

vi.mock('@/services/backendAddressStore', () => ({
  loadBackendAddress: async () => harness.backendAddress.current,
  saveBackendAddress: async () => undefined,
}))

function mockFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input)
      if (url.includes('/auth/wework/config')) {
        return json({ web_url: 'https://web.example.com' })
      }
      if (url.includes('/health')) return json({})
      if (url.includes('/auth/wework/sessions/')) {
        harness.fetchState.claimCalls += 1
        if (harness.fetchState.claimDeferred) return harness.fetchState.claimDeferred.promise
        return json({
          status: 'success',
          access_token: 'access-claim',
          refresh_token: 'refresh-claim',
          username: 'alice',
        })
      }
      if (url.includes('/auth/wework/sessions')) {
        return json({
          session_id: 's1',
          poll_token: 'pt',
          authorize_url: 'https://auth.example.com/authorize',
          web_url: 'https://web.example.com',
          expires_at: 4_102_444_800,
          poll_interval_seconds: 0.5,
        })
      }
      if (url.includes('/auth/wework/refresh')) {
        return json({ access_token: 'access-refresh', token_type: 'Bearer', expires_in: 3600 })
      }
      if (url.includes('/users/me')) {
        harness.fetchState.usersMeCalls += 1
        if (harness.fetchState.usersMeDeferred) return harness.fetchState.usersMeDeferred.promise
        return json({ id: 1, user_name: 'alice' })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
  )
}

function seedCredential(): void {
  const privateKey = p256.utils.randomSecretKey(new Uint8Array(48).fill(3))
  harness.secureStore.set(
    CREDENTIAL_KEY,
    JSON.stringify({
      version: 2,
      apiBaseUrl: API_BASE,
      privateKey: encodeBase64Url(privateKey),
      publicKey: publicKeyFromPrivate(privateKey),
      refreshToken: 'refresh-seed',
    })
  )
}

let latest: WegentAuthState | null = null
let root: ReturnType<typeof create> | null = null

function Harness() {
  latest = useWegentAuth()
  return null
}

async function renderHook(): Promise<void> {
  await act(async () => {
    root = create(<Harness />)
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

async function waitForStatus(
  expected: WegentAuthState['status'],
  timeoutMs = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (latest?.status === expected) return
    await flush()
  }
  throw new Error(`status did not reach ${expected}; got ${latest?.status}`)
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition not met')
}

beforeEach(() => {
  harness.secureStore.clear()
  harness.secureStoreWriteGate.hangOnToken = null
  harness.secureStoreWriteGate.entered = false
  harness.secureStoreWriteGate.release = (): void => undefined
  harness.backendAddress.current = BACKEND_INPUT
  harness.fetchState.usersMeCalls = 0
  harness.fetchState.claimCalls = 0
  harness.fetchState.usersMeDeferred = null
  harness.fetchState.claimDeferred = null
  mockFetch()
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  latest = null
  vi.unstubAllGlobals()
})

describe('auth generation closure', () => {
  it('M1-A: stale refresh continuation cannot restore auth after logout', async () => {
    seedCredential()
    await renderHook()
    await waitForStatus('authenticated')

    const hanging = deferred<Response>()
    harness.fetchState.usersMeDeferred = hanging
    let refreshPromise: Promise<boolean> | undefined
    await act(async () => {
      refreshPromise = latest?.refresh()
    })
    await waitFor(() => harness.fetchState.usersMeCalls === 2)
    expect(latest?.status).toBe('authenticated')

    await act(async () => {
      await latest?.logout()
    })
    expect(latest?.status).toBe('unauthenticated')

    await act(async () => {
      hanging.resolve(json({ id: 1, user_name: 'alice' }))
      await refreshPromise
    })

    expect(latest?.status).toBe('unauthenticated')
    expect(latest?.user).toBeNull()
    expect(latest?.config).toBeNull()
    expect(harness.secureStore.has(CREDENTIAL_KEY)).toBe(false)
  })

  it('M1-B: stale claim continuation cannot authenticate or persist after logout', async () => {
    await renderHook()
    await waitForStatus('unauthenticated')

    const hanging = deferred<Response>()
    harness.fetchState.claimDeferred = hanging
    let loginPromise: Promise<void> | undefined
    await act(async () => {
      loginPromise = latest?.login()
    })
    await waitFor(() => harness.fetchState.claimCalls === 1)

    await act(async () => {
      await latest?.logout()
    })

    await act(async () => {
      hanging.resolve(
        json({
          status: 'success',
          access_token: 'access-claim',
          refresh_token: 'refresh-claim',
          username: 'alice',
        })
      )
      await loginPromise
    })

    expect(latest?.status).not.toBe('authenticated')
    expect(harness.secureStore.has(CREDENTIAL_KEY)).toBe(false)
  })

  it('M1-B2: stale persistence vs backend switch cannot leave a stored credential', async () => {
    await renderHook()
    await waitForStatus('unauthenticated')

    harness.secureStoreWriteGate.hangOnToken = 'refresh-claim'
    let loginPromise: Promise<void> | undefined
    await act(async () => {
      loginPromise = latest?.login()
    })
    await waitFor(() => harness.fetchState.claimCalls === 1)
    await waitFor(() => harness.secureStoreWriteGate.entered)

    await act(async () => {
      latest?.setBackendUrl('https://other.example.com')
    })
    expect(latest?.backendUrl).toBe('https://other.example.com')
    expect(latest?.status).toBe('unauthenticated')

    await act(async () => {
      harness.secureStoreWriteGate.release()
      await loginPromise
    })

    expect(latest?.status).not.toBe('authenticated')
    expect(latest?.user).toBeNull()
    expect(latest?.config).toBeNull()
    expect(latest?.backendUrl).toBe('https://other.example.com')
    const stored = harness.secureStore.get(CREDENTIAL_KEY)
    expect(JSON.parse(stored ?? 'null')?.refreshToken ?? null).not.toBe('refresh-claim')

    await act(async () => {
      root?.unmount()
    })
    root = null
    await renderHook()
    await waitForStatus('unauthenticated')

    expect(harness.fetchState.usersMeCalls).toBe(0)
  })

  it('negative: normal bootstrap restores a stored session', async () => {
    seedCredential()
    await renderHook()
    await waitForStatus('authenticated')

    expect(latest?.user?.user_name).toBe('alice')
    expect(latest?.config?.accessToken).toBe('access-refresh')
    expect(harness.secureStore.has(CREDENTIAL_KEY)).toBe(true)
  })

  it('negative: a same-generation refresh can commit', async () => {
    seedCredential()
    await renderHook()
    await waitForStatus('authenticated')

    let refreshed: boolean | undefined
    await act(async () => {
      refreshed = await latest?.refresh()
    })

    expect(refreshed).toBe(true)
    expect(latest?.status).toBe('authenticated')
    expect(latest?.config?.accessToken).toBe('access-refresh')
  })

  it('negative: normal login authenticates and persists the refresh credential', async () => {
    await renderHook()
    await waitForStatus('unauthenticated')

    let loginPromise: Promise<void> | undefined
    await act(async () => {
      loginPromise = latest?.login()
    })
    await waitFor(() => harness.fetchState.claimCalls === 1)
    await act(async () => {
      await loginPromise
    })
    await waitForStatus('authenticated')

    expect(latest?.config?.accessToken).toBe('access-claim')
    const stored = harness.secureStore.get(CREDENTIAL_KEY)
    expect(stored).not.toBeNull()
    expect(JSON.parse(stored as string).refreshToken).toBe('refresh-claim')
  })

  it('negative: normal logout clears auth and the stored credential', async () => {
    seedCredential()
    await renderHook()
    await waitForStatus('authenticated')

    await act(async () => {
      await latest?.logout()
    })

    expect(latest?.status).toBe('unauthenticated')
    expect(latest?.user).toBeNull()
    expect(latest?.config).toBeNull()
    expect(harness.secureStore.has(CREDENTIAL_KEY)).toBe(false)
  })
})
