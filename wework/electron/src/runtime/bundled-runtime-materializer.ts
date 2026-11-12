import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import semver from 'semver'
import { cloudFetch } from '../host/lazy-cloud-fetch.js'
import { linkImmutableDirectory, publishImmutableDirectory } from './immutable-directory.js'
import { resolveRuntimeArchive } from './runtime-archive.js'
import { extractPhysicalRelease } from './physical-release-files.js'
import { serializePathOperation } from './path-operation-queue.js'

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

export interface RuntimeMaterializationProgress {
  stage: string
  phase: 'started' | 'completed' | 'failed'
  elapsedMs: number
  role?: string
  archiveBytes?: number
}

interface MaterializeRuntimeOptions {
  versionRequirement?: string
  fetch?: typeof fetch
  reuseRoot?: string
  immutableRoot?: string
  onProgress?: (event: RuntimeMaterializationProgress) => void
}

async function materializationStep<T>(
  stage: string,
  options: MaterializeRuntimeOptions,
  run: () => Promise<T>,
  runtime?: RuntimeDescriptor
): Promise<T> {
  if (!options.onProgress) return run()
  const startedAt = performance.now()
  const report = (phase: RuntimeMaterializationProgress['phase']) => {
    try {
      options.onProgress?.({
        stage,
        phase,
        elapsedMs: Math.round(performance.now() - startedAt),
        ...(runtime ? { role: runtime.role, archiveBytes: runtime.archiveBytes } : {}),
      })
    } catch {
      // Diagnostic failures must never interrupt preparation or replace its original error.
    }
  }
  report('started')
  try {
    const result = await run()
    report('completed')
    return result
  } catch (error) {
    report('failed')
    throw error
  }
}

export async function materializeBundledRuntimes(
  resourceRoot: string,
  cacheRoot: string,
  roles: readonly BundledRuntimeRole[] = ['core', 'workbench'],
  options: MaterializeRuntimeOptions = {}
): Promise<string> {
  const catalog = await materializationStep(
    'catalog-read',
    options,
    async () =>
      JSON.parse(
        await readFile(join(resolve(resourceRoot), 'runtimes.json'), 'utf8')
      ) as RuntimeCatalog
  )
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
  const archives = new Map<string, string>()
  for (const runtime of selectedRuntimes) {
    const identity = JSON.stringify([
      runtime.dshVersion,
      runtime.archiveSha256,
      runtime.archiveBytes,
    ])
    if (
      archives.has(runtime.sourceFingerprint) &&
      archives.get(runtime.sourceFingerprint) !== identity
    )
      throw new Error('Bundled DSH runtime fingerprint identifies conflicting archives')
    archives.set(runtime.sourceFingerprint, identity)
  }
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
  for (const runtime of selectedRuntimes) {
    await materializeRuntime(resourceRoot, cacheRoot, runtime, options)
  }
  await materializationStep('catalog-write', options, () =>
    writeRuntimeCatalog(cacheRoot, runtimes)
  )
  return cacheRoot
}

function writeRuntimeCatalog(cacheRoot: string, runtimes: RuntimeDescriptor[]): Promise<void> {
  const catalog = join(cacheRoot, 'runtimes.json')
  // Windows cannot replace the same destination with overlapping renames.
  return serializePathOperation(catalog, async () => {
    const temporary = join(cacheRoot, `.runtimes-${randomUUID()}.json`)
    try {
      await writeFile(temporary, `${JSON.stringify({ runtimes }, null, 2)}\n`, { mode: 0o600 })
      await rename(temporary, catalog)
    } finally {
      await rm(temporary, { force: true })
    }
  })
}

async function materializeRuntime(
  resourceRoot: string,
  cacheRoot: string,
  runtime: RuntimeDescriptor,
  options: MaterializeRuntimeOptions
): Promise<void> {
  validateDescriptor(runtime)
  const target = join(cacheRoot, runtime.sourceFingerprint)
  if (
    await materializationStep(
      'runtime-probe',
      options,
      () => runtimeMatches(target, runtime),
      runtime
    )
  )
    return
  await materializationStep(
    'runtime-publish',
    options,
    () => publishRuntime(resourceRoot, cacheRoot, runtime, options, target),
    runtime
  )
}

async function publishRuntime(
  resourceRoot: string,
  cacheRoot: string,
  runtime: RuntimeDescriptor,
  options: MaterializeRuntimeOptions,
  target: string
): Promise<void> {
  const fetchImpl = options.fetch ?? cloudFetch
  const resolveArchive = () =>
    materializationStep(
      'archive-resolve',
      options,
      () => resolveRuntimeArchive(resourceRoot, cacheRoot, runtime, fetchImpl),
      runtime
    )
  if (options.reuseRoot && resolve(options.reuseRoot) !== resolve(cacheRoot)) {
    const reusable = await reusableRuntime(options.reuseRoot, runtime)
    if (reusable) {
      // A matching cache never substitutes for integrity of the delivered archive.
      await resolveArchive()
      await linkImmutableDirectory(target, reusable, path => runtimeMatches(path, runtime))
      return
    }
  }
  // Prepared future runtimes must not enter the running source's role catalog.
  // Publish only immutable programs; each release retains its private catalog.
  const publication = options.immutableRoot
    ? join(
        options.immutableRoot,
        createHash('sha256')
          .update(
            JSON.stringify([
              runtime.sourceFingerprint,
              runtime.dshVersion,
              runtime.archiveSha256,
              runtime.archiveBytes,
            ])
          )
          .digest('hex')
      )
    : target
  const checkedArchive = options.immutableRoot ? await resolveArchive() : undefined
  await publishImmutableDirectory(
    publication,
    async content => {
      const archive = checkedArchive ?? (await resolveArchive())
      await materializationStep(
        'archive-extract',
        options,
        () => extractArchive(archive, content),
        runtime
      )
      if (!(await runtimeMatches(content, runtime))) {
        throw new Error(`Bundled DSH runtime identity is invalid: ${runtime.assetName}`)
      }
    },
    path => runtimeMatches(path, runtime)
  )
  if (publication !== target)
    await linkImmutableDirectory(target, publication, path => runtimeMatches(path, runtime))
}

async function reusableRuntime(root: string, runtime: RuntimeDescriptor): Promise<string | null> {
  let catalog: RuntimeCatalog
  try {
    catalog = JSON.parse(await readFile(join(root, 'runtimes.json'), 'utf8')) as RuntimeCatalog
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const matching = catalog.runtimes.filter(candidate =>
    ['sourceFingerprint', 'dshVersion', 'role', 'archiveSha256', 'archiveBytes'].every(
      key => candidate[key as keyof RuntimeDescriptor] === runtime[key as keyof RuntimeDescriptor]
    )
  )
  const content = join(root, runtime.sourceFingerprint)
  return matching.length === 1 && (await runtimeMatches(content, runtime)) ? content : null
}

async function extractArchive(archive: string, destination: string): Promise<void> {
  try {
    await extractPhysicalRelease(archive, destination)
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
