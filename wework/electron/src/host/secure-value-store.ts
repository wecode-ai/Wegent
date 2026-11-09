import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { HostCapabilityError } from './capability-router.js'
import { systemSecretProtection, type SecretProtection } from './secret-protection.js'

interface StoredValues {
  version: 2 | 3
  values: Record<string, string>
}

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16
const ENVELOPE_VERSION = 1

export class SecureValueStore {
  private operation = Promise.resolve()
  private keyPromise: Promise<Buffer> | null = null

  constructor(
    private readonly dataDirectory: string,
    private readonly protection: SecretProtection = systemSecretProtection
  ) {}

  get(key: string): Promise<string | null> {
    validateKey(key)
    return this.serial(async () => {
      const stored = await this.read()
      if (!Object.hasOwn(stored.values, key)) return null
      return stored.version === 3
        ? this.protection.decrypt(stored.values[key])
        : this.decrypt(
            stored.values[key],
            await readFile(join(this.dataDirectory, 'secure-values.key'))
          )
    })
  }

  set(key: string, value: string): Promise<void> {
    validateKey(key)
    return this.serial(async () => {
      const stored = await this.read()
      stored.values[key] =
        stored.version === 3
          ? await this.protection.encrypt(value)
          : this.encrypt(
              value,
              Object.keys(stored.values).length
                ? await readFile(join(this.dataDirectory, 'secure-values.key'))
                : await this.encryptionKey()
            )
      await this.write(stored)
    })
  }

  delete(key: string): Promise<void> {
    validateKey(key)
    return this.serial(async () => {
      const stored = await this.read()
      if (!Object.hasOwn(stored.values, key)) return
      delete stored.values[key]
      if (stored.version === 2 && Object.keys(stored.values).length === 0) {
        await rm(this.path(), { force: true })
        return
      }
      // Keep an empty v3 store so rollback cannot downgrade subsequent writes.
      await this.write(stored)
    })
  }

  private encrypt(value: string, key: Buffer): string {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, key, iv)
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.concat([
      Buffer.from([ENVELOPE_VERSION]),
      iv,
      cipher.getAuthTag(),
      encrypted,
    ]).toString('base64')
  }

  private decrypt(value: string, key: Buffer): string {
    try {
      const envelope = Buffer.from(value, 'base64')
      const minimumBytes = 1 + IV_BYTES + AUTH_TAG_BYTES
      if (envelope.length < minimumBytes || envelope[0] !== ENVELOPE_VERSION) {
        throw new Error('Invalid encrypted value envelope')
      }
      const ivStart = 1
      const authTagStart = ivStart + IV_BYTES
      const encryptedStart = authTagStart + AUTH_TAG_BYTES
      const decipher = createDecipheriv(ALGORITHM, key, envelope.subarray(ivStart, authTagStart))
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

  private async read(): Promise<StoredValues> {
    try {
      const stored = JSON.parse(await readFile(this.path(), 'utf8')) as StoredValues
      if (
        ![2, 3].includes(stored.version) ||
        !stored.values ||
        typeof stored.values !== 'object' ||
        Array.isArray(stored.values) ||
        Object.values(stored.values).some(value => typeof value !== 'string')
      ) {
        throw new HostCapabilityError('secure_storage_corrupted', 'Invalid encrypted storage')
      }
      if (stored.version === 3) {
        await rm(join(this.dataDirectory, 'secure-values.key'), { force: true })
      }
      return { ...stored, values: Object.assign(Object.create(null), stored.values) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 2, values: Object.create(null) }
      }
      throw error
    }
  }

  private async write(stored: StoredValues): Promise<void> {
    const path = this.path()
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
    await chmod(path, 0o600)
  }

  private path(): string {
    return join(this.dataDirectory, 'secure-values.json')
  }

  private encryptionKey(): Promise<Buffer> {
    this.keyPromise ??= this.readOrCreateEncryptionKey()
    return this.keyPromise
  }

  private async readOrCreateEncryptionKey(): Promise<Buffer> {
    const path = join(this.dataDirectory, 'secure-values.key')
    try {
      const key = await readFile(path)
      if (key.length !== KEY_BYTES) {
        throw new HostCapabilityError(
          'secure_storage_corrupted',
          'Encrypted local storage key is invalid'
        )
      }
      await chmod(path, 0o600)
      return key
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const key = randomBytes(KEY_BYTES)
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(temporary, key, { flag: 'wx', mode: 0o600 })
      await rename(temporary, path)
      await chmod(path, 0o600)
      return key
    } finally {
      await rm(temporary, { force: true })
    }
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
