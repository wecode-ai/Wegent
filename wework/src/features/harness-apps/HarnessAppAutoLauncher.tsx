import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { harnessAppsApi } from '@/api/local/harnessApps'
import {
  beginHarnessAppLaunch,
  clearHarnessAppLaunch,
  failHarnessAppLaunch,
} from '@/features/harness-apps/harnessAppLaunchState'
import {
  harnessAppDecisionScope,
  registerHarnessAppTab,
  storeHarnessAppAdditionalProxyTokens,
  storeHarnessAppContextToken,
  storeHarnessAppDecisionToken,
  storeHarnessAppProxyToken,
  unregisterHarnessAppTab,
} from '@/features/harness-apps/harnessAppTabs'
import { registerAdditionalHarnessAppModels } from '@/features/harness-apps/harnessAppModelRoutes'
import { releaseHarnessAppRoutes } from './harnessAppRoutes'
import { runHarnessAppRuntimeOperation } from './harnessAppRuntimeOperations'
import { notifyHarnessAppInstallationsChanged } from './harnessAppInstallationsChanged'
import { listLocalHarnessModelOptions } from '@/features/local-harness/localHarnessModels'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import { getSmartAppErrorMessage } from '@/lib/smart-app-error-message'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { observeHarnessAppLaunchCatalog } from '@/e2e/harness-app-launch-diagnostics'

interface LaunchLifetime {
  closed: boolean
}

const launches = new Map<string, { lifetime: LaunchLifetime; promise: Promise<void> }>()

interface HarnessAppAutoLauncherProps {
  installationId: string
  onStartupSettled?: (installationId: string) => void
}

