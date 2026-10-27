import { createHash } from 'node:crypto'
import { join } from 'node:path'
import semver from 'semver'
import { physicalFilesystem } from './physical-filesystem.js'
import { assertReleasePath } from './version-release-path.mjs'

export { assertReleasePath } from './version-release-path.mjs'
const { createReadStream } = physicalFilesystem
const { lstat, readFile, readdir } = physicalFilesystem.promises

export const UPDATE_SCHEMA_VERSION = 2
export const DATA_SCHEMA_VERSION = 1

export interface VersionRelease {
  schemaVersion: 2
  version: string
  platform: 'windows'
  arch: 'x64' | 'arm64'
  dataSchemaVersion: number
  entryPoint: 'WeWork.exe'
  files: { path: string; size: number; sha256: string }[]
}

export interface VersionUpdateFeed {
  schemaVersion: 2
  version: string
  platform: 'windows'
  arch: 'x64' | 'arm64'
  dataSchemaVersion: number
  url: string
  sha512: string
  size: number
  releaseDate: string
  releaseNotes?: string
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseUpdateFeed(value: unknown, arch: string): VersionUpdateFeed {
  if (
    !isRecord(value) ||
    value.schemaVersion !== UPDATE_SCHEMA_VERSION ||
    !validVersion(value.version) ||
    value.platform !== 'windows' ||
    value.arch !== arch ||
    value.dataSchemaVersion !== DATA_SCHEMA_VERSION ||
    typeof value.url !== 'string' ||
    !value.url ||
    typeof value.sha512 !== 'string' ||
    !/^[A-Za-z0-9+/]{86}==$/.test(value.sha512) ||
    !Number.isSafeInteger(value.size) ||
    Number(value.size) <= 0 ||
    Number(value.size) > 16 * 1024 ** 3 ||
    typeof value.releaseDate !== 'string' ||
    !Number.isFinite(Date.parse(value.releaseDate)) ||
    (value.releaseNotes !== undefined && typeof value.releaseNotes !== 'string')
  )
    throw new Error('Incompatible Windows update feed')
  return value as unknown as VersionUpdateFeed
}

export function parseVersionRelease(value: unknown, arch: string): VersionRelease {
  if (
    !isRecord(value) ||
    value.schemaVersion !== UPDATE_SCHEMA_VERSION ||
    !validVersion(value.version) ||
    value.platform !== 'windows' ||
    value.arch !== arch ||
    value.dataSchemaVersion !== DATA_SCHEMA_VERSION ||
    value.entryPoint !== 'WeWork.exe' ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > 100_000
  )
    throw new Error('Incompatible Windows release manifest')
  const paths = new Set<string>()
  for (const file of value.files) {
    if (
      !isRecord(file) ||
      typeof file.path !== 'string' ||
      !Number.isSafeInteger(file.size) ||
      Number(file.size) < 0 ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error('Invalid release file metadata')
    }
    assertReleasePath(file.path)
    const normalized = file.path.toLowerCase()
    if (normalized === 'release.json' || paths.has(normalized)) {
      throw new Error(`Duplicate release file: ${file.path}`)
    }
    paths.add(normalized)
  }
  if (!paths.has('wework.exe') || !paths.has('resources/app.asar')) {
    throw new Error('Release must contain the complete Electron application')
  }
  return value as unknown as VersionRelease
}

export async function verifyVersionDirectory(
  root: string,
  expected: Pick<VersionUpdateFeed, 'arch' | 'version'>
): Promise<VersionRelease> {
  const releasePath = join(root, 'release.json')
  const metadata = await lstat(releasePath)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024 ** 2) {
    throw new Error('Invalid release manifest file')
  }
  const release = parseVersionRelease(
    JSON.parse(await readFile(releasePath, 'utf8')),
    expected.arch
  )
  if (release.version !== expected.version) throw new Error('Downloaded release version mismatch')
  const files = new Map(release.files.map(file => [file.path, file]))
  async function visit(directory: string, prefix = ''): Promise<void> {
    for (const name of await readdir(directory)) {
      const path = prefix ? `${prefix}/${name}` : name
      assertReleasePath(path)
      const absolute = join(directory, name)
      const stat = await lstat(absolute)
      if (stat.isSymbolicLink()) throw new Error(`Release contains a symbolic link: ${path}`)
      if (stat.isDirectory()) {
        await visit(absolute, path)
        continue
      }
      if (path === 'release.json') continue
      const file = files.get(path)
      if (!stat.isFile() || !file || stat.size !== file.size) {
        throw new Error(`Release file mismatch: ${path}`)
      }
      if ((await hashFile(absolute, 'sha256')) !== file.sha256) {
        throw new Error(`Release checksum mismatch: ${path}`)
      }
      files.delete(path)
    }
  }
  await visit(root)
  if (files.size) throw new Error(`Release file is missing: ${files.keys().next().value}`)
  return release
}

export async function hashFile(path: string, algorithm: 'sha256' | 'sha512'): Promise<string> {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest(algorithm === 'sha512' ? 'base64' : 'hex')
}

function validVersion(value: unknown): value is string {
  return typeof value === 'string' && semver.valid(value) === value && value.length < 100
}
