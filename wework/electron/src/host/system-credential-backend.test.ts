import { afterEach, expect, test, vi } from 'vitest'
import { SystemCredentialBackend } from './system-credential-backend.js'

const native = vi.hoisted(() => ({ create: vi.fn(), get: vi.fn(), set: vi.fn(), delete: vi.fn() }))
vi.mock('@napi-rs/keyring', () => ({
  AsyncEntry: class {
    constructor(...args: unknown[]) {
      native.create(...args)
    }
    getSecret() {
      return native.get()
    }
    setSecret(value: Uint8Array) {
      return native.set(value)
    }
    deleteCredential() {
      return native.delete()
    }
  },
}))
afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

test('pins the Linux store and distinguishes missing values from inaccessible storage without leaking errors', async () => {
  const backend = new SystemCredentialBackend('test-service')
  native.get.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('secret-canary'))
  expect(await backend.get('account')).toBeNull()
  expect(native.create).toHaveBeenCalledWith('test-service', 'account', {
    linux: { store: 'secret-service' },
  })
  await expect(backend.get('account')).rejects.toMatchObject({ code: 'secure_storage_unavailable' })
  native.delete.mockResolvedValue(false)
  await expect(backend.delete('missing')).resolves.toBeUndefined()
})

test('an ambiguous timeout prevents every later native operation in this process', async () => {
  vi.useFakeTimers()
  native.set.mockImplementation(() => new Promise(() => {}))
  const backend = new SystemCredentialBackend('test-service')
  const pending = backend.set('account', 'canary')
  const rejected = expect(pending).rejects.toMatchObject({ code: 'secure_storage_unavailable' })
  await vi.advanceTimersByTimeAsync(30_001)
  await rejected
  await expect(backend.get('account')).rejects.toMatchObject({ code: 'secure_storage_unavailable' })
  expect(native.get).not.toHaveBeenCalled()
})

test('stores explicit UTF-8 bytes and preserves Unicode without relying on platform password encoding', async () => {
  const backend = new SystemCredentialBackend('test-service')
  const value = '凭据 · 🔑'
  native.set.mockResolvedValue(undefined)
  native.get.mockResolvedValue([...Buffer.from(value)])
  await backend.set('account', value)
  expect(native.set).toHaveBeenCalledWith(Buffer.from(value, 'utf8'))
  expect(await backend.get('account')).toBe(value)
  native.get.mockResolvedValue([255])
  await expect(backend.get('account')).rejects.toMatchObject({ code: 'secure_storage_unavailable' })
})
