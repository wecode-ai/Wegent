import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { ComponentUpdateManager } from './component-update-manager.js'
import { migrateCodexProviderState } from './codex-provider-upgrade.js'
import {
  optionalText,
  ReleaseStore,
  sameReleasePath,
  type DesktopRelease,
} from './release-store.js'
import { assertExecutorWorkbenchCompatibility } from './workbench-executor-schema.js'

interface StoppedRequest {
  protocol: number
  release: DesktopRelease
  token: string
  storeRoot: string
  dataDirectory: string
  codexHome: string
  workbenchRoot: string
}

/** Target-owned data work; do not start native runtimes or import main here. */
export async function prepareStoppedReleaseData(
  requestFile: string,
  resources: string,
  metadata: { version: string; weworkAfterStopPreparation?: unknown; weworkDataSchema?: number }
): Promise<{ protocol: 1; token: string; releaseId: string; complete: true }> {
  const request: StoppedRequest = JSON.parse(await readFile(requestFile, 'utf8'))
  if (
    request.protocol !== 1 ||
    metadata.weworkAfterStopPreparation !== 1 ||
    request.release.version !== metadata.version ||
    request.release.dataSchema !== metadata.weworkDataSchema ||
    ![request.storeRoot, request.dataDirectory, request.codexHome, request.workbenchRoot].every(
      value => typeof value === 'string' && isAbsolute(value)
    )
  )
    throw new Error('Stopped-release preparation request does not match the delivered target')
  if (!(await sameReleasePath(resources, request.release.resources)))
    throw new Error('Stopped-release preparation request does not match the delivered target')
  const store = new ReleaseStore(request.storeRoot)
  const activation = await store.activation()
  const saved = await store.read(request.release.id)
  if (
    !activation ||
    activation.to !== saved.id ||
    activation.token !== request.token ||
    activation.rollbackRequested ||
    (await store.active())?.id !== saved.id ||
    saved.packageSha256 !== request.release.packageSha256 ||
    !saved.packageSha256 ||
    saved.version !== metadata.version ||
    saved.dataSchema !== metadata.weworkDataSchema ||
    (await optionalText(join(store.root, 'data-opened'))) !== request.token ||
    (await optionalText(join(store.root, 'attempted'))) === request.token
  )
    throw new Error('Stopped-release preparation has no unstarted activation ownership')
  if (!(await sameReleasePath(resources, saved.resources)))
    throw new Error('Stopped-release preparation has no unstarted activation ownership')
  const manager = new ComponentUpdateManager({
    resourcesRoot: resources,
    dataDirectory: store.slot(saved.id),
    currentAppVersion: metadata.version,
    updateBaseUrl: '',
    fetch: async () => {
      throw new Error('Stopped preparation requires complete delivered assets')
    },
    validateExecutor: path =>
      assertExecutorWorkbenchCompatibility({ ...process.env, WEWORK_EXECUTOR_PATH: path }),
  })
  const components = await manager.prepareStartup()
  await migrateCodexProviderState(
    {
      dataDirectory: request.dataDirectory,
      environment: {
        ...process.env,
        WEWORK_EXECUTOR_PATH: components.executor,
        WEGENT_CODEX_HOME: request.codexHome,
        WEGENT_WORKBENCH_HOME: request.workbenchRoot,
      },
    },
    undefined,
    true
  )
  if (
    (await store.activation())?.token !== request.token ||
    (await store.active())?.id !== saved.id
  )
    throw new Error('Stopped-release preparation lost activation ownership')
  return { protocol: 1, token: request.token, releaseId: saved.id, complete: true }
}
