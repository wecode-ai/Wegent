import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkbenchMigrationLockAdapter } from '../runtime/workbench-migration-lock.js'
import type { CredentialBackend } from './system-credential-backend.js'
import { durableWrite } from './durable-file.js'
import {
  readLegacySecureValues,
  storageCorrupted,
  validateSecureKey,
} from './legacy-secure-values.js'

interface Generation {
  id: string
  chunks: number
}
interface Control {
  version: 3
  current: Generation | null
  pending: Generation | null
  retired: Generation | null
}
export interface SecureValueStoreOptions {
  backend: CredentialBackend
  acquireLock: WorkbenchMigrationLockAdapter
}
// Base64-encoded chunks remain below Windows Credential Manager's blob limit.
const CHUNK_BYTES = 1_500
const MAX_STORE_BYTES = 16 * 1024 * 1024

/** The OS vault owns values and the commit point. Disk contains only a profile identity. */
export class SecureValueStore {
  private operation: Promise<unknown> = Promise.resolve()
  private assertLock: () => void = () => {
    throw storageCorrupted()
  }

  private get backend(): CredentialBackend {
    const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
      this.assertLock()
      const result = await work()
      this.assertLock()
      return result
    }
    return {
      get: account => guarded(() => this.options.backend.get(account)),
      set: (account, value) => guarded(() => this.options.backend.set(account, value)),
      delete: account => guarded(() => this.options.backend.delete(account)),
    }
  }

  constructor(
    private readonly dataDirectory: string,
    private readonly options: SecureValueStoreOptions
  ) {}

  get(key: string): Promise<string | null> {
    validateSecureKey(key)
    return this.locked(async (_profile, _control, values) => {
      return Object.hasOwn(values, key) ? values[key] : null
    })
  }

  set(key: string, value: string): Promise<void> {
    validateSecureKey(key)
    return this.update(values => {
      values[key] = value
    })
  }

  delete(key: string): Promise<void> {
    validateSecureKey(key)
    return this.update(values => {
      delete values[key]
    })
  }

  clear(): Promise<void> {
    // Keep the trusted root so restored weak files never become authoritative again.
    return this.update(values => {
      for (const key of Object.keys(values)) delete values[key]
    })
  }

  initialize(): Promise<void> {
    return this.locked(async () => {})
  }

  /** Commit related values or recovery intent in one OS-vault generation. */
  update(change: (values: Record<string, string>) => void): Promise<void> {
    return this.locked(async (profile, control, values) => {
      const previous = JSON.stringify(values)
      change(values)
      if (JSON.stringify(values) !== previous) await this.commit(profile, control, values)
    })
  }

  private locked<T>(
    work: (profile: string, control: Control, values: Record<string, string>) => Promise<T>
  ): Promise<T> {
    const next = this.operation.then(async () => {
      await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 })
      const canonical = await realpath(this.dataDirectory)
      const lock = await this.options.acquireLock([join(canonical, 'credential-vault')])
      this.assertLock = () => lock.assertHeld()
      try {
        lock.assertHeld()
        const profile = await this.profile(canonical)
        const { control, values: committed } = await this.recover(profile)
        let values = committed
        if (!control.current) {
          values = await readLegacySecureValues(canonical)
          await this.commit(profile, control, values)
        }
        lock.assertHeld()
        await this.removeLegacyFiles()
        const result = await work(profile, control, values)
        lock.assertHeld()
        return result
      } finally {
        this.assertLock = () => {
          throw storageCorrupted()
        }
        await lock.release()
      }
    })
    this.operation = next.catch(() => {})
    return next
  }

  private async profile(canonical: string): Promise<string> {
    const locator = `profile.${createHash('sha256').update(canonical).digest('hex')}`
    const backend = this.backend
    let identity = await backend.get(locator)
    const path = join(canonical, 'credential-profile.json')
    let saved: string | null = null
    try {
      const file = JSON.parse(await readFile(path, 'utf8'))
      if (file?.version !== 3 || !validId(file.id)) throw storageCorrupted()
      saved = file.id
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (identity && (!validId(identity) || (saved && identity !== saved))) throw storageCorrupted()
    if (!identity) {
      // A copied profile without its OS vault needs explicit recovery, not legacy import.
      if (saved) throw storageCorrupted()
      identity = randomUUID()
      await this.writeControl(identity, { version: 3, current: null, pending: null, retired: null })
      await backend.set(locator, identity)
      if ((await backend.get(locator)) !== identity) throw storageCorrupted()
    }
    if (!saved) await durableWrite(path, JSON.stringify({ version: 3, id: identity }))
    return identity
  }

  private async recover(
    profile: string
  ): Promise<{ control: Control; values: Record<string, string> }> {
    const source = await this.backend.get(`${profile}.control`)
    if (source === null) throw storageCorrupted()
    let control: Control
    try {
      control = JSON.parse(source)
      if (
        control.version !== 3 ||
        !['current', 'pending', 'retired'].every(key => {
          const value = control[key as keyof Control]
          return (
            value === null ||
            (typeof value === 'object' &&
              validId(value.id) &&
              Number.isSafeInteger(value.chunks) &&
              value.chunks > 0 &&
              value.chunks <= Math.ceil(MAX_STORE_BYTES / CHUNK_BYTES))
          )
        })
      )
        throw storageCorrupted()
      const ids = [control.current, control.pending, control.retired]
        .filter(Boolean)
        .map(x => x!.id)
      if (new Set(ids).size !== ids.length) throw storageCorrupted()
    } catch {
      throw storageCorrupted()
    }
    // Validate the committed bytes before deleting any remaining recovery source.
    const values = await this.readValues(profile, control.current)
    await this.removeGeneration(profile, control.pending)
    await this.removeGeneration(profile, control.retired)
    if (control.pending || control.retired) {
      control.pending = control.retired = null
      await this.writeControl(profile, control)
    }
    return { control, values }
  }

  private async readValues(
    profile: string,
    generation: Generation | null
  ): Promise<Record<string, string>> {
    if (!generation) return Object.create(null) as Record<string, string>
    const parts: Buffer[] = []
    for (let index = 0; index < generation.chunks; index++) {
      const part = await this.backend.get(`${profile}.${generation.id}.${index}`)
      if (part === null) throw storageCorrupted()
      const bytes = Buffer.from(part, 'base64')
      if (bytes.length > CHUNK_BYTES || bytes.toString('base64') !== part) throw storageCorrupted()
      parts.push(bytes)
    }
    try {
      const parsed = JSON.parse(Buffer.concat(parts).toString('utf8'))
      if (
        parsed?.version !== 3 ||
        !parsed.values ||
        typeof parsed.values !== 'object' ||
        Array.isArray(parsed.values)
      )
        throw storageCorrupted()
      for (const [key, value] of Object.entries(parsed.values)) {
        validateSecureKey(key)
        if (typeof value !== 'string') throw storageCorrupted()
      }
      return Object.assign(Object.create(null), parsed.values) as Record<string, string>
    } catch {
      throw storageCorrupted()
    }
  }

  private async commit(
    profile: string,
    control: Control,
    values: Record<string, string>
  ): Promise<void> {
    for (const [key, value] of Object.entries(values)) {
      validateSecureKey(key)
      if (typeof value !== 'string') throw storageCorrupted()
    }
    const bytes = Buffer.from(JSON.stringify({ version: 3, values }))
    if (bytes.length > MAX_STORE_BYTES) throw storageCorrupted()
    const candidate = { id: randomUUID(), chunks: Math.ceil(bytes.length / CHUNK_BYTES) }
    await this.writeControl(profile, { ...control, pending: candidate })
    for (let index = 0; index < candidate.chunks; index++) {
      const account = `${profile}.${candidate.id}.${index}`
      const part = bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString('base64')
      await this.backend.set(account, part)
      if ((await this.backend.get(account)) !== part) throw storageCorrupted()
    }
    const published: Control = {
      version: 3,
      current: candidate,
      pending: null,
      retired: control.current,
    }
    await this.writeControl(profile, published)
    Object.assign(control, published)
    await this.removeGeneration(profile, control.retired)
    control.retired = null
    await this.writeControl(profile, control)
  }

  private async writeControl(profile: string, control: Control): Promise<void> {
    const account = `${profile}.control`
    const source = JSON.stringify(control)
    await this.backend.set(account, source)
    if ((await this.backend.get(account)) !== source) throw storageCorrupted()
  }

  private async removeGeneration(profile: string, generation: Generation | null): Promise<void> {
    if (!generation) return
    for (let index = 0; index < generation.chunks; index++)
      await this.backend.delete(`${profile}.${generation.id}.${index}`)
  }

  private async removeLegacyFiles(): Promise<void> {
    for (const name of await readdir(this.dataDirectory)) {
      if (/^secure-values\.(?:json|key)(?:\.[a-zA-Z0-9.-]+\.tmp)?$/.test(name))
        await rm(join(this.dataDirectory, name), { force: true })
    }
  }
}

function validId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
  )
}
