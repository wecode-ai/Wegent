import { p256 } from '@noble/curves/nist.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { base64urlnopad } from '@scure/base'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDeviceProof, encodeBase64Url, publicKeyFromPrivate } from './deviceProof'
import { DeviceCredentialService } from './deviceCredentials'

const CREDENTIAL_KEY = 'wegent.mobile.cloud-credentials.v2'
const store = vi.hoisted(() => new Map<string, string>())
const writeGate = vi.hoisted(() => ({
  hangOnToken: null as string | null,
  entered: false,
  release: (): void => undefined,
}))

vi.mock('expo-secure-store', () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    if (writeGate.hangOnToken && value.includes(writeGate.hangOnToken) && !writeGate.entered) {
      writeGate.entered = true
      await new Promise<void>(resolve => {
        writeGate.release = resolve
      })
    }
    store.set(key, value)
  },
  deleteItemAsync: async (key: string) => {
    store.delete(key)
  },
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
}))

vi.mock('expo-crypto', () => ({
  randomUUID: () => 'test-uuid',
  getRandomBytes: (count: number) => new Uint8Array(count).fill(1),
}))

function claimResponse(): Response {
  return new Response(
    JSON.stringify({
      status: 'success',
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      username: 'alice',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

describe('device credentials', () => {
  it('creates the same ES256 device proof required by Wework refresh', () => {
    const privateKey = p256.utils.randomSecretKey(new Uint8Array(48).fill(7))
    const publicKey = publicKeyFromPrivate(privateKey)
    const proof = createDeviceProof(
      privateKey,
      publicKey,
      'refresh-token',
      '/api/auth/wework/refresh',
      1_700_000_000_000,
      'proof-id'
    )
    const [headerPart, payloadPart, signaturePart] = proof.split('.')
    const header = JSON.parse(new TextDecoder().decode(base64urlnopad.decode(headerPart)))
    const payload = JSON.parse(new TextDecoder().decode(base64urlnopad.decode(payloadPart)))

    expect(header).toEqual({ alg: 'ES256', typ: 'dpop+jwt', jwk: publicKey })
    expect(payload).toMatchObject({
      htm: 'POST',
      htu: '/api/auth/wework/refresh',
      iat: 1_700_000_000,
      jti: 'proof-id',
      ath: base64urlnopad.encode(sha256(new TextEncoder().encode('refresh-token'))),
    })
    expect(
      p256.verify(
        base64urlnopad.decode(signaturePart),
        new TextEncoder().encode(`${headerPart}.${payloadPart}`),
        p256.getPublicKey(privateKey),
        { format: 'compact', prehash: true }
      )
    ).toBe(true)
  })
})

describe('DeviceCredentialService serialized storage', () => {
  beforeEach(() => {
    store.clear()
    writeGate.hangOnToken = null
    writeGate.entered = false
    writeGate.release = (): void => undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => claimResponse())
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('claims a session without persisting the refresh credential', async () => {
    const service = new DeviceCredentialService()
    const result = await service.claimAuthorization({
      apiBaseUrl: 'https://example.com/api',
      sessionId: 's1',
      pollToken: 'pt',
    })

    expect(result.status).toBe('success')
    expect(result.accessToken).toBe('access-1')
    expect(result.refreshToken).toBe('refresh-1')
    expect(store.has(CREDENTIAL_KEY)).toBe(false)
  })

  it('persists the refresh credential only through persistRefreshToken', async () => {
    const service = new DeviceCredentialService()
    await service.persistRefreshToken('https://example.com/api', 'refresh-1', () => true)

    const stored = JSON.parse(store.get(CREDENTIAL_KEY) as string)
    expect(stored.apiBaseUrl).toBe('https://example.com/api')
    expect(stored.refreshToken).toBe('refresh-1')
  })

  it('skips the write entirely when the generation is already stale', async () => {
    const service = new DeviceCredentialService()
    await service.persistRefreshToken('https://example.com/api', 'refresh-1', () => false)

    expect(store.has(CREDENTIAL_KEY)).toBe(false)
  })

  it('rolls back the written credential when the generation goes stale during the write', async () => {
    writeGate.hangOnToken = 'refresh-1'
    let valid = true
    const service = new DeviceCredentialService()
    const persist = service.persistRefreshToken('https://example.com/api', 'refresh-1', () => valid)

    await vi.waitFor(() => expect(writeGate.entered).toBe(true))
    valid = false
    writeGate.release()
    await persist

    expect(store.has(CREDENTIAL_KEY)).toBe(false)
  })

  it('stale cleanup never deletes a credential it did not write', async () => {
    const newerKey = p256.utils.randomSecretKey(new Uint8Array(48).fill(9))
    const newerCredential = JSON.stringify({
      version: 2,
      apiBaseUrl: 'https://example.com/api',
      privateKey: encodeBase64Url(newerKey),
      publicKey: publicKeyFromPrivate(newerKey),
      refreshToken: 'refresh-newer',
    })
    const service = new DeviceCredentialService()
    let calls = 0
    const persist = service.persistRefreshToken('https://example.com/api', 'refresh-1', () => {
      calls += 1
      if (calls < 3) return true
      // Simulate a newer credential landing between the stale write and its
      // cleanup; the rollback must leave it in place.
      store.set(CREDENTIAL_KEY, newerCredential)
      return false
    })

    await persist

    const stored = JSON.parse(store.get(CREDENTIAL_KEY) as string)
    expect(stored.refreshToken).toBe('refresh-newer')
  })

  it('keeps the newer valid persist when an older stale persist rolls back', async () => {
    writeGate.hangOnToken = 'refresh-stale'
    let staleValid = true
    const service = new DeviceCredentialService()
    const stale = service.persistRefreshToken(
      'https://example.com/api',
      'refresh-stale',
      () => staleValid
    )
    const valid = service.persistRefreshToken(
      'https://example.com/api',
      'refresh-valid',
      () => true
    )

    await vi.waitFor(() => expect(writeGate.entered).toBe(true))
    staleValid = false
    writeGate.release()
    await Promise.all([stale, valid])

    const stored = JSON.parse(store.get(CREDENTIAL_KEY) as string)
    expect(stored.refreshToken).toBe('refresh-valid')
  })

  it('clears the stored credential', async () => {
    const service = new DeviceCredentialService()
    await service.persistRefreshToken('https://example.com/api', 'refresh-1', () => true)
    await service.clear()

    expect(store.has(CREDENTIAL_KEY)).toBe(false)
  })

  it('linearizes a persisted refresh credential followed by clear', async () => {
    const service = new DeviceCredentialService()
    const persist = service.persistRefreshToken('https://example.com/api', 'refresh-1', () => true)
    const clear = service.clear()
    await Promise.all([persist, clear])

    expect(store.has(CREDENTIAL_KEY)).toBe(false)
  })

  it('does not deadlock concurrent writes and clears', async () => {
    const service = new DeviceCredentialService()
    const writes = Array.from({ length: 10 }, (_, index) =>
      service.persistRefreshToken('https://example.com/api', `refresh-${index}`, () => true)
    )
    const clears = Array.from({ length: 5 }, () => service.clear())

    const results = await Promise.allSettled([...writes, ...clears])
    expect(results.every(result => result.status === 'fulfilled')).toBe(true)
  })

  it('recovers a corrupt stored credential without deadlocking the queue', async () => {
    store.set(CREDENTIAL_KEY, 'not-json')
    const service = new DeviceCredentialService()
    await service.persistRefreshToken('https://example.com/api', 'refresh-1', () => true)

    const stored = JSON.parse(store.get(CREDENTIAL_KEY) as string)
    expect(stored.refreshToken).toBe('refresh-1')
  })
})
