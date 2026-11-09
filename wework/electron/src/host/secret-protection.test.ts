import { afterEach, expect, test, vi } from 'vitest'
import { systemSecretProtection } from './secret-protection.js'

const storage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
  encryptString: vi.fn((value: string) => Buffer.from(`protected:${value}`)),
  decryptString: vi.fn((value: Buffer) => value.toString().slice('protected:'.length)),
}))
vi.mock('electron', () => ({ safeStorage: storage }))
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  storage.isEncryptionAvailable.mockReturnValue(true)
  storage.getSelectedStorageBackend.mockReturnValue('gnome_libsecret')
})

test('delegates secret protection to the native credential service', async () => {
  const encrypted = await systemSecretProtection.encrypt('private-value')
  expect(storage.encryptString).toHaveBeenCalledWith('private-value')
  await expect(systemSecretProtection.decrypt(encrypted)).resolves.toBe('private-value')
  expect(storage.decryptString).toHaveBeenCalledWith(Buffer.from('protected:private-value'))
})

test('fails without writing a plaintext substitute when OS encryption is unavailable', async () => {
  storage.isEncryptionAvailable.mockReturnValue(false)
  await expect(systemSecretProtection.encrypt('private-value')).rejects.toMatchObject({
    code: 'secure_storage_unavailable',
  })
  await expect(systemSecretProtection.decrypt('ciphertext')).rejects.toMatchObject({
    code: 'secure_storage_unavailable',
  })
  expect(storage.encryptString).not.toHaveBeenCalled()
  expect(storage.decryptString).not.toHaveBeenCalled()
})

test('rejects the Linux basic_text backend', async () => {
  vi.stubGlobal('process', { ...process, platform: 'linux' })
  storage.getSelectedStorageBackend.mockReturnValue('basic_text')
  await expect(systemSecretProtection.encrypt('private-value')).rejects.toMatchObject({
    code: 'secure_storage_unavailable',
  })
  expect(storage.encryptString).not.toHaveBeenCalled()
})
