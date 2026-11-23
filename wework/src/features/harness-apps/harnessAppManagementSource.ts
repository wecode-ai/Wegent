import { harnessAppsApi, type HarnessAppInstallation } from '@/api/local/harnessApps'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { WorkspaceTabsContextValue } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { getSmartAppErrorMessage, type SmartAppTranslate } from '@/lib/smart-app-error-message'
import type { LocalHarnessModelOption } from '@/features/local-harness/localHarnessModels'
import {
  harnessAppRoute,
  openHarnessAppTab,
  registerHarnessAppTab,
  unregisterHarnessAppTab,
} from './harnessAppTabs'
import { beginHarnessAppLaunch, clearHarnessAppLaunch } from './harnessAppLaunchState'
import { releaseHarnessAppRoutes } from './harnessAppRoutes'
import {
  isHarnessAppRuntimeOperationPending,
  runHarnessAppRuntimeOperation,
} from './harnessAppRuntimeOperations'

const closeHarnessAppTabs = (workspaceTabs: WorkspaceTabsContextValue, installationId: string) => {
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
}
export interface HarnessAppManagementOptions {
  installations: HarnessAppInstallation[]
  onBusyChange: (installationId: string | null) => void
  onError: (message: string | null) => void
  onRefresh: () => Promise<void>
}

export interface HarnessAppManagementInput extends HarnessAppManagementOptions {
  modelOptions: LocalHarnessModelOption[]
  workspaceTabs: WorkspaceTabsContextValue
  services: Pick<WorkbenchServices, 'localHarnessModelApi' | 'localDecisionRouterApi'>
  t: SmartAppTranslate
}

function sameModelOptions(first: LocalHarnessModelOption[], second: LocalHarnessModelOption[]) {
  return (
    first.length === second.length &&
    first.every((option, index) => {
      const next = second[index]!
      return (
        option.key === next.key &&
        option.label === next.label &&
        option.source === next.source &&
        option.model === next.model &&
        Object.keys(option.options).length === Object.keys(next.options).length &&
        Object.entries(option.options).every(([key, value]) => next.options[key] === value)
      )
    })
  )
}

