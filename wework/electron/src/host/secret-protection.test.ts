import { afterEach, expect, test, vi } from 'vitest'
import { systemSecretProtection } from './secret-protection.js'

const storage = vi.hoisted(() => ({
  isAsyncEncryptionAvailable: vi.fn(async () => true),
  getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
  encryptStringAsync: vi.fn(async (value: string) => Buffer.from(`protected:${value}`)),
  decryptStringAsync: vi.fn(async (value: Buffer) => ({
    result: value.toString().slice('protected:'.length),
    shouldReEncrypt: false,
  })),
}))
vi.mock('electron', () => ({ safeStorage: storage }))
afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

test('delegates secret protection to the native credential service', async () => {
  const encrypted = await systemSecretProtection.encrypt('private-value')
  expect(storage.encryptStringAsync).toHaveBeenCalledWith('private-value')
  await expect(systemSecretProtection.decrypt(encrypted)).resolves.toBe('private-value')
  expect(storage.decryptStringAsync).toHaveBeenCalledWith(Buffer.from('protected:private-value'))
})

test('fails without writing a plaintext substitute when OS encryption is unavailable', async () => {
  storage.isAsyncEncryptionAvailable.mockResolvedValue(false)
  await expect(systemSecretProtection.encrypt('private-value')).rejects.toMatchObject({
    code: 'secure_storage_unavailable',
  })
  await expect(systemSecretProtection.decrypt('ciphertext')).rejects.toMatchObject({
    code: 'secure_storage_unavailable',
  })
  expect(storage.encryptStringAsync).not.toHaveBeenCalled()
  expect(storage.decryptStringAsync).not.toHaveBeenCalled()
})

test('rejects the Linux basic_text backend', async () => {
  vi.stubGlobal('process', { ...process, platform: 'linux' })
  storage.getSelectedStorageBackend.mockReturnValue('basic_text')
  await expect(systemSecretProtection.encrypt('private-value')).rejects.toMatchObject({
    code: 'secure_storage_unavailable',
  })
  expect(storage.encryptStringAsync).not.toHaveBeenCalled()
})

test('keeps the event loop responsive while native authorization is pending', async () => {
  let authorize!: (available: boolean) => void
  storage.isAsyncEncryptionAvailable.mockReturnValue(
    new Promise(resolve => {
      authorize = resolve
    })
  )
  const encryption = systemSecretProtection.encrypt('private-value')
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(storage.encryptStringAsync).not.toHaveBeenCalled()
  authorize(true)
  await expect(encryption).resolves.toBe(Buffer.from('protected:private-value').toString('base64'))
})

test('propagates native protection failures without substituting a weaker format', async () => {
  const error = new Error('Native credential service unavailable')
  storage.encryptStringAsync.mockRejectedValueOnce(error)
  await expect(systemSecretProtection.encrypt('private-value')).rejects.toBe(error)
  storage.decryptStringAsync.mockRejectedValueOnce(error)
  await expect(systemSecretProtection.decrypt('ciphertext')).rejects.toBe(error)
})
