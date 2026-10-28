import { createDecipheriv } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HostCapabilityError } from './capability-router.js'

export function validateSecureKey(key: string): void {
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(key)) {
    throw new HostCapabilityError('invalid_params', 'Secure storage key is invalid')
  }
}

export function storageCorrupted(): HostCapabilityError {
  return new HostCapabilityError('secure_storage_corrupted', 'Local credentials require recovery')
}

/** Strict, side-effect-free reader used only before the trusted migration commit. */
export async function readLegacySecureValues(directory: string): Promise<Record<string, string>> {
  let source: string
  try {
    source = await readFile(join(directory, 'secure-values.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  try {
    const stored = JSON.parse(source)
    if (
      stored?.version !== 2 ||
      !stored.values ||
      typeof stored.values !== 'object' ||
      Array.isArray(stored.values)
    ) {
      throw storageCorrupted()
    }
    const key = await readFile(join(directory, 'secure-values.key'))
    if (key.length !== 32) throw storageCorrupted()
    const values: Record<string, string> = Object.create(null)
    for (const [name, value] of Object.entries(stored.values)) {
      validateSecureKey(name)
      if (typeof value !== 'string') throw storageCorrupted()
      const envelope = Buffer.from(value, 'base64')
      if (envelope.toString('base64') !== value || envelope.length < 29 || envelope[0] !== 1)
        throw storageCorrupted()
      const decipher = createDecipheriv('aes-256-gcm', key, envelope.subarray(1, 13))
      decipher.setAuthTag(envelope.subarray(13, 29))
      values[name] = Buffer.concat([
        decipher.update(envelope.subarray(29)),
        decipher.final(),
      ]).toString('utf8')
    }
    return values
  } catch {
    throw storageCorrupted()
  }
}
