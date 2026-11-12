import { createDecipheriv, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { HostCapabilityError } from './capability-router.js'
import { systemSecretProtection, type SecretProtection } from './secret-protection.js'
import { protectedCredentialDirectory } from './credential-storage-paths.js'

interface StoredValues {
  version: 2 | 3
  values: Record<string, string>
}

const IV_BYTES = 12
const AUTH_TAG_BYTES = 16
const ENVELOPE_VERSION = 1

export class SecureValueStore {
  private operation = Promise.resolve()
  constructor(
    private readonly dataDirectory: string,
    private readonly protection: SecretProtection = systemSecretProtection
  ) {}

  get(key: string): Promise<string | null> {
    validateKey(key)
    return this.serial(async () => {
      const values = await this.read()
      if (!Object.hasOwn(values, key)) return null
      const decrypted = await this.protection.decrypt(values[key])
      if (decrypted.shouldReEncrypt) {
        values[key] = await this.protection.encrypt(decrypted.result)
        await this.write(values)
      }
      return decrypted.result
    })
  }

  set(key: string, value: string): Promise<void> {
    validateKey(key)
    return this.serial(async () => {
      const values = await this.read()
      values[key] = await this.protection.encrypt(value)
      await this.write(values)
    })
  }

  delete(key: string): Promise<void> {
    validateKey(key)
    return this.serial(async () => {
      const values = await this.read()
      if (!Object.hasOwn(values, key)) return
      delete values[key]
      // Retain the protected format across clearing, rollback and subsequent writes.
      await this.write(values)
    })
  }

  private decryptLegacy(value: string, key: Buffer): string {
    try {
      const envelope = Buffer.from(value, 'base64')
      const minimumBytes = 1 + IV_BYTES + AUTH_TAG_BYTES
      if (envelope.length < minimumBytes || envelope[0] !== ENVELOPE_VERSION) {
        throw new Error('Invalid encrypted value envelope')
      }
      const ivStart = 1
      const authTagStart = ivStart + IV_BYTES
      const encryptedStart = authTagStart + AUTH_TAG_BYTES
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        envelope.subarray(ivStart, authTagStart)
      )
      decipher.setAuthTag(envelope.subarray(authTagStart, encryptedStart))
      return Buffer.concat([
        decipher.update(envelope.subarray(encryptedStart)),
        decipher.final(),
      ]).toString('utf8')
    } catch {
      throw new HostCapabilityError(
        'secure_storage_corrupted',
        'Encrypted local storage could not be decrypted'
      )
    }
  }

  private async read(): Promise<Record<string, string>> {
    try {
      const stored = this.parse(await readFile(this.path(), 'utf8'))
      if (stored.version !== 3)
        throw new HostCapabilityError('secure_storage_corrupted', 'Invalid protected storage')
      return Object.assign(Object.create(null), stored.values)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return this.importLegacyValues()
  }

  /** Publish the complete protected copy before leaving legacy files to the rollback host. */
  private async importLegacyValues(): Promise<Record<string, string>> {
    let source: string
    try {
      source = await readFile(join(this.dataDirectory, 'secure-values.json'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const values = Object.create(null) as Record<string, string>
      await this.write(values)
      return values
    }
    const stored = this.parse(source)
    const values: Record<string, string> = Object.create(null)
    const key =
      stored.version === 2 ? await readFile(join(this.dataDirectory, 'secure-values.key')) : null
    if (key && key.length !== 32)
      throw new HostCapabilityError('secure_storage_corrupted', 'Invalid legacy key')
    for (const [name, value] of Object.entries(stored.values)) {
      values[name] = key ? await this.protection.encrypt(this.decryptLegacy(value, key)) : value
    }
    await this.write(values)
    return values
  }

  private parse(source: string): StoredValues {
    const stored = JSON.parse(source) as StoredValues
    if (
      ![2, 3].includes(stored.version) ||
      !stored.values ||
      typeof stored.values !== 'object' ||
      Array.isArray(stored.values) ||
      Object.values(stored.values).some(value => typeof value !== 'string')
    ) {
      throw new HostCapabilityError('secure_storage_corrupted', 'Invalid encrypted storage')
    }
    return stored
  }

  private async write(values: Record<string, string>): Promise<void> {
    const path = this.path()
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ version: 3, values } satisfies StoredValues, null, 2)}\n`,
        { mode: 0o600 }
      )
      await rename(temporary, path)
      await chmod(path, 0o600)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  private path(): string {
    return join(protectedCredentialDirectory(this.dataDirectory), 'secure-values.json')
  }

  private serial<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.operation.then(operation, operation)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}

function validateKey(key: string): void {
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(key)) {
    throw new HostCapabilityError('invalid_params', 'Secure storage key is invalid')
  }
}