export function HarnessAppAutoLauncher({
  installationId,
  onStartupSettled,
}: HarnessAppAutoLauncherProps) {
  const { t } = useTranslation('common')
  const { projectChat, services } = useWorkbench()
  const [attempt, setAttempt] = useState(0)
  const modelOptions = useMemo(
    () => listLocalHarnessModelOptions('opencode', projectChat.models),
    [projectChat.models]
  )
  const committedModelOptions = useRef(modelOptions)
  useLayoutEffect(() => {
    committedModelOptions.current = modelOptions
  }, [modelOptions])
  useEffect(() => {
    if (import.meta.env.MODE === 'e2e' || import.meta.env.VITE_WEWORK_E2E === 'true') {
      return observeHarnessAppLaunchCatalog(
        installationId,
        modelOptions.map(option => option.label)
      )
    }
  }, [installationId, modelOptions])
  // Effect cleanup also runs when the model catalog changes, so it cannot
  // stand in for the tab being closed. App keeps pending owners connected
  // through Activity hiding; removing that owner ends this launch lifetime.
  const lifetimeRef = useRef<LaunchLifetime | null>(null)

  useEffect(() => {
    const lifetime = { closed: false }
    lifetimeRef.current = lifetime
    return () => {
      lifetime.closed = true
    }
  }, [installationId])

  useEffect(() => {
    const lifetime = lifetimeRef.current
    if (!lifetime) return
    let cancelled = false
    const settle = () => {
      if (!cancelled) onStartupSettled?.(installationId)
    }
    const modelApi = services.localHarnessModelApi
    if (!modelApi) {
      settle()
      return
    }
    const existingLaunch = launches.get(installationId)
    if (existingLaunch && !existingLaunch.lifetime.closed) {
      void existingLaunch.promise.finally(settle)
      return () => {
        cancelled = true
      }
    }
    const retry = () => setAttempt(current => current + 1)

    const launch = runHarnessAppRuntimeOperation(installationId, async () => {
      if (lifetime.closed) return
      const installations = await harnessAppsApi.list()
      const installation = installations.find(item => item.id === installationId)
      if (!installation || lifetime.closed) {
        clearHarnessAppLaunch(installationId)
        return
      }
      if (installation.state === 'running' && installation.webUrl) {
        registerHarnessAppTab(installation)
        notifyHarnessAppInstallationsChanged({
          type: 'updated',
          installationId,
          installation,
        })
        if (isElectronRuntime()) clearHarnessAppLaunch(installationId)
        return
      }
      // A reopen can wait behind old route cleanup while its catalog loads.
      // Select once from committed state; later refreshes cannot mix providers.
      const launchModelOptions = committedModelOptions.current
      const model = launchModelOptions.find(option => option.key === installation.modelKey)
      if (!model) {
        beginHarnessAppLaunch(installationId, installation.manifest.displayName, retry)
        failHarnessAppLaunch(
          installationId,
          t('workbench.smart_apps_model_unavailable', '智能工作台配置的模型不可用')
        )
        return
      }

      beginHarnessAppLaunch(installationId, installation.manifest.displayName, retry)
      const decisionApi = services.localDecisionRouterApi
      const decisionGranted = installation.grantedCapabilities?.decisionModel === true
      let proxyToken: string | null = null
      const additionalProxyTokens: string[] = []
      let contextToken: string | null = null
      let decisionToken: string | null = null
      let started = false
      let stage = 'default-model-route'
      const assertOpen = () => {
        if (lifetime.closed) throw new Error('Smart app tab closed during launch')
      }
      try {
        const launch = await modelApi.resolveLaunch('opencode', model)
        if (!launch) {
          throw new Error(
            t('workbench.smart_apps_model_proxy_unavailable', '智能工作台模型代理不可用')
          )
        }
        proxyToken = launch.proxyToken
        contextToken = launch.context?.token ?? null
        assertOpen()
        stage = 'additional-model-routes'
        const additionalModels = await registerAdditionalHarnessAppModels(
          model,
          launchModelOptions,
          modelApi,
          token => additionalProxyTokens.push(token)
        )
        assertOpen()
        let decision: { baseUrl: string; protocolVersion: number } | null = null
        if (decisionGranted) {
          stage = 'decision-route'
          if (!decisionApi) {
            throw new Error(
              t('workbench.smart_apps_decision_router_unavailable', '智能工作台决策路由不可用')
            )
          }
          // Register the decision route before starting the app; if this fails
          // the app never sees a half-configured router.
          const decisionLaunch = await decisionApi.resolveLaunch(
            harnessAppDecisionScope(installationId)
          )
          decisionToken = decisionLaunch.token
          assertOpen()
          decision = {
            baseUrl: decisionLaunch.baseUrl,
            protocolVersion: decisionLaunch.protocolVersion,
          }
        }
        stage = 'start-runtime'
        const running = await harnessAppsApi.start({
          installationId,
          modelBaseUrl: launch.baseUrl,
          ...(additionalModels.length ? { additionalModels } : {}),
          contextBaseUrl: launch.context?.baseUrl ?? null,
          contextToken: launch.context?.token ?? null,
          decisionBaseUrl: decision?.baseUrl ?? null,
          decisionProtocolVersion: decision?.protocolVersion ?? null,
        })
        started = true
        // The tab can close while the runtime is starting; stop and release
        // through the normal failure path instead of leaking the new routes.
        assertOpen()
        if (!running.webUrl) {
          throw new Error(t('workbench.smart_apps_missing_web_url', '智能工作台没有返回可用地址'))
        }
        stage = 'store-default-proxy-token'
        await storeHarnessAppProxyToken(installationId, launch.proxyToken)
        assertOpen()
        if (additionalProxyTokens.length) {
          stage = 'store-additional-proxy-tokens'
          await storeHarnessAppAdditionalProxyTokens(installationId, additionalProxyTokens)
          assertOpen()
        }
        if (contextToken) {
          stage = 'store-context-token'
          await storeHarnessAppContextToken(installationId, contextToken)
          assertOpen()
        }
        if (decisionToken) {
          stage = 'store-decision-token'
          await storeHarnessAppDecisionToken(installationId, decisionToken)
          assertOpen()
        }
        stage = 'register-tab'
        registerHarnessAppTab(running)
        notifyHarnessAppInstallationsChanged({
          type: 'updated',
          installationId,
          installation: running,
        })
        if (isElectronRuntime()) clearHarnessAppLaunch(installationId)
      } catch (error) {
        console.warn(
          `[Wework] Smart app launch diagnostic ${JSON.stringify({
            installationId,
            stage,
            started,
            errorName: error instanceof Error ? error.name : 'unknown',
          })}`
        )
        if (started) {
          await harnessAppsApi.stop(installationId).catch(() => undefined)
          unregisterHarnessAppTab(installationId)
        }
        await releaseHarnessAppRoutes(installationId, modelApi, decisionApi, {
          proxyToken,
          additionalProxyTokens,
          contextToken,
          decisionToken,
        })
        if (lifetime.closed) {
          clearHarnessAppLaunch(installationId)
        } else {
          failHarnessAppLaunch(
            installationId,
            getSmartAppErrorMessage(
              error,
              t('workbench.smart_apps_launch_failed', '智能工作台启动失败'),
              t
            )
          )
        }
      }
    })
      .catch(error => {
        if (!lifetime.closed) {
          beginHarnessAppLaunch(
            installationId,
            t('workbench.smart_apps_title', '智能工作台'),
            retry
          )
          failHarnessAppLaunch(
            installationId,
            getSmartAppErrorMessage(
              error,
              t('workbench.smart_apps_load_failed', '智能工作台加载失败'),
              t
            )
          )
        }
      })
      .finally(() => {
        if (launches.get(installationId)?.promise === launch) launches.delete(installationId)
      })
    launches.set(installationId, { lifetime, promise: launch })
    void launch.finally(settle)

    return () => {
      cancelled = true
    }
  }, [
    attempt,
    installationId,
    modelOptions,
    onStartupSettled,
    services.localDecisionRouterApi,
    services.localHarnessModelApi,
    t,
  ])

  return null
}
