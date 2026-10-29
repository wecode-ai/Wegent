import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import semver from 'semver'
import { extract } from 'tar'
import { cloudFetch } from '../host/lazy-cloud-fetch.js'
import { publishImmutableDirectory } from './immutable-directory.js'
import { resolveRuntimeArchive } from './runtime-archive.js'

export interface RuntimeDescriptor {
  dshVersion: string
  role: string
  sourceFingerprint: string
  archiveSha256: string
  archiveBytes: number
  assetName: string
  downloadUrl?: string
}

interface RuntimeCatalog {
  runtimes: RuntimeDescriptor[]
  downloadableRuntimes?: RuntimeDescriptor[]
}

export type BundledRuntimeRole = 'core' | 'workbench'

interface MaterializeRuntimeOptions {
  versionRequirement?: string
  fetch?: typeof fetch
}

export async function materializeBundledRuntimes(
  resourceRoot: string,
  cacheRoot: string,
  roles: readonly BundledRuntimeRole[] = ['core', 'workbench'],
  options: MaterializeRuntimeOptions = {}
): Promise<string> {
  const catalog = JSON.parse(
    await readFile(join(resolve(resourceRoot), 'runtimes.json'), 'utf8')
  ) as RuntimeCatalog
  const runtimes = [...catalog.runtimes, ...(catalog.downloadableRuntimes ?? [])].filter(runtime =>
    ['core', 'workbench'].includes(runtime.role)
  )
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
  let selectedRuntimes = (options.versionRequirement ? runtimes : catalog.runtimes).filter(
    runtime => requestedRoles.has(runtime.role as BundledRuntimeRole)
  )
  if (options.versionRequirement) {
    selectedRuntimes = roles.flatMap(role =>
      selectedRuntimes
        .filter(
          runtime =>
            runtime.role === role &&
            semver.satisfies(runtime.dshVersion, options.versionRequirement!, {
              includePrerelease: true,
            })
        )
        .sort((left, right) => semver.rcompare(left.dshVersion, right.dshVersion))
        .slice(0, 1)
    )
  }
  const selectedRoles = new Set(selectedRuntimes.map(runtime => runtime.role))
  if ([...requestedRoles].some(role => !selectedRoles.has(role))) {
    throw new Error(
      `Bundled Electron runtime catalog is missing a requested runtime: ${options.versionRequirement ?? roles.join(', ')}`
    )
  }
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
  for (const runtime of selectedRuntimes) {
    await materializeRuntime(resourceRoot, cacheRoot, runtime, options.fetch ?? cloudFetch)
  }
  await writeRuntimeCatalog(cacheRoot, runtimes)
  return cacheRoot
}

async function writeRuntimeCatalog(
  cacheRoot: string,
  runtimes: RuntimeDescriptor[]
): Promise<void> {
  const temporary = join(cacheRoot, `.runtimes-${randomUUID()}.json`)
  try {
    await writeFile(temporary, `${JSON.stringify({ runtimes }, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, join(cacheRoot, 'runtimes.json'))
  } finally {
    await rm(temporary, { force: true })
  }
}

async function materializeRuntime(
  resourceRoot: string,
  cacheRoot: string,
  runtime: RuntimeDescriptor,
  fetchImpl: typeof fetch
): Promise<void> {
  validateDescriptor(runtime)
  const target = join(cacheRoot, runtime.sourceFingerprint)
  if (await runtimeMatches(target, runtime)) return
  await publishImmutableDirectory(
    target,
    async content => {
      const archive = await resolveRuntimeArchive(resourceRoot, cacheRoot, runtime, fetchImpl)
      await extractArchive(archive, content)
      if (!(await runtimeMatches(content, runtime))) {
        throw new Error(`Bundled DSH runtime identity is invalid: ${runtime.assetName}`)
      }
    },
    path => runtimeMatches(path, runtime)
  )
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
      roles?: unknown
      sourceFingerprint?: unknown
    }
    return (
      identity.dshVersion === runtime.dshVersion &&
      (identity.role === runtime.role ||
        (Array.isArray(identity.roles) && identity.roles.includes(runtime.role))) &&
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
    !runtime.assetName.endsWith('.tar.gz') ||
    basename(runtime.assetName) !== runtime.assetName ||
    /[\\\\/]/.test(runtime.assetName)
  ) {
    throw new Error('Bundled DSH runtime descriptor is invalid')
  }
}
