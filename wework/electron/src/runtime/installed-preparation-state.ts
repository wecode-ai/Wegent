import { lstat, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

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
  if ((await profileRevision(marker.profileRoot)) !== marker.preparedRevision)
    return { applied: false, reason: 'prepared-profile-changed' }

  const pointer = currentCoreProfile(options.dataDirectory)
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

  await selectReleaseProfile(
    options.dataDirectory,
    marker.profileRoot,
    join(marker.preparationDirectory, 'previous-profiles', marker.token)
  )
  await rm(markerFile, { force: true })
  return { applied: true, reason: 'applied' }
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
