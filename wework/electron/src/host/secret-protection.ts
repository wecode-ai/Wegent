import { HostCapabilityError } from './capability-router.js'

export interface SecretProtection {
  encrypt(value: string): Promise<string>
  decrypt(value: string): Promise<{ result: string; shouldReEncrypt: boolean }>
}

function requireProtectedCiphertext(value: Buffer): Buffer {
  // Linux's v10 provider uses a public fixed key if its secret service is unavailable.
  if (process.platform === 'linux' && value.subarray(0, 3).toString() === 'v10') {
    throw new HostCapabilityError(
      'secure_storage_unavailable',
      'OS credential storage is unavailable'
    )
  }
  return value
}

/** Keep encryption keys in the operating system credential service, never beside ciphertext. */
async function nativeStorage() {
  const { safeStorage } = await import('electron')
  if (
    !(await observeNativeStorage('availability', () => safeStorage.isAsyncEncryptionAvailable())) ||
    (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')
  ) {
    throw new HostCapabilityError(
      'secure_storage_unavailable',
      'OS credential storage is unavailable'
    )
  }
  return safeStorage
}

/** Identify a stalled OS operation without logging credentials or changing its outcome. */
async function observeNativeStorage<T>(operation: string, action: () => Promise<T>): Promise<T> {
  const started = Date.now()
  const report = (status: string) =>
    console.info('[secret-protection]', { operation, status, elapsedMs: Date.now() - started })
  const pending = setTimeout(() => report('pending'), 1_000)
  pending.unref()
  let status = 'failed'
  try {
    const result = await action()
    status = 'completed'
    return result
  } finally {
    clearTimeout(pending)
    if (Date.now() - started >= 1_000) report(status)
  }
}

export const systemSecretProtection: SecretProtection = {
  async encrypt(value) {
    const storage = await nativeStorage()
    const encrypted = await observeNativeStorage('encrypt', () => storage.encryptStringAsync(value))
    return requireProtectedCiphertext(encrypted).toString('base64')
  },
  async decrypt(value) {
    const storage = await nativeStorage()
    return observeNativeStorage('decrypt', () =>
      storage.decryptStringAsync(requireProtectedCiphertext(Buffer.from(value, 'base64')))
    )
  },
}