/** One management surface owns its catalog, visible operation state and callback delivery. */
export function createHarnessAppManagementSource(initial: HarnessAppManagementInput) {
  let input = initial
  let snapshot = {
    installations: initial.installations,
    modelOptions: initial.modelOptions,
    busyInstallationId: null as string | null,
    error: null as string | null,
  }
  const listeners = new Set<() => void>()
  let generation = 0
  let registered = false
  let deferredBusy = false
  let deferredError = false
  const emit = () => listeners.forEach(listener => listener())
  const operationCallbacks = (owner: number) => ({
    onBusyChange(id: string | null) {
      if (owner !== generation) return
      snapshot = { ...snapshot, busyInstallationId: id }
      emit()
      if (listeners.size) input.onBusyChange(id)
      else deferredBusy = true
    },
    onError(message: string | null) {
      if (owner !== generation) return
      snapshot = { ...snapshot, error: message }
      emit()
      if (listeners.size) input.onError(message)
      else deferredError = true
    },
    async onRefresh() {
      if (owner === generation) await input.onRefresh()
    },
  })
  const hasSelectedModel = (installation: HarnessAppInstallation) =>
    snapshot.modelOptions.some(option => option.key === installation.modelKey)
  const start = (installation: HarnessAppInstallation) => {
    const { workspaceTabs, t } = input
    const { onError } = operationCallbacks(generation)
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
    // A retained management page may have republished its old running
    // snapshot before refreshing. Do not mount that stopped runtime's URL
    // while the new launcher is still registering and handing off routes.
    // An existing tab or operation owns its registration even if this
    // management snapshot has not received the running update yet.
    if (
      installation.state !== 'running' &&
      !isHarnessAppRuntimeOperationPending(installation.id) &&
      !workspaceTabs.tabs.some(tab => tab.contentRoute === harnessAppRoute(installation.id))
    ) {
      unregisterHarnessAppTab(installation.id)
    }
    openHarnessAppTab(workspaceTabs, installation)
  }
  const open = (installation: HarnessAppInstallation) => {
    const { workspaceTabs } = input
    if (!installation.webUrl) return
    const route = harnessAppRoute(installation.id)
    const tabAlreadyOpen = workspaceTabs.tabs.some(tab => tab.contentRoute === route)
    if (!tabAlreadyOpen) {
      beginHarnessAppLaunch(
        installation.id,
        installation.manifest.displayName,
        () => {
          if (!isHarnessAppRuntimeOperationPending(installation.id)) {
            registerHarnessAppTab(installation)
          }
          openHarnessAppTab(workspaceTabs, installation)
        },
        'loadingApp'
      )
    }
    if (!isHarnessAppRuntimeOperationPending(installation.id)) {
      registerHarnessAppTab(installation)
    }
    openHarnessAppTab(workspaceTabs, installation)
  }
  const stop = async (installation: HarnessAppInstallation, refresh = true): Promise<boolean> => {
    const owner = generation
    const request = input
    const { services, t } = request
    const { onBusyChange, onError, onRefresh } = operationCallbacks(owner)
    const closeAppTabs = (id: string) => {
      closeHarnessAppTabs(request.workspaceTabs, id)
    }
    onBusyChange(installation.id)
    onError(null)
    try {
      await runHarnessAppRuntimeOperation(installation.id, async () => {
        await harnessAppsApi.stop(installation.id)
        unregisterHarnessAppTab(installation.id)
        clearHarnessAppLaunch(installation.id)
        closeAppTabs(installation.id)
        await releaseHarnessAppRoutes(
          installation.id,
          services.localHarnessModelApi,
          services.localDecisionRouterApi
        )
      })
      if (refresh) await onRefresh()
      return true
    } catch (error) {
      onError(
        getSmartAppErrorMessage(
          error,
          t('workbench.harness_apps_stop_failed', '停止智能工作台失败。'),
          t
        )
      )
      return false
    } finally {
      onBusyChange(null)
    }
  }
  const changeModel = async (installation: HarnessAppInstallation, nextModelKey: string) => {
    const { t } = input
    const { onBusyChange, onError, onRefresh } = operationCallbacks(generation)
    if (!nextModelKey || nextModelKey === installation.modelKey) return
    if (installation.state === 'running') {
      onError(t('workbench.smart_apps_model_change_stop_first', '请先停止智能工作台，再修改模型。'))
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
          t('workbench.smart_apps_model_change_failed', '修改智能工作台模型失败。'),
          t
        )
      )
    } finally {
      onBusyChange(null)
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(notify: () => void, next: HarnessAppManagementInput) {
      listeners.add(notify)
      const previous = input
      const scopeChanged =
        previous.services.localHarnessModelApi?.unregisterProxy !==
          next.services.localHarnessModelApi?.unregisterProxy ||
        previous.services.localHarnessModelApi?.unregisterContext !==
          next.services.localHarnessModelApi?.unregisterContext ||
        previous.services.localDecisionRouterApi?.unregister !==
          next.services.localDecisionRouterApi?.unregister
      if (scopeChanged) {
        generation += 1
        deferredBusy = snapshot.busyInstallationId !== null
        deferredError = snapshot.error !== null
        snapshot = { ...snapshot, busyInstallationId: null, error: null }
        registered = false
      }
      input = next
      if (deferredBusy) {
        deferredBusy = false
        input.onBusyChange(snapshot.busyInstallationId)
      }
      if (deferredError) {
        deferredError = false
        input.onError(snapshot.error)
      }
      const catalogChanged =
        snapshot.installations.length !== next.installations.length ||
        snapshot.installations.some((item, index) => item !== next.installations[index])
      const modelsChanged = !sameModelOptions(snapshot.modelOptions, next.modelOptions)
      if (scopeChanged || catalogChanged || modelsChanged) {
        snapshot = {
          ...snapshot,
          installations: next.installations,
          modelOptions: modelsChanged ? next.modelOptions : snapshot.modelOptions,
        }
        emit()
      }
      if (!registered || catalogChanged) {
        // The lifecycle owner completes token handoff before a tab may use a running URL.
        snapshot.installations
          .filter(
            installation =>
              installation.state === 'running' &&
              installation.webUrl &&
              !isHarnessAppRuntimeOperationPending(installation.id)
          )
          .forEach(registerHarnessAppTab)
        registered = true
      }
      return () => {
        listeners.delete(notify)
        queueMicrotask(() => {
          if (listeners.size) return
          registered = false
        })
      }
    },
    changeModel,
    hasSelectedModel,
    open,
    start,
    stop,
  }
}
