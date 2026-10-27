import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { removePhysicalRelease } from './physical-release-files.js'

const releaseOperations = new Map<string, Promise<void>>()

export interface DesktopRelease {
  schemaVersion: 1
  id: string
  version: string
  executable: string
  resources: string
  runtimeRoot: string
  profileRoot: string
  dataSchema: number
  readableDataSchemas: number[]
}

export interface ReleaseActivation {
  token: string
  from: string
  to: string
  snapshot: string
  restoreRequired: boolean
  rollbackRequested?: boolean
}

export function releaseId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,159}$/.test(value) || value === '..') {
    throw new Error('Invalid desktop release identifier')
  }
  return value
}

export async function optionalText(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trimEnd()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export async function atomicReleaseWrite(path: string, value: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, value, { mode: 0o600, flush: true })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}

export class ReleaseStore {
  constructor(readonly root: string) {}

  slot(id: string): string {
    return join(this.root, 'slots', releaseId(id))
  }

  async read(id: string): Promise<DesktopRelease> {
    const value = JSON.parse(
      await readFile(join(this.slot(id), 'release.json'), 'utf8')
    ) as DesktopRelease
    if (
      value.schemaVersion !== 1 ||
      value.id !== id ||
      !value.version ||
      !Number.isSafeInteger(value.dataSchema) ||
      !Array.isArray(value.readableDataSchemas) ||
      !value.readableDataSchemas.every(Number.isSafeInteger) ||
      [value.executable, value.resources, value.runtimeRoot, value.profileRoot].some(
        path => typeof path !== 'string' || !isAbsolute(path) || /[\r\n]/.test(path)
      )
    )
      throw new Error('Invalid desktop release descriptor')
    return value
  }

  async save(release: DesktopRelease): Promise<void> {
    await mkdir(this.slot(release.id), { recursive: true, mode: 0o700 })
    await atomicReleaseWrite(join(this.slot(release.id), 'release.json'), JSON.stringify(release))
    await this.read(release.id)
    await atomicReleaseWrite(join(this.slot(release.id), 'executable'), release.executable)
  }

  async active(): Promise<DesktopRelease | null> {
    const id = await optionalText(join(this.root, 'active'))
    return id ? this.read(id) : null
  }

  async activation(): Promise<ReleaseActivation | null> {
    const value = await optionalText(join(this.root, 'activation.json'))
    if (!value) return null
    const activation = JSON.parse(value) as ReleaseActivation
    for (const id of [activation.token, activation.from, activation.to, activation.snapshot])
      releaseId(id)
    if (
      typeof activation.restoreRequired !== 'boolean' ||
      (activation.rollbackRequested !== undefined &&
        typeof activation.rollbackRequested !== 'boolean')
    )
      throw new Error('Invalid release activation')
    return activation
  }

  async activate(next: DesktopRelease, snapshot: string): Promise<void> {
    return this.serial(() => this.activateRelease(next, snapshot))
  }

  private async activateRelease(next: DesktopRelease, snapshot: string): Promise<void> {
    const previous = await this.active()
    if (!previous) throw new Error('No healthy desktop release is registered')
    if (await this.activation()) throw new Error('A release activation is already in progress')
    await this.read(next.id)
    const activation: ReleaseActivation = {
      token: randomUUID(),
      from: previous.id,
      to: next.id,
      snapshot,
      restoreRequired: !previous.readableDataSchemas.includes(next.dataSchema),
    }
    await atomicReleaseWrite(join(this.root, 'activation.json'), JSON.stringify(activation))
    await atomicReleaseWrite(join(this.root, 'trial'), activation.token)
    await atomicReleaseWrite(join(this.root, 'active'), next.id)
  }

  async confirm(id: string): Promise<void> {
    return this.serial(() => this.confirmRelease(id))
  }

