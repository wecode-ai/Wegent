import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { extract } from 'tar'

interface RuntimeDescriptor {
  dshVersion: string
  role: string
  sourceFingerprint: string
  archiveSha256: string
  archiveBytes: number
  assetName: string
}

interface RuntimeCatalog {
  runtimes: RuntimeDescriptor[]
}

export type BundledRuntimeRole = 'core' | 'workbench'

export async function materializeBundledRuntimes(
  resourceRoot: string,
  cacheRoot: string,
  roles: readonly BundledRuntimeRole[] = ['core', 'workbench']
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
  const selectedRuntimes = runtimes.filter(runtime =>
    requestedRoles.has(runtime.role as BundledRuntimeRole)
  )
  const selectedRoles = new Set(selectedRuntimes.map(runtime => runtime.role))
  if ([...requestedRoles].some(role => !selectedRoles.has(role))) {
    throw new Error('Bundled Electron runtime catalog is missing a requested runtime')
  }
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 })
  for (const runtime of selectedRuntimes) {
    await materializeRuntime(resourceRoot, cacheRoot, runtime)
  }
  await writeFile(join(cacheRoot, 'runtimes.json'), `${JSON.stringify({ runtimes }, null, 2)}\n`, {
    mode: 0o600,
  })
  return cacheRoot
}

async function materializeRuntime(
  resourceRoot: string,
  cacheRoot: string,
  runtime: RuntimeDescriptor
): Promise<void> {
  validateDescriptor(runtime)
  const target = join(cacheRoot, runtime.sourceFingerprint)
  if (await runtimeMatches(target, runtime)) return
  const archive = join(resourceRoot, runtime.assetName)
  const metadata = await stat(archive)
  if (metadata.size !== runtime.archiveBytes) {
    throw new Error(`Bundled DSH runtime size mismatch: ${runtime.assetName}`)
  }
  const bytes = await readFile(archive)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== runtime.archiveSha256) {
    throw new Error(`Bundled DSH runtime checksum mismatch: ${runtime.assetName}`)
  }
  const temporary = `${target}.${process.pid}.tmp`
  await rm(temporary, { recursive: true, force: true })
  await mkdir(temporary, { recursive: true, mode: 0o700 })
  try {
    await extractArchive(archive, temporary)
    if (!(await runtimeMatches(temporary, runtime))) {
      throw new Error(`Bundled DSH runtime identity is invalid: ${runtime.assetName}`)
    }
    await rm(target, { recursive: true, force: true })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { recursive: true, force: true })
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
    !runtime.assetName.endsWith('.tar.gz')
  ) {
    throw new Error('Bundled DSH runtime descriptor is invalid')
  }
}
