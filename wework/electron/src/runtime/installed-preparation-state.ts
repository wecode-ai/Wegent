import { randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, rename, rm, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { currentCoreProfile, profileRevision, selectReleaseProfile } from './release-profile.js'
import { atomicReleaseWrite, optionalText, sameReleasePath } from './release-store.js'

export interface InstalledPreparationProfileSource {
  kind: 'missing' | 'profile'
  pointerKind?: 'directory' | 'symbolicLink'
  resolvedPath?: string
  revision?: string
}

export interface InstalledPreparationMarker {
  schemaVersion: 1
  token: string
  version: string
  preparationDirectory: string
  profileRoot: string
  preparedRevision: string
  source: InstalledPreparationProfileSource
  reusedPreparedProfile: boolean
}

export interface ApplyInstalledPreparationOptions {
  dataDirectory: string
  version: string
  releaseTransactionInProgress: boolean
  switchProfile?: InstalledPreparationProfileSwitcher
}

export type InstalledPreparationProfileSwitcher = (
  dataDirectory: string,
  profileRoot: string,
  baseline: string
) => Promise<void>

interface InstalledPreparationSwitchJournal {
  schemaVersion: 1
  pointer: string
  profileRoot: string
  baseline: string
  previous: InstalledPreparationProfileSource
}

export interface ApplyInstalledPreparationResult {
  applied: boolean
  reason:
    | 'applied'
    | 'missing'
    | 'invalid'
    | 'version-mismatch'
    | 'release-transaction'
    | 'source-changed'
    | 'prepared-profile-changed'
}

export function installedPreparationDirectory(dataDirectory: string, version: string): string {
  if (!/^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/.test(version))
    throw new Error('Invalid installation preparation version')
  return join(resolve(dataDirectory), 'install-preparations', version)
}

export function installedPreparationProfileRoot(dataDirectory: string, version: string): string {
  return join(
    installedPreparationDirectory(dataDirectory, version),
    'dsh-core',
    'profiles',
    'wework-core'
  )
}

export function installedPreparationMarkerFile(dataDirectory: string, version: string): string {
  return join(installedPreparationDirectory(dataDirectory, version), 'prepared.json')
}

export function installedPreparationSwitchFile(dataDirectory: string, version: string): string {
  return join(installedPreparationDirectory(dataDirectory, version), 'profile-switch.json')
}

export async function inspectInstalledProfileSource(
  pointer: string
): Promise<InstalledPreparationProfileSource> {
  let metadata
  try {
    metadata = await lstat(pointer)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    throw error
  }
  if (!metadata.isDirectory() && !metadata.isSymbolicLink())
    throw new Error('The installed Core profile is not a directory')
  return {
    kind: 'profile',
    pointerKind: metadata.isSymbolicLink() ? 'symbolicLink' : 'directory',
    resolvedPath: await realpath(pointer),
    revision: await profileRevision(pointer),
  }
}

/** Finish an interrupted profile switch before installing this version again. */
export async function recoverInstalledPreparationSwitch(
  dataDirectory: string,
  version: string
): Promise<void> {
  const switchFile = installedPreparationSwitchFile(dataDirectory, version)
  const text = await optionalText(switchFile)
  if (text === null) return
  const preparationDirectory = installedPreparationDirectory(dataDirectory, version)
  const journal = parseSwitchJournalForPaths(
    text,
    dataDirectory,
    preparationDirectory,
    installedPreparationProfileRoot(dataDirectory, version)
  )
  await recoverProfileSwitch(journal, preparationDirectory)
  await rm(switchFile, { force: true })
}

export async function writeInstalledPreparationMarker(
  dataDirectory: string,
  marker: InstalledPreparationMarker
): Promise<void> {
  await atomicReleaseWrite(
    installedPreparationMarkerFile(dataDirectory, marker.version),
    `${JSON.stringify(marker, null, 2)}\n`
  )
}

export async function applyInstalledPreparation(
  options: ApplyInstalledPreparationOptions
): Promise<ApplyInstalledPreparationResult> {
  const markerFile = installedPreparationMarkerFile(options.dataDirectory, options.version)
  const switchFile = installedPreparationSwitchFile(options.dataDirectory, options.version)
  const text = await optionalText(markerFile)
  if (text === null) return { applied: false, reason: 'missing' }
  let marker: InstalledPreparationMarker
  try {
    marker = parseMarker(text, options.dataDirectory)
  } catch {
    return { applied: false, reason: 'invalid' }
  }
  if (marker.version !== options.version) return { applied: false, reason: 'version-mismatch' }
  if (options.releaseTransactionInProgress) return { applied: false, reason: 'release-transaction' }
  const pointer = currentCoreProfile(options.dataDirectory)
  const switchResult = await recoverInterruptedSwitch(switchFile, marker)
  if (switchResult === 'completed') {
    await consumePreparation(markerFile, switchFile)
    return { applied: true, reason: 'applied' }
  }
  if (switchResult === 'restored') await rm(switchFile, { force: true })
  if (await sameReleasePath(pointer, marker.profileRoot)) {
    await consumePreparation(markerFile, switchFile)
    return { applied: true, reason: 'applied' }
  }
  if ((await profileRevision(marker.profileRoot)) !== marker.preparedRevision)
    return { applied: false, reason: 'prepared-profile-changed' }

  if (!marker.reusedPreparedProfile) {
    const current = await inspectInstalledProfileSource(pointer)
    if (marker.source.kind === 'missing') {
      if (current.kind !== 'missing') return { applied: false, reason: 'source-changed' }
    } else if (
      current.kind !== 'profile' ||
      current.resolvedPath !== marker.source.resolvedPath ||
      current.revision !== marker.source.revision
    ) {
      return { applied: false, reason: 'source-changed' }
    }
  } else {
    const current = await inspectInstalledProfileSource(pointer)
    if (
      current.kind === 'profile' &&
      !(await sameReleasePath(current.resolvedPath!, marker.profileRoot))
    )
      return { applied: false, reason: 'source-changed' }
  }

  const baseline = join(marker.preparationDirectory, 'previous-profiles', marker.token)
  const journal: InstalledPreparationSwitchJournal = {
    schemaVersion: 1,
    pointer,
    profileRoot: marker.profileRoot,
    baseline,
    previous: marker.source,
  }
  await atomicReleaseWrite(switchFile, `${JSON.stringify(journal, null, 2)}\n`)
  try {
    await (options.switchProfile ?? selectReleaseProfile)(
      options.dataDirectory,
      marker.profileRoot,
      baseline
    )
  } catch (error) {
    if ((await recoverProfileSwitch(journal, marker.preparationDirectory)) === 'completed') {
      await consumePreparation(markerFile, switchFile)
      return { applied: true, reason: 'applied' }
    }
    await rm(switchFile, { force: true })
    throw error
  }
  await consumePreparation(markerFile, switchFile)
  return { applied: true, reason: 'applied' }
}

async function recoverInterruptedSwitch(
  switchFile: string,
  marker: InstalledPreparationMarker
): Promise<'none' | 'restored' | 'completed'> {
  const text = await optionalText(switchFile)
  if (text === null) return 'none'
  const journal = parseSwitchJournal(text, marker)
  return recoverProfileSwitch(journal, marker.preparationDirectory)
}

async function recoverProfileSwitch(
  journal: InstalledPreparationSwitchJournal,
  preparationDirectory: string
): Promise<'restored' | 'completed'> {
  const current = await resolvedProfilePointer(journal.pointer)
  if (current && (await sameReleasePath(current, journal.profileRoot))) return 'completed'
  if (
    current &&
    journal.previous.kind === 'profile' &&
    (await sameReleasePath(current, journal.previous.resolvedPath!))
  )
    return 'restored'
  if (current)
    throw new Error('The installed Core profile changed while its preparation was applied')

  if (journal.previous.kind === 'missing') return 'restored'
  await removeDanglingProfilePointer(journal.pointer)
  if (journal.previous.pointerKind === 'directory') {
    if (!isWithin(preparationDirectory, journal.baseline))
      throw new Error('Installed preparation switch baseline is invalid')
    await mkdir(dirname(journal.pointer), { recursive: true, mode: 0o700 })
    await rename(journal.baseline, journal.pointer)
    return 'restored'
  }
  await mkdir(dirname(journal.pointer), { recursive: true, mode: 0o700 })
  const temporary = `${journal.pointer}.${randomUUID()}.tmp`
  try {
    await symlink(
      journal.previous.resolvedPath!,
      temporary,
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await rename(temporary, journal.pointer)
  } finally {
    await rm(temporary, { force: true })
  }
  return 'restored'
}

async function resolvedProfilePointer(pointer: string): Promise<string | null> {
  try {
    await lstat(pointer)
    return await realpath(pointer)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function removeDanglingProfilePointer(pointer: string): Promise<void> {
  try {
    if ((await lstat(pointer)).isSymbolicLink()) await rm(pointer, { force: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function consumePreparation(markerFile: string, switchFile: string): Promise<void> {
  await Promise.all([rm(markerFile, { force: true }), rm(switchFile, { force: true })])
}

function parseSwitchJournal(
  text: string,
  marker: InstalledPreparationMarker
): InstalledPreparationSwitchJournal {
  const value = parseSwitchJournalForPaths(
    text,
    resolve(marker.preparationDirectory, '..', '..'),
    marker.preparationDirectory,
    marker.profileRoot
  )
  if (
    value.previous.kind !== marker.source.kind ||
    value.previous.pointerKind !== marker.source.pointerKind ||
    value.previous.resolvedPath !== marker.source.resolvedPath ||
    value.previous.revision !== marker.source.revision
  )
    throw new Error('Invalid installed preparation switch journal')
  return value
}

function parseSwitchJournalForPaths(
  text: string,
  dataDirectory: string,
  preparationDirectory: string,
  profileRoot: string
): InstalledPreparationSwitchJournal {
  const value = JSON.parse(text) as Partial<InstalledPreparationSwitchJournal>
  if (
    value.schemaVersion !== 1 ||
    value.pointer !== currentCoreProfile(dataDirectory) ||
    typeof value.profileRoot !== 'string' ||
    value.profileRoot !== profileRoot ||
    typeof value.baseline !== 'string' ||
    !isWithin(preparationDirectory, value.profileRoot) ||
    !isWithin(preparationDirectory, value.baseline) ||
    dirname(value.baseline) !== join(preparationDirectory, 'previous-profiles') ||
    !validProfileSource(value.previous)
  )
    throw new Error('Invalid installed preparation switch journal')
  return value as InstalledPreparationSwitchJournal
}

function validProfileSource(
  value: Partial<InstalledPreparationProfileSource> | undefined
): boolean {
  if (!value) return false
  if (value.kind === 'missing')
    return (
      value.pointerKind === undefined &&
      value.resolvedPath === undefined &&
      value.revision === undefined
    )
  return (
    value.kind === 'profile' &&
    (value.pointerKind === 'directory' || value.pointerKind === 'symbolicLink') &&
    typeof value.resolvedPath === 'string' &&
    isAbsolute(value.resolvedPath) &&
    typeof value.revision === 'string' &&
    /^[a-f0-9]{64}$/.test(value.revision)
  )
}

function parseMarker(text: string, dataDirectory: string): InstalledPreparationMarker {
  const value = JSON.parse(text) as Partial<InstalledPreparationMarker>
  if (
    value.schemaVersion !== 1 ||
    typeof value.token !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(value.token) ||
    typeof value.version !== 'string' ||
    typeof value.preparationDirectory !== 'string' ||
    typeof value.profileRoot !== 'string' ||
    typeof value.preparedRevision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.preparedRevision) ||
    typeof value.reusedPreparedProfile !== 'boolean' ||
    !value.source ||
    (value.source.kind !== 'missing' && value.source.kind !== 'profile')
  )
    throw new Error('Invalid installed preparation marker')
  const preparationDirectory = installedPreparationDirectory(dataDirectory, value.version)
  if (
    resolve(value.preparationDirectory) !== preparationDirectory ||
    !isWithin(preparationDirectory, value.profileRoot)
  )
    throw new Error('Installed preparation paths escape their versioned directory')
  if (
    value.source.kind === 'profile' &&
    (typeof value.source.resolvedPath !== 'string' ||
      !isAbsolute(value.source.resolvedPath) ||
      typeof value.source.revision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.source.revision) ||
      (value.source.pointerKind !== 'directory' && value.source.pointerKind !== 'symbolicLink'))
  )
    throw new Error('Invalid installed preparation source')
  return value as InstalledPreparationMarker
}

function isWithin(parent: string, child: string): boolean {
  if (!isAbsolute(child)) return false
  const offset = relative(parent, resolve(child))
  return offset !== '' && offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset)
}
