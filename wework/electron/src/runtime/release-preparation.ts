import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { materializeBundledRuntimes } from './bundled-runtime-materializer.js'
import { ComponentUpdateManager } from './component-update-manager.js'
import { prepareCoreDshRuntime } from './core-dsh-runtime.js'
import { cloneReleaseProfile, profileRevision } from './release-profile.js'
import { atomicReleaseWrite, ReleaseStore, type DesktopRelease } from './release-store.js'
import { assertExecutorWorkbenchCompatibility } from './workbench-executor-schema.js'
import { RotatingLog } from './rotating-log.js'
import { recoverReleaseLayout } from './release-layout-recovery.js'

export interface ReleasePreparationRequest {
  release: DesktopRelease
  storeRoot: string
  sourceProfile: string
}

export async function preparationStep<T>(
  log: Pick<RotatingLog, 'write'>,
  release: DesktopRelease,
  stage: string,
  run: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now()
  const write = (phase: string) =>
    log
      .write(
        'supervisor',
        JSON.stringify({
          event: 'release-preparation-stage',
          releaseId: release.id,
          version: release.version,
          stage,
          phase,
          elapsedMs: Math.round(performance.now() - startedAt),
        })
      )
      .catch(error => {
        console.error('[release-preparation-log]', error)
      })
  await write('started')
  try {
    const result = await run()
    await write('completed')
    return result
  } catch (error) {
    await write('failed')
    throw error
  }
}

/** Runs in the target package, before importing main or opening any live application data. */
export async function prepareReleaseEnvironment(
  requestFile: string,
  resources: string,
  version: string,
  dataSchema: number,
  readableDataSchemas: number[]
): Promise<void> {
  const request = JSON.parse(await readFile(requestFile, 'utf8')) as ReleasePreparationRequest
  const { release } = request
  if (
    version !== release.version ||
    resources !== release.resources ||
    dataSchema !== release.dataSchema ||
    JSON.stringify([...readableDataSchemas].sort()) !==
      JSON.stringify([...release.readableDataSchemas].sort())
  )
    throw new Error('Target release identity does not match the selected package')
  const store = new ReleaseStore(request.storeRoot)
  const log = new RotatingLog({
    path: join(dirname(request.storeRoot), 'logs', 'release-preparation.log'),
  })
  const step = <T>(stage: string, run: () => Promise<T>) =>
    preparationStep(log, release, stage, run)
  const sourceRevision = await step('profile-copy', () =>
    cloneReleaseProfile(request.sourceProfile, release.profileRoot)
  )
  const bundledAssetsOnly: typeof fetch = async () => {
    throw new Error('The complete release package is missing preparation assets')
  }
  const manager = new ComponentUpdateManager({
    resourcesRoot: resources,
    dataDirectory: store.slot(release.id),
    currentAppVersion: version,
    updateBaseUrl: '',
    fetch: bundledAssetsOnly,
    validateExecutor: path =>
      assertExecutorWorkbenchCompatibility({ ...process.env, WEWORK_EXECUTOR_PATH: path }),
  })
  const components = await step('components', () => manager.prepareStartup())
  await step('runtimes', () =>
    materializeBundledRuntimes(components.coreDsh, release.runtimeRoot, ['core', 'workbench'], {
      fetch: bundledAssetsOnly,
    })
  )
  const preparationHome = join(store.slot(release.id), 'preparation')
  // The prepared profile is isolated; DSH's live data stays in the stable DSH_HOME.
  await mkdir(join(preparationHome, 'dsh-core', 'profiles'), { recursive: true, mode: 0o700 })
  const { symlink } = await import('node:fs/promises')
  await rm(join(preparationHome, 'dsh-core', 'profiles', 'wework-core'), { force: true })
  await symlink(
    release.profileRoot,
    join(preparationHome, 'dsh-core', 'profiles', 'wework-core'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  await step('profile-prepare', () =>
    prepareCoreDshRuntime({
      runtimeRoot: release.runtimeRoot,
      dataDirectory: preparationHome,
      environment: {
        ...process.env,
        WEWORK_CORE_PLUGIN_ROOT: components.weworkCorePlugins,
        WEWORK_CORE_PLUGINS_SHA256: components.contentSha256.weworkCorePlugins,
      },
    })
  )
  if ((await profileRevision(request.sourceProfile)) !== sourceRevision)
    throw new Error('Plugin configuration changed during update preparation')
  await atomicReleaseWrite(
    join(store.slot(release.id), 'prepared.json'),
    JSON.stringify({ sourceRevision, components })
  )
  await store.save(release)
  await step('source-layout-recovery', () =>
    recoverReleaseLayout(store, request.sourceProfile, release.dataSchema)
  )
}
