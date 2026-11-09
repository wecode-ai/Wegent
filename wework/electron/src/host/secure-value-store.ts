import { createDecipheriv, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { HostCapabilityError } from './capability-router.js'
import { systemSecretProtection, type SecretProtection } from './secret-protection.js'

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
      return Object.hasOwn(values, key) ? this.protection.decrypt(values[key]) : null
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
    let source: string
    try {
      source = await readFile(this.path(), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.create(null)
      throw error
    }
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
    if (stored.version === 2) {
      const key = await readFile(join(this.dataDirectory, 'secure-values.key'))
      if (key.length !== 32)
        throw new HostCapabilityError('secure_storage_corrupted', 'Invalid legacy key')
      const protectedValues: Record<string, string> = Object.create(null)
      for (const [name, value] of Object.entries(stored.values)) {
        protectedValues[name] = await this.protection.encrypt(this.decryptLegacy(value, key))
      }
      await this.write(protectedValues)
      await rm(join(this.dataDirectory, 'secure-values.key'), { force: true })
      return protectedValues
    }
    // Reclaim a legacy key left behind by an interrupted successful migration.
    await rm(join(this.dataDirectory, 'secure-values.key'), { force: true })
    return Object.assign(Object.create(null), stored.values)
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
    return join(this.dataDirectory, 'secure-values.json')
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
