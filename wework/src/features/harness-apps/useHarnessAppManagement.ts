import { useCallback, useEffect, useMemo } from 'react'
import {
  harnessAppsApi,
  type HarnessAppInstallation,
  type WorkbenchPresentation,
} from '@/api/local/harnessApps'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { useTranslation } from '@/hooks/useTranslation'
import { getSmartAppErrorMessage } from '@/lib/smart-app-error-message'
import { listLocalHarnessModelOptions } from '@/features/local-harness/localHarnessModels'
import {
  harnessAppRoute,
  openHarnessAppTab,
  registerHarnessAppTab,
  unregisterHarnessAppTab,
} from './harnessAppTabs'
import { clearHarnessAppLaunch } from './harnessAppLaunchState'

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
  const { projectChat } = useWorkbench()
  const workspaceTabs = useWorkspaceTabs()
  const modelOptions = useMemo(
    () => listLocalHarnessModelOptions('opencode', projectChat.models),
    [projectChat.models]
  )

  useEffect(() => {
    installations
      .filter(
        installation =>
          installation.state === 'running' &&
          installation.webUrl &&
          installation.presentation === 'tab'
      )
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

  const open = useCallback(
    async (installation: HarnessAppInstallation, presentation?: WorkbenchPresentation) => {
      onBusyChange(installation.id)
      onError(null)
      try {
        const running = await harnessAppsApi.open(installation.id, presentation)
        if (running.presentation === 'tab') {
          registerHarnessAppTab(running)
          openHarnessAppTab(workspaceTabs, running)
        } else {
          closeAppTabs(installation.id)
          unregisterHarnessAppTab(installation.id)
        }
        await onRefresh()
      } catch (error) {
        onError(
          getSmartAppErrorMessage(
            error,
            t('workbench.smart_apps_launch_failed', '工作台启动失败'),
            t
          )
        )
      } finally {
        onBusyChange(null)
      }
    },
    [closeAppTabs, onBusyChange, onError, onRefresh, t, workspaceTabs]
  )

  const start = open

  const stop = useCallback(
    async (installation: HarnessAppInstallation, refresh = true): Promise<boolean> => {
      onBusyChange(installation.id)
      onError(null)
      try {
        await harnessAppsApi.stop(installation.id)
        unregisterHarnessAppTab(installation.id)
        clearHarnessAppLaunch(installation.id)
        closeAppTabs(installation.id)
        if (refresh) await onRefresh()
        return true
      } catch (error) {
        onError(
          getSmartAppErrorMessage(
            error,
            t('workbench.harness_apps_stop_failed', '停止工作台失败。'),
            t
          )
        )
        return false
      } finally {
        onBusyChange(null)
      }
    },
    [closeAppTabs, onBusyChange, onError, onRefresh, t]
  )

  const changeModel = useCallback(
    async (installation: HarnessAppInstallation, nextModelKey: string) => {
      if (!nextModelKey || nextModelKey === installation.modelKey) return
      if (installation.state === 'running') {
        onError(t('workbench.smart_apps_model_change_stop_first', '请先停止工作台，再修改模型。'))
        return
      }
      onBusyChange(installation.id)
      onError(null)
      try {
        await harnessAppsApi.update(installation.id, { modelKey: nextModelKey })
        await onRefresh()
      } catch (error) {
        onError(
          getSmartAppErrorMessage(
            error,
            t('workbench.smart_apps_model_change_failed', '修改工作台模型失败。'),
            t
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
