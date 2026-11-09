import { HostCapabilityError } from './capability-router.js'

export interface SecretProtection {
  encrypt(value: string): Promise<string>
  decrypt(value: string): Promise<string>
}

/** Keep encryption keys in the operating system credential service, never beside ciphertext. */
async function nativeStorage() {
  const { safeStorage } = await import('electron')
  if (
    !safeStorage.isEncryptionAvailable() ||
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
    return (await nativeStorage()).encryptString(value).toString('base64')
  },
  async decrypt(value) {
    return (await nativeStorage()).decryptString(Buffer.from(value, 'base64'))
  },
}
