import { harnessAppsApi, type HarnessAppInstallation } from '@/api/local/harnessApps'
import type { LocalHarnessModelOption } from '@/features/local-harness/localHarnessModels'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import {
  harnessAppDecisionScope,
  registerHarnessAppTab,
  storeHarnessAppAdditionalProxyTokens,
  storeHarnessAppContextToken,
  storeHarnessAppDecisionToken,
  storeHarnessAppProxyToken,
  unregisterHarnessAppTab,
} from './harnessAppTabs'
import { registerAdditionalHarnessAppModels } from './harnessAppModelRoutes'
import { releaseHarnessAppRoutes } from './harnessAppRoutes'

type LocalHarnessModelApi = NonNullable<WorkbenchServices['localHarnessModelApi']>
type LocalDecisionRouterApi = NonNullable<WorkbenchServices['localDecisionRouterApi']>

interface StartHarnessAppDevelopmentRuntimeInput {
  installation: HarnessAppInstallation
  modelOptions: LocalHarnessModelOption[]
  localHarnessModelApi?: LocalHarnessModelApi
  localDecisionRouterApi?: LocalDecisionRouterApi
  missingWebUrlMessage: string
}

export async function stopHarnessAppDevelopmentRuntime(
  installationId: string,
  localHarnessModelApi?: LocalHarnessModelApi,
  localDecisionRouterApi?: LocalDecisionRouterApi
): Promise<void> {
  await harnessAppsApi.stop(installationId)
  unregisterHarnessAppTab(installationId)
  await releaseHarnessAppRoutes(installationId, localHarnessModelApi, localDecisionRouterApi)
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
  const additionalProxyTokens: string[] = []
  let decisionLaunch: Awaited<ReturnType<LocalDecisionRouterApi['resolveLaunch']>> | null = null
  let started = false
  let proxyTokenStored = false
  let additionalProxyTokensStored = false
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
    const additionalModels =
      launch && model && localHarnessModelApi
        ? await registerAdditionalHarnessAppModels(
            model,
            modelOptions,
            localHarnessModelApi,
            token => additionalProxyTokens.push(token)
          )
        : []
    // Register the decision route before the app starts, so a failure here
    // never leaves the Smart App with a half-configured router.
    decisionLaunch =
      decisionGranted && localDecisionRouterApi
        ? await localDecisionRouterApi.resolveLaunch(harnessAppDecisionScope(installation.id))
        : null
    const running = await harnessAppsApi.start({
      installationId: installation.id,
      modelBaseUrl: launch?.baseUrl ?? null,
      ...(additionalModels.length ? { additionalModels } : {}),
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
    if (additionalProxyTokens.length) {
      await storeHarnessAppAdditionalProxyTokens(installation.id, additionalProxyTokens)
      additionalProxyTokensStored = true
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
      await releaseHarnessAppRoutes(installation.id, localHarnessModelApi, localDecisionRouterApi)
    }
    if (launch?.proxyToken && !proxyTokenStored) {
      await localHarnessModelApi?.unregisterProxy(launch.proxyToken).catch(() => undefined)
    }
    if (!additionalProxyTokensStored) {
      await Promise.allSettled(
        additionalProxyTokens.map(token => localHarnessModelApi?.unregisterProxy(token))
      )
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
