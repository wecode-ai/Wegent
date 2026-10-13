import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import semver from 'semver'
import { extract } from 'tar'
import { cloudFetch } from '../host/cloud-http.js'
import { publishImmutableDirectory } from './immutable-directory.js'

interface RuntimeDescriptor {
  dshVersion: string
  role: string
  sourceFingerprint: string
  archiveSha256: string
  archiveBytes: number
  assetName: string
  bundled?: boolean
  downloadUrl?: string
  directory?: string
}

interface RuntimeCatalog {
  runtimes: RuntimeDescriptor[]
}

export type BundledRuntimeRole = 'core' | 'workbench'

export async function materializeBundledRuntimes(
  resourceRoot: string,
  cacheRoot: string,
  roles: readonly BundledRuntimeRole[] = ['core', 'workbench'],
  options: { versionRequirement?: string; downloadBaseUrl?: string; fetch?: typeof fetch } = {}
): Promise<string> {
  const catalog = JSON.parse(
    await readFile(join(resolve(resourceRoot), 'runtimes.json'), 'utf8')
  ) as RuntimeCatalog
  const runtimes = catalog.runtimes.filter(runtime => ['core', 'workbench'].includes(runtime.role))
  const availableRoles = new Set(runtimes.map(runtime => runtime.role))
  if (!availableRoles.has('core') || !availableRoles.has('workbench')) {
    throw new Error('Bundled Electron runtime catalog must contain Core and Workbench runtimes')
  }
  const requestedRoles = new Set(roles)
  if (
    requestedRoles.size !== roles.length ||
    roles.some(role => !['core', 'workbench'].includes(role))
  ) {
    throw new Error('Bundled Electron runtime roles are invalid')
  }
  const selectedRuntimes = runtimes.filter(
    runtime =>
      requestedRoles.has(runtime.role as BundledRuntimeRole) &&
      (options.versionRequirement
        ? semver.satisfies(runtime.dshVersion, options.versionRequirement, {
            includePrerelease: true,
          })
        : runtime.bundled !== false)
  )
  if (options.versionRequirement) {
    selectedRuntimes.sort((left, right) => semver.rcompare(left.dshVersion, right.dshVersion))
    const selected = new Set<string>()
    for (let index = 0; index < selectedRuntimes.length; ) {
      const role = selectedRuntimes[index].role
      if (selected.has(role)) selectedRuntimes.splice(index, 1)
      else {
        selected.add(role)
        index += 1
      }
    }
  }
  const selectedRoles = new Set(selectedRuntimes.map(runtime => runtime.role))
  if ([...requestedRoles].some(role => !selectedRoles.has(role))) {
    throw new Error('Bundled Electron runtime catalog is missing a requested runtime')
  }
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
  for (const runtime of selectedRuntimes) {
    await materializeRuntime(
      resourceRoot,
      cacheRoot,
      runtime,
      options.fetch ?? cloudFetch,
      options.downloadBaseUrl
    )
  }
  await writeFile(join(cacheRoot, 'runtimes.json'), `${JSON.stringify({ runtimes }, null, 2)}\n`, {
    mode: 0o600,
  })
  return cacheRoot
}

async function materializeRuntime(
  resourceRoot: string,
  cacheRoot: string,
  runtime: RuntimeDescriptor,
  fetchImpl: typeof fetch,
  downloadBaseUrl?: string
): Promise<void> {
  validateDescriptor(runtime)
  const target = join(cacheRoot, runtime.sourceFingerprint)
  if (await runtimeMatches(target, runtime)) return
  if (runtime.directory) {
    const source = join(resolve(resourceRoot), runtime.directory)
    if (!(await runtimeMatches(source, runtime))) {
      throw new Error(`Bundled DSH runtime identity is invalid: ${runtime.directory}`)
    }
    await rm(target, { recursive: true, force: true })
    await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir')
    return
  }
  const downloaded = runtime.bundled === false
  const archive = downloaded
    ? join(cacheRoot, `${runtime.sourceFingerprint}.tar.gz`)
    : join(resourceRoot, runtime.assetName)
  try {
    if (downloaded) await downloadRuntime(archive, runtime, fetchImpl, downloadBaseUrl)
    const metadata = await stat(archive)
    if (metadata.size !== runtime.archiveBytes) {
      throw new Error(`Bundled DSH runtime size mismatch: ${runtime.assetName}`)
    }
    const bytes = await readFile(archive)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 !== runtime.archiveSha256) {
      throw new Error(`Bundled DSH runtime checksum mismatch: ${runtime.assetName}`)
    }
    await publishImmutableDirectory(
      target,
      async content => {
        await extractArchive(archive, content)
        if (!(await runtimeMatches(content, runtime))) {
          throw new Error(`Bundled DSH runtime identity is invalid: ${runtime.assetName}`)
        }
      },
      path => runtimeMatches(path, runtime)
    )
  } finally {
    if (downloaded) await rm(archive, { force: true })
  }
}

async function downloadRuntime(
  archive: string,
  runtime: RuntimeDescriptor,
  fetchImpl: typeof fetch,
  downloadBaseUrl?: string
): Promise<void> {
  if (!runtime.downloadUrl)
    throw new Error(`DSH runtime download URL is missing: ${runtime.dshVersion}`)
  const temporary = `${archive}.${process.pid}.download`
  try {
    const url = downloadBaseUrl
      ? `${downloadBaseUrl.replace(/\/+$/, '')}/${runtime.assetName}`
      : runtime.downloadUrl
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) })
    if (!response.ok || !response.body) {
      throw new Error(`DSH runtime download failed: HTTP ${response.status}`)
    }
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      createWriteStream(temporary, { mode: 0o600 })
    )
    await rename(temporary, archive)
  } finally {
    await rm(temporary, { force: true })
  }
}

async function extractArchive(archive: string, destination: string): Promise<void> {
  try {
    await extract({ cwd: destination, file: archive, strict: true })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Bundled DSH runtime extraction failed: ${detail}`, { cause: error })
  }
}

async function runtimeMatches(root: string, runtime: RuntimeDescriptor): Promise<boolean> {
  try {
    const identity = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8')) as {
      dshVersion?: unknown
      role?: unknown
      sourceFingerprint?: unknown
    }
    return (
      identity.dshVersion === runtime.dshVersion &&
      identity.role === runtime.role &&
      identity.sourceFingerprint === runtime.sourceFingerprint
    )
  } catch {
    return false
  }
}

function validateDescriptor(runtime: RuntimeDescriptor): void {
  if (
    !runtime.dshVersion ||
    !['core', 'workbench'].includes(runtime.role) ||
    !/^[0-9a-f]{64}$/.test(runtime.sourceFingerprint) ||
    !/^[0-9a-f]{64}$/.test(runtime.archiveSha256) ||
    !Number.isSafeInteger(runtime.archiveBytes) ||
    runtime.archiveBytes <= 0 ||
    typeof runtime.assetName !== 'string' ||
    basename(runtime.assetName) !== runtime.assetName ||
    !runtime.assetName.endsWith('.tar.gz') ||
    (runtime.directory !== undefined && runtime.directory !== runtime.sourceFingerprint)
  ) {
    throw new Error('Bundled DSH runtime descriptor is invalid')
  }
}
