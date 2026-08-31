import { useEffect, useMemo, useState } from 'react'
import { harnessAppsApi } from '@/api/local/harnessApps'
import {
  beginHarnessAppLaunch,
  clearHarnessAppLaunch,
  failHarnessAppLaunch,
} from '@/features/harness-apps/harnessAppLaunchState'
import {
  registerHarnessAppTab,
  storeHarnessAppContextToken,
  storeHarnessAppProxyToken,
  takeHarnessAppContextToken,
  takeHarnessAppProxyToken,
  unregisterHarnessAppTab,
} from '@/features/harness-apps/harnessAppTabs'
import { listLocalHarnessModelOptions } from '@/features/local-harness/localHarnessModels'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useTranslation } from '@/hooks/useTranslation'
import { getErrorMessage } from '@/lib/error-message'
import { isElectronRuntime } from '@/lib/runtime-environment'

const launches = new Map<string, Promise<void>>()

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

  useEffect(() => {
    let cancelled = false
    const settle = () => {
      if (!cancelled) onStartupSettled?.(installationId)
    }
    if (!services.localHarnessModelApi) {
      settle()
      return
    }
    const existingLaunch = launches.get(installationId)
    if (existingLaunch) {
      void existingLaunch.finally(settle)
      return () => {
        cancelled = true
      }
    }
    const retry = () => setAttempt(current => current + 1)

    const launch = harnessAppsApi
      .list()
      .then(async installations => {
        const installation = installations.find(item => item.id === installationId)
        if (!installation || cancelled) {
          clearHarnessAppLaunch(installationId)
          return
        }
        if (installation.state === 'running' && installation.webUrl) {
          registerHarnessAppTab(installation)
          if (isElectronRuntime()) clearHarnessAppLaunch(installationId)
          return
        }
        const model = modelOptions.find(option => option.key === installation.modelKey)
        if (!model) {
          beginHarnessAppLaunch(installationId, installation.manifest.displayName, retry)
          failHarnessAppLaunch(
            installationId,
            t('workbench.smart_apps_model_unavailable', '智能工作台配置的模型不可用')
          )
          return
        }

        beginHarnessAppLaunch(installationId, installation.manifest.displayName, retry)
        let proxyToken: string | null = null
        let contextToken: string | null = null
        let started = false
        try {
          const launch = await services.localHarnessModelApi?.resolveLaunch('opencode', model)
          if (!launch) {
            throw new Error(
              t('workbench.smart_apps_model_proxy_unavailable', '智能工作台模型代理不可用')
            )
          }
          proxyToken = launch.proxyToken
          contextToken = launch.context?.token ?? null
          const running = launch.context
            ? await harnessAppsApi.start(
                installationId,
                launch.baseUrl,
                launch.context.baseUrl,
                launch.context.token
              )
            : await harnessAppsApi.start(installationId, launch.baseUrl)
          started = true
          if (!running.webUrl) {
            throw new Error(t('workbench.smart_apps_missing_web_url', '智能工作台没有返回可用地址'))
          }
          await storeHarnessAppProxyToken(installationId, launch.proxyToken)
          if (contextToken) await storeHarnessAppContextToken(installationId, contextToken)
          registerHarnessAppTab(running)
          if (isElectronRuntime()) clearHarnessAppLaunch(installationId)
        } catch (error) {
          console.warn(`[Wework] failed to auto-launch Smart app ${installationId}`, error)
          if (started) {
            await harnessAppsApi.stop(installationId).catch(() => undefined)
            unregisterHarnessAppTab(installationId)
            await takeHarnessAppProxyToken(installationId)
            await takeHarnessAppContextToken(installationId)
          }
          if (proxyToken) {
            await services.localHarnessModelApi?.unregisterProxy(proxyToken).catch(() => undefined)
          }
          if (contextToken) {
            await services.localHarnessModelApi
              ?.unregisterContext(contextToken)
              .catch(() => undefined)
          }
          if (!cancelled) {
            failHarnessAppLaunch(
              installationId,
              getErrorMessage(error, t('workbench.smart_apps_launch_failed', '智能工作台启动失败'))
            )
          }
        }
      })
      .catch(error => {
        if (!cancelled) {
          beginHarnessAppLaunch(
            installationId,
            t('workbench.smart_apps_title', '智能工作台'),
            retry
          )
          failHarnessAppLaunch(
            installationId,
            getErrorMessage(error, t('workbench.smart_apps_load_failed', '智能工作台加载失败'))
          )
        }
      })
      .finally(() => {
        launches.delete(installationId)
      })
    launches.set(installationId, launch)
    void launch.finally(settle)

    return () => {
      cancelled = true
    }
  }, [attempt, installationId, modelOptions, onStartupSettled, services.localHarnessModelApi, t])

  return null
}
