import { HostCapabilityError } from './capability-router.js'

export interface SecretProtection {
  encrypt(value: string): Promise<string>
  decrypt(value: string): Promise<string>
}

/** Keep encryption keys in the operating system credential service, never beside ciphertext. */
async function nativeStorage() {
  const { safeStorage } = await import('electron')
  if (
    !(await safeStorage.isAsyncEncryptionAvailable()) ||
    (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
  ) {
    throw new HostCapabilityError(
      'secure_storage_unavailable',
      'OS credential storage is unavailable'
    )
  }
  return safeStorage
}

export const systemSecretProtection: SecretProtection = {
  async encrypt(value) {
    const storage = await nativeStorage()
    return (await storage.encryptStringAsync(value)).toString('base64')
  },
  async decrypt(value) {
    const storage = await nativeStorage()
    return (await storage.decryptStringAsync(Buffer.from(value, 'base64'))).result
  },
}
