import { useEffect, useMemo, useRef } from 'react'
import { harnessAppsApi } from '@/api/local/harnessApps'
import {
  takeHarnessAppProxyToken,
  takeHarnessAppContextToken,
  openHarnessAppTab,
  registerHarnessAppTab,
  storeHarnessAppContextToken,
  storeHarnessAppProxyToken,
  unregisterHarnessAppTab,
} from '@/features/harness-apps/harnessAppTabs'
import { listLocalHarnessModelOptions } from '@/features/local-harness/localHarnessModels'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'

interface ResidentSmartAppsManagerProps {
  enabled: boolean
}

export function ResidentSmartAppsManager({ enabled }: ResidentSmartAppsManagerProps) {
  const { projectChat, services } = useWorkbench()
  const workspaceTabs = useWorkspaceTabs()
  const workspaceTabsRef = useRef(workspaceTabs)
  const completedIds = useRef(new Set<string>())
  const launchingIds = useRef(new Set<string>())
  const disabledCleanupStarted = useRef(false)
  const disabledCleanupGeneration = useRef(0)
  const modelOptions = useMemo(
    () => listLocalHarnessModelOptions('opencode', projectChat.models),
    [projectChat.models]
  )

  useEffect(() => {
    workspaceTabsRef.current = workspaceTabs
  }, [workspaceTabs])

  useEffect(() => {
    if (enabled) {
      disabledCleanupGeneration.current += 1
      disabledCleanupStarted.current = false
      return
    }
    if (disabledCleanupStarted.current) return
    disabledCleanupStarted.current = true
    const cleanupGeneration = disabledCleanupGeneration.current + 1
    disabledCleanupGeneration.current = cleanupGeneration
    completedIds.current.clear()
    launchingIds.current.clear()
    workspaceTabsRef.current.tabs
      .filter(
        tab =>
          tab.contentRoute.startsWith('/sites?app_type=smart_app') ||
          tab.contentRoute.startsWith('/app/harness-')
      )
      .forEach(tab => workspaceTabsRef.current.closeTab(tab.id))

    void harnessAppsApi
      .list()
      .then(async installations => {
        for (const installation of installations) {
          if (disabledCleanupGeneration.current !== cleanupGeneration) return
          unregisterHarnessAppTab(installation.id)
          let stopped = installation.state !== 'running'
          if (!stopped) {
            try {
              await harnessAppsApi.stop(installation.id)
              stopped = true
            } catch (error) {
              console.warn(
                `[Wework] failed to stop experimental Smart app ${installation.id}`,
                error
              )
            }
          }
          if (!stopped) continue
          const proxyToken = await takeHarnessAppProxyToken(installation.id)
          if (proxyToken) {
            await services.localHarnessModelApi?.unregisterProxy(proxyToken).catch(() => undefined)
          }
          const contextToken = await takeHarnessAppContextToken(installation.id)
          if (contextToken) {
            await services.localHarnessModelApi
              ?.unregisterContext(contextToken)
              .catch(() => undefined)
          }
        }
      })
      .catch(error => {
        console.warn('[Wework] failed to disable experimental Smart apps', error)
      })
  }, [enabled, services.localHarnessModelApi])

  useEffect(() => {
    if (!enabled || !services.localHarnessModelApi) return
    const optionsByKey = new Map(modelOptions.map(option => [option.key, option]))
    let cancelled = false

    void harnessAppsApi
      .list()
      .then(async installations => {
        for (const installation of installations.filter(item => item.resident)) {
          if (cancelled) return
          if (
            completedIds.current.has(installation.id) ||
            launchingIds.current.has(installation.id)
          )
            continue
          const model = installation.modelKey
            ? (optionsByKey.get(installation.modelKey) ?? null)
            : null
          launchingIds.current.add(installation.id)
          if (installation.state === 'running' && installation.webUrl) {
            try {
              if (cancelled) return
              registerHarnessAppTab(installation)
              openHarnessAppTab(workspaceTabsRef.current, installation)
              completedIds.current.add(installation.id)
            } catch (error) {
              console.warn(
                `[Wework] failed to restore resident Smart app ${installation.id}`,
                error
              )
            } finally {
              launchingIds.current.delete(installation.id)
            }
            continue
          }
          if (!model) {
            launchingIds.current.delete(installation.id)
            console.warn(
              `[Wework] resident Smart app ${installation.id} cannot start because its model is unavailable`
            )
            continue
          }
          let proxyToken: string | null = null
          let contextToken: string | null = null
          let appStarted = false
          try {
            const launch = await services.localHarnessModelApi?.resolveLaunch('opencode', model)
            if (cancelled) return
            if (!launch) throw new Error('Smart app model proxy is unavailable')
            proxyToken = launch.proxyToken
            contextToken = launch.context?.token ?? null
            const running = launch.context
              ? await harnessAppsApi.start(
                  installation.id,
                  launch.baseUrl,
                  launch.context.baseUrl,
                  launch.context.token
                )
              : await harnessAppsApi.start(installation.id, launch.baseUrl)
            appStarted = true
            if (cancelled) throw new Error('Resident Smart app restoration was cancelled')
            registerHarnessAppTab(running)
            openHarnessAppTab(workspaceTabsRef.current, running)
            await storeHarnessAppProxyToken(installation.id, launch.proxyToken)
            if (contextToken) await storeHarnessAppContextToken(installation.id, contextToken)
            completedIds.current.add(installation.id)
          } catch (error) {
            if (appStarted) {
              await harnessAppsApi.stop(installation.id).catch(() => undefined)
              unregisterHarnessAppTab(installation.id)
              await takeHarnessAppProxyToken(installation.id)
              await takeHarnessAppContextToken(installation.id)
            }
            if (proxyToken) {
              await services.localHarnessModelApi
                ?.unregisterProxy(proxyToken)
                .catch(() => undefined)
            }
            if (contextToken) {
              await services.localHarnessModelApi
                ?.unregisterContext(contextToken)
                .catch(() => undefined)
            }
            console.warn(`[Wework] failed to start resident Smart app ${installation.id}`, error)
          } finally {
            launchingIds.current.delete(installation.id)
          }
        }
      })
      .catch(error => {
        if (!cancelled) console.warn('[Wework] failed to load resident Smart apps', error)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, modelOptions, services.localHarnessModelApi])

  return null
}
