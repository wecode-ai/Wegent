import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { removePhysicalRelease } from './physical-release-files.js'
import { serializePathOperation } from './path-operation-queue.js'
import { parseRollbackHistory, type ReleaseRollbackRecord } from './release-update-history.js'
import { planReleaseCleanup } from './release-cleanup.js'

export type ReleasePruneResult = { status: 'completed' } | { status: 'skipped'; reason: string }

export interface DesktopRelease {
  schemaVersion: 1
  id: string
  version: string
  executable: string
  resources: string
  runtimeRoot: string
  componentDataDirectory?: string
  profileRoot: string
  dataSchema: number
  readableDataSchemas: number[]
  packageSha256?: string
  retainedRelease?: string
  macosInstallation?: {
    payloadExecutable: string
    bootstrapFromPayload: boolean
    sourceReleaseId?: string
    rollbackReleaseId?: string
  }
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

async function existingReleasePath(value: string): Promise<string | undefined> {
  if (typeof value !== 'string' || !isAbsolute(value)) return undefined
  try {
    return await realpath(value)
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return undefined
    throw error
  }
}

/** Match actual delivered paths, preserving rejection of absent or relative paths. */
export async function sameReleasePath(first: string, second: string): Promise<boolean> {
  const [left, right] = await Promise.all([existingReleasePath(first), existingReleasePath(second)])
  return left !== undefined && left === right
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

  async isSlotExecutable(executable: string): Promise<boolean> {
    const [slots, actual] = await Promise.all([
      existingReleasePath(join(this.root, 'slots')),
      existingReleasePath(executable),
    ])
    if (!slots || !actual) return false
    const child = relative(slots, actual)
    return child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
  }

  async read(id: string): Promise<DesktopRelease> {
    const value = JSON.parse(
      await readFile(join(this.slot(id), 'release.json'), 'utf8')
    ) as DesktopRelease
    const installation = value.macosInstallation
    if (
      value.schemaVersion !== 1 ||
      value.id !== id ||
      !value.version ||
      !Number.isSafeInteger(value.dataSchema) ||
      !Array.isArray(value.readableDataSchemas) ||
      !value.readableDataSchemas.every(Number.isSafeInteger) ||
      (value.packageSha256 !== undefined && !/^[a-f0-9]{64}$/.test(value.packageSha256)) ||
      (value.retainedRelease !== undefined &&
        (typeof value.retainedRelease !== 'string' || releaseId(value.retainedRelease) === id)) ||
      (installation !== undefined &&
        (!installation ||
          typeof installation.bootstrapFromPayload !== 'boolean' ||
          typeof installation.payloadExecutable !== 'string' ||
          !isAbsolute(installation.payloadExecutable) ||
          (installation.sourceReleaseId === undefined) !==
            (installation.rollbackReleaseId === undefined) ||
          (installation.sourceReleaseId !== undefined &&
            (releaseId(installation.sourceReleaseId) === id ||
              releaseId(installation.rollbackReleaseId!) === id)) ||
          /[\r\n]/.test(installation.payloadExecutable) ||
          relative(this.slot(id), installation.payloadExecutable).startsWith('..') ||
          isAbsolute(relative(this.slot(id), installation.payloadExecutable)))) ||
      (value.componentDataDirectory !== undefined &&
        (typeof value.componentDataDirectory !== 'string' ||
          !isAbsolute(value.componentDataDirectory) ||
          /[\r\n]/.test(value.componentDataDirectory))) ||
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
    const installation = release.macosInstallation
    await atomicReleaseWrite(
      join(this.slot(release.id), 'executable'),
      installation?.bootstrapFromPayload ? installation.payloadExecutable : release.executable
    )
    if (installation) {
      await atomicReleaseWrite(
        join(this.slot(release.id), 'installed-executable'),
        release.executable
      )
      await atomicReleaseWrite(
        join(this.slot(release.id), 'payload-executable'),
        installation.payloadExecutable
      )
    }
  }

  async active(): Promise<DesktopRelease | null> {
    const id = await optionalText(join(this.root, 'active'))
    return id ? this.read(id) : null
  }

  async rollbackHistory(): Promise<ReleaseRollbackRecord[]> {
    return parseRollbackHistory(
      await optionalText(join(this.root, 'update-rollback-history.json')),
      await optionalText(join(this.root, 'rolled-back-versions.json'))
    )
  }

  /** Preserve unreadable consent records without blocking health or recovery. */
  private async updateRollbackHistory(
    update: (history: ReleaseRollbackRecord[]) => ReleaseRollbackRecord[]
  ): Promise<void> {
    let history: ReleaseRollbackRecord[]
    try {
      history = await this.rollbackHistory()
    } catch {
      // Retry checks still use the strict reader and reject until history is repaired.
      return
    }
    const records = update(history)
    await atomicReleaseWrite(
      join(this.root, 'update-rollback-history.json'),
      JSON.stringify(records)
    )
    // A retained older host still reads this file after rollback. New hosts
    // interpret it as a request for consent, never as a server revocation.
    await atomicReleaseWrite(
      join(this.root, 'rolled-back-versions.json'),
      JSON.stringify([...new Set(records.map(record => record.version))])
    )
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
    let previous = await this.active()
    if (!previous) throw new Error('No healthy desktop release is registered')
    if (await this.activation()) throw new Error('A release activation is already in progress')
    next = await this.read(next.id)
    previous = await this.activationSource(next, previous, snapshot)
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

  private async activationSource(
    next: DesktopRelease,
    previous: DesktopRelease,
    snapshot: string
  ): Promise<DesktopRelease> {
    const installation = next.macosInstallation
    if (!installation?.rollbackReleaseId || previous.id === installation.rollbackReleaseId)
      return previous
    if (previous.id !== installation.sourceReleaseId)
      throw new Error('The macOS activation source changed after preparation')
    const retained = await this.read(installation.rollbackReleaseId)
    if (
      retained.retainedRelease !== previous.id ||
      retained.version !== previous.version ||
      retained.dataSchema !== previous.dataSchema ||
      JSON.stringify(retained.readableDataSchemas) !== JSON.stringify(previous.readableDataSchemas)
    )
      throw new Error('The retained macOS source does not match the activation source')
    // Old installers retain a stopped live profile immediately before activation.
    // Resolve that final ownership here instead of retaining a live pointer.
    const source = { ...retained, profileRoot: previous.profileRoot }
    await this.save(source)
    // Delivered cleaners do not understand retainedRelease. Retain the real
    // snapshot's profile owner using their existing preservation contract.
    for (const id of [previous.id, source.id]) {
      const marker = join(this.slot(id), 'preserved-data-snapshot')
      if (!(await optionalText(marker)))
        await atomicReleaseWrite(
          marker,
          JSON.stringify({ kind: 'macos-source-owner', owner: source.id, snapshot })
        )
    }
    await atomicReleaseWrite(join(this.root, 'bridge'), source.macosInstallation!.payloadExecutable)
    return source
  }

  async repairMacosActivationSource(next: DesktopRelease): Promise<void> {
    const activation = await this.activation()
    if (!activation || activation.to !== next.id || !next.macosInstallation?.rollbackReleaseId)
      return
    const previous = await this.read(activation.from)
    if (previous.id !== next.macosInstallation.rollbackReleaseId) {
      if ((await optionalText(join(this.root, 'data-opened'))) === activation.token)
        throw new Error('The macOS activation source cannot change after data opens')
      const source = await this.activationSource(next, previous, activation.snapshot)
      await atomicReleaseWrite(
        join(this.root, 'activation.json'),
        JSON.stringify({ ...activation, from: source.id })
      )
    }
    // The selected signed bootstrap has now loaded before opening data. Legacy
    // parents may recover through a cached versioned source, whose old native
    // launcher cannot restore Contents. Route that recovery through this loaded
    // bootstrap; runtime/renderer health is still confirmed independently.
    await atomicReleaseWrite(join(this.root, 'bridge'), next.macosInstallation.payloadExecutable)
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
    const healthy = await this.read(id)
    await this.updateRollbackHistory(history =>
      history.filter(record => record.version !== healthy.version)
    )
    // Full target health supersedes a handoff left by an older source launcher.
    if (healthy.macosInstallation) await rm(join(this.root, 'macos-rollback'), { force: true })
    await atomicReleaseWrite(
      join(this.root, 'bridge'),
      healthy.macosInstallation?.payloadExecutable ?? healthy.executable
    )
    await atomicReleaseWrite(join(this.root, 'healthy'), activation.token)
    await this.finishActivation()
  }

  async rollback(): Promise<DesktopRelease> {
    return this.serial(() => this.rollbackRelease())
  }

  async recoverUnstartedActivation(sourceId: string, prepare: () => Promise<void>): Promise<void> {
    return this.serial(async () => {
      const activation = await this.activation()
      if (!activation) {
        if ((await this.active())?.id !== sourceId) throw new Error('Recovery source changed')
        await prepare()
        return
      }
      const recovery = join(this.root, 'recovery')
      const archived = await optionalText(join(recovery, `${activation.token}.json`))
      const resuming = archived === JSON.stringify(activation)
      const selected = (await this.active())?.id
      const trial = await optionalText(join(this.root, 'trial'))
      if (
        activation.from !== sourceId ||
        activation.rollbackRequested ||
        (selected !== activation.to && !(resuming && selected === sourceId)) ||
        (trial !== activation.token && !(resuming && trial === null)) ||
        (
          await Promise.all(
            ['attempted', 'data-opened', 'healthy', 'failed'].map(name =>
              optionalText(join(this.root, name))
            )
          )
        ).includes(activation.token)
      )
        throw new Error('The pending release has started; supervised recovery is required')
      await prepare()
      await mkdir(recovery, { recursive: true, mode: 0o700 })
      await atomicReleaseWrite(
        join(recovery, `${activation.token}.json`),
        JSON.stringify(activation)
      )
      await this.rollbackRelease()
    })
  }

  private async rollbackRelease(): Promise<DesktopRelease> {
    const activation = await this.activation()
    if (!activation) throw new Error('No release activation to roll back')
    const previous = await this.read(activation.from)
    const rejected = await this.read(activation.to)
    const attempted = await optionalText(join(this.root, 'attempted'))
    if (activation.rollbackRequested || attempted === activation.token) {
      const record: ReleaseRollbackRecord = {
        token: activation.token,
        version: rejected.version,
        fromVersion: previous.version,
        packageSha256: rejected.packageSha256,
        reason: activation.rollbackRequested ? 'rolled-back' : 'startup-failed',
        occurredAt: new Date().toISOString(),
      }
      await this.updateRollbackHistory(history => [
        ...history.filter(item => item.version !== record.version),
        record,
      ])
    }
    if (
      activation.restoreRequired &&
      (await optionalText(join(this.root, 'data-opened'))) === activation.token
    ) {
      // Profiles can contain newer user plugin data. Retain that complete slot
      // alongside restored database backups rather than garbage-collecting it.
      const preserved = join(this.root, 'preserved-data', activation.snapshot)
      await mkdir(preserved, { recursive: true, mode: 0o700 })
      await atomicReleaseWrite(join(preserved, 'retained-release'), rejected.id)
      await atomicReleaseWrite(
        join(this.slot(rejected.id), 'preserved-data-snapshot'),
        activation.snapshot
      )
    }
    // Selection can finish before the native installer restores physical Contents.
    if (previous.macosInstallation)
      await atomicReleaseWrite(join(this.root, 'macos-rollback'), previous.id)
    await atomicReleaseWrite(join(this.root, 'active'), previous.id)
    await atomicReleaseWrite(
      join(this.root, 'bridge'),
      previous.macosInstallation?.payloadExecutable ?? previous.executable
    )
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

  async prune(): Promise<ReleasePruneResult> {
    return this.serial(() => this.pruneReleases())
  }

  private async pruneReleases(): Promise<ReleasePruneResult> {
    let plan
    try {
      plan = await planReleaseCleanup(this)
    } catch (error) {
      // Cleanup is optional. An incomplete ownership graph must never permit partial deletion.
      return {
        status: 'skipped',
        reason: error instanceof Error ? error.message : 'Release ownership is unavailable',
      }
    }
    for (const marker of plan.markers) await rm(marker, { force: true })
    for (const release of plan.releases) await removePhysicalRelease(release)
    for (const snapshot of plan.snapshots) await rm(snapshot, { recursive: true, force: true })
    return { status: 'completed' }
  }

  private serial<Result>(operation: () => Promise<Result>): Promise<Result> {
    return serializePathOperation(this.root, operation)
  }

  private async finishActivation(): Promise<void> {
    // Keep the activation journal until trial removal. Interrupted finalization is recoverable.
    await rm(join(this.root, 'trial'), { force: true })
    await rm(join(this.root, 'failed'), { force: true })
    await rm(join(this.root, 'activation.json'), { force: true })
  }
}
