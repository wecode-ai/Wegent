import { useCallback, useEffect, useMemo } from 'react'
import { harnessAppsApi, type HarnessAppInstallation } from '@/api/local/harnessApps'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { useTranslation } from '@/hooks/useTranslation'
import { getErrorMessage } from '@/lib/error-message'
import { listLocalHarnessModelOptions } from '@/features/local-harness/localHarnessModels'
import {
  harnessAppRoute,
  openHarnessAppTab,
  registerHarnessAppTab,
  takeHarnessAppContextToken,
  takeHarnessAppProxyToken,
  unregisterHarnessAppTab,
} from './harnessAppTabs'
import { beginHarnessAppLaunch, clearHarnessAppLaunch } from './harnessAppLaunchState'

interface HarnessAppManagementOptions {
  installations: HarnessAppInstallation[]
  onBusyChange: (installationId: string | null) => void
  onError: (message: string | null) => void
  onRefresh: () => Promise<void>
}

export function useHarnessAppManagement({
  installations,
  onBusyChange,
  onError,
  onRefresh,
}: HarnessAppManagementOptions) {
  const { t } = useTranslation('common')
  const { projectChat, services } = useWorkbench()
  const workspaceTabs = useWorkspaceTabs()
  const modelOptions = useMemo(
    () => listLocalHarnessModelOptions('opencode', projectChat.models),
    [projectChat.models]
  )

  useEffect(() => {
    installations
      .filter(installation => installation.state === 'running' && installation.webUrl)
      .forEach(installation => registerHarnessAppTab(installation))
  }, [installations])

  const hasSelectedModel = useCallback(
    (installation: HarnessAppInstallation) =>
      modelOptions.some(option => option.key === installation.modelKey),
    [modelOptions]
  )

  const closeAppTabs = useCallback(
    (installationId: string) => {
      const route = harnessAppRoute(installationId)
      const mountedTabIds = Array.from(
        document.querySelectorAll<HTMLElement>(
          `[data-testid="app-iframe-harness-${CSS.escape(installationId)}"]`
        )
      )
        .map(element => element.dataset.workspaceTabId)
        .filter((tabId): tabId is string => Boolean(tabId))
      const tabIds = new Set([
        ...workspaceTabs.tabs.filter(tab => tab.contentRoute === route).map(tab => tab.id),
        ...mountedTabIds,
      ])
      tabIds.forEach(tabId => workspaceTabs.closeTab(tabId))
    },
    [workspaceTabs]
  )

  const start = useCallback(
    (installation: HarnessAppInstallation) => {
      if (!hasSelectedModel(installation)) {
        onError(
          t(
            'workbench.harness_apps_model_missing',
            '此智能工作台绑定的 Wework 模型已不可用，请重新选择模型。'
          )
        )
        return
      }
      onError(null)
      openHarnessAppTab(workspaceTabs, installation)
    },
    [hasSelectedModel, onError, t, workspaceTabs]
  )

  const open = useCallback(
    (installation: HarnessAppInstallation) => {
      if (!installation.webUrl) return
      const route = harnessAppRoute(installation.id)
      const tabAlreadyOpen = workspaceTabs.tabs.some(tab => tab.contentRoute === route)
      if (!tabAlreadyOpen) {
        beginHarnessAppLaunch(
          installation.id,
          installation.manifest.displayName,
          () => {
            registerHarnessAppTab(installation)
            openHarnessAppTab(workspaceTabs, installation)
          },
          'loadingApp'
        )
      }
      registerHarnessAppTab(installation)
      openHarnessAppTab(workspaceTabs, installation)
    },
    [workspaceTabs]
  )

  const stop = useCallback(
    async (installation: HarnessAppInstallation, refresh = true): Promise<boolean> => {
      onBusyChange(installation.id)
      onError(null)
      try {
        await harnessAppsApi.stop(installation.id)
        unregisterHarnessAppTab(installation.id)
        clearHarnessAppLaunch(installation.id)
        closeAppTabs(installation.id)
        const token = await takeHarnessAppProxyToken(installation.id)
        if (token) await services.localHarnessModelApi?.unregisterProxy(token)
        const contextToken = await takeHarnessAppContextToken(installation.id)
        if (contextToken) {
          await services.localHarnessModelApi?.unregisterContext(contextToken)
        }
        if (refresh) await onRefresh()
        return true
      } catch (error) {
        onError(
          getErrorMessage(error, t('workbench.harness_apps_stop_failed', '停止智能工作台失败。'))
        )
        return false
      } finally {
        onBusyChange(null)
      }
    },
    [closeAppTabs, onBusyChange, onError, onRefresh, services.localHarnessModelApi, t]
  )

  const changeModel = useCallback(
    async (installation: HarnessAppInstallation, nextModelKey: string) => {
      if (!nextModelKey || nextModelKey === installation.modelKey) return
      if (installation.state === 'running') {
        onError(
          t('workbench.smart_apps_model_change_stop_first', '请先停止智能工作台，再修改模型。')
        )
        return
      }
      onBusyChange(installation.id)
      onError(null)
      try {
        await harnessAppsApi.update(installation.id, { modelKey: nextModelKey })
        await onRefresh()
      } catch (error) {
        onError(
          getErrorMessage(
            error,
            t('workbench.smart_apps_model_change_failed', '修改智能工作台模型失败。')
          )
        )
      } finally {
        onBusyChange(null)
      }
    },
    [onBusyChange, onError, onRefresh, t]
  )

  return {
    changeModel,
    hasSelectedModel,
    modelOptions,
    open,
    start,
    stop,
  }
}
