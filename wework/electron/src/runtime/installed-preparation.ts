import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { materializeBundledRuntimes } from './bundled-runtime-materializer.js'
import { ComponentUpdateManager, type ComponentPaths } from './component-update-manager.js'
import { prepareCoreDshRuntime } from './core-dsh-runtime.js'
import { atomicReleaseWrite } from './release-store.js'
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
  const preparedProfile = await preparationStep(options, 'profile-prepare', () =>
    prepareCoreDshRuntime({
      runtimeRoot,
      dataDirectory: options.dataDirectory,
      environment: {
        ...environment,
        WEWORK_CORE_PLUGIN_ROOT: components.weworkCorePlugins,
        WEWORK_CORE_PLUGINS_SHA256: components.contentSha256.weworkCorePlugins,
      },
    })
  )
  await manager.confirmStartup()
  const result = {
    version: options.version,
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
  return result
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
