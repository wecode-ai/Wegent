import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { SecretProtection } from '../src/host/secret-protection.js'

/** Unit-test substitute for an OS-held key. The key is never persisted to the fixture directory. */
export function createTestSecretProtection(): SecretProtection {
  const key = randomBytes(32)
  return {
    async encrypt(value) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
    },
    async decrypt(value) {
      const data = Buffer.from(value, 'base64')
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
      cipher.setAuthTag(data.subarray(12, 28))
      return {
        result: Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'),
        shouldReEncrypt: false,
      }
    },
  }
}
