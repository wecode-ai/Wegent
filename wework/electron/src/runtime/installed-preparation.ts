import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { materializeBundledRuntimes } from './bundled-runtime-materializer.js'
import { ComponentUpdateManager, type ComponentPaths } from './component-update-manager.js'
import { prepareCoreDshRuntime } from './core-dsh-runtime.js'
import {
  inspectInstalledProfileSource,
  installedPreparationDirectory,
  installedPreparationMarkerFile,
  installedPreparationProfileRoot,
  writeInstalledPreparationMarker,
  type InstalledPreparationMarker,
  type InstalledPreparationProfileSource,
} from './installed-preparation-state.js'
import { cloneReleaseProfile, currentCoreProfile, profileRevision } from './release-profile.js'
import { atomicReleaseWrite, sameReleasePath } from './release-store.js'
import { assertExecutorWorkbenchCompatibility } from './workbench-executor-schema.js'

export interface InstalledPreparationOptions {
  resourcesRoot: string
  dataDirectory: string
  componentDataDirectory?: string
  version: string
  updateBaseUrl: string
  environment?: NodeJS.ProcessEnv
  statusFile?: string
  onProgress?: (event: InstalledPreparationProgress) => void
}

export interface InstalledPreparationProgress {
  stage: 'components' | 'runtimes' | 'profile-prepare'
  phase: 'started' | 'completed' | 'failed'
  elapsedMs: number
}

export interface InstalledPreparationResult {
  version: string
  preparationDirectory: string
  profileRoot: string
  source: InstalledPreparationProfileSource
  componentDataDirectory: string
  runtimeRoot: string
  dshHome: string
  components: ComponentPaths
  durationMs: number
}

export async function prepareInstalledEnvironment(
  options: InstalledPreparationOptions
): Promise<InstalledPreparationResult> {
  const environment = options.environment ?? process.env
  const preparationDirectory = installedPreparationDirectory(options.dataDirectory, options.version)
  const profileRoot = installedPreparationProfileRoot(options.dataDirectory, options.version)
  const profilePointer = currentCoreProfile(options.dataDirectory)
  await rm(installedPreparationMarkerFile(options.dataDirectory, options.version), { force: true })
  const componentDataDirectory = options.componentDataDirectory ?? options.dataDirectory
  const runtimeRoot =
    environment.WEWORK_HARNESS_RUNTIME_ROOT?.trim() ||
    join(options.dataDirectory, 'managed-runtimes', 'dsh')
  const bundledAssetsOnly: typeof fetch = async () => {
    throw new Error('The installed package is missing required bundled assets')
  }
  const manager = new ComponentUpdateManager({
    resourcesRoot: options.resourcesRoot,
    dataDirectory: componentDataDirectory,
    currentAppVersion: options.version,
    updateBaseUrl: options.updateBaseUrl,
    fetch: bundledAssetsOnly,
    validateExecutor: path =>
      assertExecutorWorkbenchCompatibility({
        ...environment,
        WEWORK_EXECUTOR_PATH: environment.WEWORK_EXECUTOR_PATH?.trim() || path,
      }),
  })
  const startedAt = performance.now()
  const components = await preparationStep(options, 'components', () => manager.prepareStartup())
  await preparationStep(options, 'runtimes', () =>
    materializeBundledRuntimes(components.coreDsh, runtimeRoot, ['core'], {
      fetch: bundledAssetsOnly,
    })
  )
  const source = await inspectInstalledProfileSource(profilePointer)
  const reusedPreparedProfile =
    source.kind === 'profile' && (await sameReleasePath(source.resolvedPath!, profileRoot))
  if (source.kind === 'missing') await rm(profileRoot, { recursive: true, force: true })
  const preparedProfile = await preparationStep(options, 'profile-prepare', async () => {
    if (source.kind === 'profile' && !reusedPreparedProfile)
      await cloneReleaseProfile(profilePointer, profileRoot)
    return prepareCoreDshRuntime({
      runtimeRoot,
      dataDirectory: preparationDirectory,
      environment: {
        ...environment,
        WEWORK_CORE_PLUGIN_ROOT: components.weworkCorePlugins,
        WEWORK_CORE_PLUGINS_SHA256: components.contentSha256.weworkCorePlugins,
      },
    })
  })
  await assertProfileSourceUnchanged(profilePointer, source, reusedPreparedProfile)
  const marker: InstalledPreparationMarker = {
    schemaVersion: 1,
    token: randomUUID(),
    version: options.version,
    preparationDirectory,
    profileRoot,
    preparedRevision: await profileRevision(profileRoot),
    source,
    reusedPreparedProfile,
  }
  const result = {
    version: options.version,
    preparationDirectory,
    profileRoot,
    source,
    componentDataDirectory,
    runtimeRoot,
    dshHome: preparedProfile.dshHome,
    components,
    durationMs: Math.round(performance.now() - startedAt),
  } satisfies InstalledPreparationResult
  if (options.statusFile) {
    await mkdir(dirname(options.statusFile), { recursive: true })
    await atomicReleaseWrite(options.statusFile, `${JSON.stringify(result, null, 2)}\n`)
  }
  await writeInstalledPreparationMarker(options.dataDirectory, marker)
  return result
}

async function assertProfileSourceUnchanged(
  pointer: string,
  before: InstalledPreparationProfileSource,
  reusedPreparedProfile: boolean
): Promise<void> {
  if (reusedPreparedProfile) return
  const after = await inspectInstalledProfileSource(pointer)
  if (
    after.kind !== before.kind ||
    (before.kind === 'profile' &&
      (after.resolvedPath !== before.resolvedPath || after.revision !== before.revision))
  )
    throw new Error('Plugins changed while preparing the installation; prepare again')
}

async function preparationStep<T>(
  options: InstalledPreparationOptions,
  stage: InstalledPreparationProgress['stage'],
  run: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now()
  const report = (phase: InstalledPreparationProgress['phase']) => {
    try {
      options.onProgress?.({
        stage,
        phase,
        elapsedMs: Math.round(performance.now() - startedAt),
      })
    } catch {
      // Diagnostics must never interrupt installation preparation.
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