  private async confirmRelease(id: string): Promise<void> {
    const activation = await this.activation()
    if (!activation || activation.to !== id) return
    if ((await this.active())?.id !== id)
      throw new Error('Release changed before startup confirmation')
    await atomicReleaseWrite(join(this.root, 'previousHealthy'), activation.from)
    await atomicReleaseWrite(join(this.root, 'last-activation.json'), JSON.stringify(activation))
    await atomicReleaseWrite(join(this.root, 'healthy'), activation.token)
    await this.finishActivation()
  }

  async rollback(): Promise<DesktopRelease> {
    return this.serial(() => this.rollbackRelease())
  }

  private async rollbackRelease(): Promise<DesktopRelease> {
    const activation = await this.activation()
    if (!activation) throw new Error('No release activation to roll back')
    const previous = await this.read(activation.from)
    const rejected = await this.read(activation.to)
    const saved = await optionalText(join(this.root, 'rolled-back-versions.json'))
    const versions: unknown = saved ? JSON.parse(saved) : []
    if (!Array.isArray(versions) || versions.some(version => typeof version !== 'string'))
      throw new Error('Invalid rollback quarantine')
    await atomicReleaseWrite(
      join(this.root, 'rolled-back-versions.json'),
      JSON.stringify([...new Set([...versions, rejected.version])])
    )
    await atomicReleaseWrite(join(this.root, 'active'), previous.id)
    if (activation.rollbackRequested) await rm(join(this.root, 'previousHealthy'), { force: true })
    await this.finishActivation()
    return previous
  }

  async requestRollback(): Promise<ReleaseActivation> {
    return this.serial(() => this.beginRollback())
  }

  private async beginRollback(): Promise<ReleaseActivation> {
    if (await this.activation()) throw new Error('A release activation is already in progress')
    const last = await optionalText(join(this.root, 'last-activation.json'))
    if (!last) throw new Error('No previous healthy release is available')
    await atomicReleaseWrite(
      join(this.root, 'activation.json'),
      JSON.stringify({ ...JSON.parse(last), rollbackRequested: true })
    )
    const activation = await this.activation()
    if (!activation || (await this.active())?.id !== activation.to) {
      await rm(join(this.root, 'activation.json'), { force: true })
      throw new Error('Previous release does not match the active release')
    }
    return activation
  }

  async prune(): Promise<void> {
    return this.serial(() => this.pruneReleases())
  }

  private async pruneReleases(): Promise<void> {
    const active = await this.active()
    if (!active) return
    const previous = await optionalText(join(this.root, 'previousHealthy'))
    const activation = await this.activation()
    const retained = new Set([active.id, previous, activation?.from, activation?.to])
    for (const entry of await readdir(join(this.root, 'slots'), { withFileTypes: true })) {
      if (entry.isDirectory() && !retained.has(entry.name))
        await removePhysicalRelease(this.slot(entry.name))
    }
    const last = await optionalText(join(this.root, 'last-activation.json'))
    const lastSnapshot = last ? (JSON.parse(last) as ReleaseActivation).snapshot : undefined
    const snapshotRoot = join(this.root, 'snapshots')
    let snapshots
    try {
      snapshots = await readdir(snapshotRoot, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of snapshots) {
      if (entry.isDirectory() && entry.name !== lastSnapshot && entry.name !== activation?.snapshot)
        await rm(join(snapshotRoot, entry.name), { recursive: true, force: true })
    }
  }

  private serial<Result>(operation: () => Promise<Result>): Promise<Result> {
    const key = resolve(this.root)
    const result = (releaseOperations.get(key) ?? Promise.resolve()).then(operation)
    const drained = result.then(
      () => undefined,
      () => undefined
    )
    releaseOperations.set(key, drained)
    void drained.then(() => {
      if (releaseOperations.get(key) === drained) releaseOperations.delete(key)
    })
    return result
  }

  private async finishActivation(): Promise<void> {
    // Keep the activation journal until trial removal. Interrupted finalization is recoverable.
    await rm(join(this.root, 'trial'), { force: true })
    await rm(join(this.root, 'failed'), { force: true })
    await rm(join(this.root, 'activation.json'), { force: true })
  }
}
