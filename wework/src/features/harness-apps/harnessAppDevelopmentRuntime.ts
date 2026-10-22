import { harnessAppsApi, type HarnessAppInstallation } from '@/api/local/harnessApps'
import type { LocalHarnessModelOption } from '@/features/local-harness/localHarnessModels'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import {
  harnessAppDecisionScope,
  registerHarnessAppTab,
  storeHarnessAppContextToken,
  storeHarnessAppDecisionToken,
  storeHarnessAppProxyToken,
  takeHarnessAppContextToken,
  takeHarnessAppDecisionToken,
  takeHarnessAppProxyToken,
  unregisterHarnessAppTab,
} from './harnessAppTabs'

type LocalHarnessModelApi = NonNullable<WorkbenchServices['localHarnessModelApi']>
type LocalDecisionRouterApi = NonNullable<WorkbenchServices['localDecisionRouterApi']>

interface StartHarnessAppDevelopmentRuntimeInput {
  installation: HarnessAppInstallation
  modelOptions: LocalHarnessModelOption[]
  localHarnessModelApi?: LocalHarnessModelApi
  localDecisionRouterApi?: LocalDecisionRouterApi
  missingWebUrlMessage: string
}

async function releaseHarnessAppRuntimeTokens(
  installationId: string,
  localHarnessModelApi?: LocalHarnessModelApi,
  localDecisionRouterApi?: LocalDecisionRouterApi
): Promise<void> {
  const [proxyToken, contextToken, decisionToken] = await Promise.all([
    takeHarnessAppProxyToken(installationId),
    takeHarnessAppContextToken(installationId),
    takeHarnessAppDecisionToken(installationId),
  ])
  await Promise.allSettled([
    proxyToken ? localHarnessModelApi?.unregisterProxy(proxyToken) : undefined,
    contextToken ? localHarnessModelApi?.unregisterContext(contextToken) : undefined,
    decisionToken ? localDecisionRouterApi?.unregister(decisionToken) : undefined,
  ])
}

export async function stopHarnessAppDevelopmentRuntime(
  installationId: string,
  localHarnessModelApi?: LocalHarnessModelApi,
  localDecisionRouterApi?: LocalDecisionRouterApi
): Promise<void> {
  await harnessAppsApi.stop(installationId)
  unregisterHarnessAppTab(installationId)
  await releaseHarnessAppRuntimeTokens(installationId, localHarnessModelApi, localDecisionRouterApi)
}

export async function startHarnessAppDevelopmentRuntime({
  installation,
  modelOptions,
  localHarnessModelApi,
  localDecisionRouterApi,
  missingWebUrlMessage,
}: StartHarnessAppDevelopmentRuntimeInput): Promise<HarnessAppInstallation> {
  if (installation.state === 'running' && installation.webUrl) {
    registerHarnessAppTab(installation)
    return installation
  }

  const model =
    modelOptions.find(option => option.key === installation.modelKey) ?? modelOptions[0] ?? null
  const decisionGranted = installation.grantedCapabilities?.decisionModel === true
  let launch: Awaited<ReturnType<LocalHarnessModelApi['resolveLaunch']>> | null = null
  let decisionLaunch: Awaited<ReturnType<LocalDecisionRouterApi['resolveLaunch']>> | null = null
  let started = false
  let proxyTokenStored = false
  let contextTokenStored = false
  let decisionTokenStored = false
  try {
    if (decisionGranted && !localDecisionRouterApi) {
      throw new Error('The Wework decision router is unavailable')
    }
    launch =
      model && localHarnessModelApi
        ? await localHarnessModelApi.resolveLaunch('opencode', model)
        : null
    // Register the decision route before the app starts, so a failure here
    // never leaves the Smart App with a half-configured router.
    decisionLaunch =
      decisionGranted && localDecisionRouterApi
        ? await localDecisionRouterApi.resolveLaunch(harnessAppDecisionScope(installation.id))
        : null
    const running = await harnessAppsApi.start({
      installationId: installation.id,
      modelBaseUrl: launch?.baseUrl ?? null,
      contextBaseUrl: launch?.context?.baseUrl ?? null,
      contextToken: launch?.context?.token ?? null,
      decisionBaseUrl: decisionLaunch?.baseUrl ?? null,
      decisionProtocolVersion: decisionLaunch?.protocolVersion ?? null,
    })
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
    if (decisionLaunch) {
      await storeHarnessAppDecisionToken(installation.id, decisionLaunch.token)
      decisionTokenStored = true
    }
    registerHarnessAppTab(running)
    return running
  } catch (error) {
    if (started) {
      await harnessAppsApi.stop(installation.id).catch(() => undefined)
      unregisterHarnessAppTab(installation.id)
      await releaseHarnessAppRuntimeTokens(
        installation.id,
        localHarnessModelApi,
        localDecisionRouterApi
      )
    }
    if (launch?.proxyToken && !proxyTokenStored) {
      await localHarnessModelApi?.unregisterProxy(launch.proxyToken).catch(() => undefined)
    }
    if (launch?.context?.token && !contextTokenStored) {
      await localHarnessModelApi?.unregisterContext(launch.context.token).catch(() => undefined)
    }
    if (decisionLaunch && !decisionTokenStored) {
      await localDecisionRouterApi?.unregister(decisionLaunch.token).catch(() => undefined)
    }
    throw error
  }
}

export async function restartHarnessAppDevelopmentRuntime(
  installation: HarnessAppInstallation,
  modelOptions: LocalHarnessModelOption[],
  localHarnessModelApi: LocalHarnessModelApi | undefined,
  missingWebUrlMessage: string,
  localDecisionRouterApi?: LocalDecisionRouterApi
): Promise<HarnessAppInstallation> {
  if (installation.state === 'running') {
    await stopHarnessAppDevelopmentRuntime(
      installation.id,
      localHarnessModelApi,
      localDecisionRouterApi
    )
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
    localDecisionRouterApi,
    missingWebUrlMessage,
  })
}
