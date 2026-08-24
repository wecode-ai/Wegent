import { harnessAppsApi, type HarnessAppInstallation } from '@/api/local/harnessApps'
import type { LocalHarnessModelOption } from '@/features/local-harness/localHarnessModels'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import {
  registerHarnessAppTab,
  storeHarnessAppContextToken,
  storeHarnessAppProxyToken,
  takeHarnessAppContextToken,
  takeHarnessAppProxyToken,
  unregisterHarnessAppTab,
} from './harnessAppTabs'

type LocalHarnessModelApi = NonNullable<WorkbenchServices['localHarnessModelApi']>

interface StartHarnessAppDevelopmentRuntimeInput {
  installation: HarnessAppInstallation
  modelOptions: LocalHarnessModelOption[]
  localHarnessModelApi?: LocalHarnessModelApi
  missingWebUrlMessage: string
}

async function releaseHarnessAppRuntimeTokens(
  installationId: string,
  localHarnessModelApi?: LocalHarnessModelApi
): Promise<void> {
  const [proxyToken, contextToken] = await Promise.all([
    takeHarnessAppProxyToken(installationId),
    takeHarnessAppContextToken(installationId),
  ])
  await Promise.all([
    proxyToken
      ? localHarnessModelApi?.unregisterProxy(proxyToken).catch(() => undefined)
      : undefined,
    contextToken
      ? localHarnessModelApi?.unregisterContext(contextToken).catch(() => undefined)
      : undefined,
  ])
}

export async function stopHarnessAppDevelopmentRuntime(
  installationId: string,
  localHarnessModelApi?: LocalHarnessModelApi
): Promise<void> {
  await harnessAppsApi.stop(installationId)
  unregisterHarnessAppTab(installationId)
  await releaseHarnessAppRuntimeTokens(installationId, localHarnessModelApi)
}

export async function startHarnessAppDevelopmentRuntime({
  installation,
  modelOptions,
  localHarnessModelApi,
  missingWebUrlMessage,
}: StartHarnessAppDevelopmentRuntimeInput): Promise<HarnessAppInstallation> {
  if (installation.state === 'running' && installation.webUrl) {
    registerHarnessAppTab(installation)
    return installation
  }

  const model =
    modelOptions.find(option => option.key === installation.modelKey) ?? modelOptions[0] ?? null
  const launch =
    model && localHarnessModelApi
      ? await localHarnessModelApi.resolveLaunch('opencode', model)
      : null
  let started = false
  let proxyTokenStored = false
  let contextTokenStored = false
  try {
    const running = launch?.context
      ? await harnessAppsApi.start(
          installation.id,
          launch.baseUrl,
          launch.context.baseUrl,
          launch.context.token
        )
      : await harnessAppsApi.start(installation.id, launch?.baseUrl ?? null)
    started = true
    if (!running.webUrl) throw new Error(missingWebUrlMessage)
    if (launch) {
      await storeHarnessAppProxyToken(installation.id, launch.proxyToken)
      proxyTokenStored = true
    }
    if (launch?.context) {
      await storeHarnessAppContextToken(installation.id, launch.context.token)
      contextTokenStored = true
    }
    registerHarnessAppTab(running)
    return running
  } catch (error) {
    if (started) {
      await harnessAppsApi.stop(installation.id).catch(() => undefined)
      unregisterHarnessAppTab(installation.id)
      await releaseHarnessAppRuntimeTokens(installation.id, localHarnessModelApi)
    }
    if (launch?.proxyToken && !proxyTokenStored) {
      await localHarnessModelApi?.unregisterProxy(launch.proxyToken).catch(() => undefined)
    }
    if (launch?.context?.token && !contextTokenStored) {
      await localHarnessModelApi?.unregisterContext(launch.context.token).catch(() => undefined)
    }
    throw error
  }
}

export async function restartHarnessAppDevelopmentRuntime(
  installation: HarnessAppInstallation,
  modelOptions: LocalHarnessModelOption[],
  localHarnessModelApi: LocalHarnessModelApi | undefined,
  missingWebUrlMessage: string
): Promise<HarnessAppInstallation> {
  if (installation.state === 'running') {
    await stopHarnessAppDevelopmentRuntime(installation.id, localHarnessModelApi)
  }
  return startHarnessAppDevelopmentRuntime({
    installation: {
      ...installation,
      state: 'installed',
      webUrl: null,
      error: null,
    },
    modelOptions,
    localHarnessModelApi,
    missingWebUrlMessage,
  })
}
