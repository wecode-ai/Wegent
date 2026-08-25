import { useEffect, useRef } from 'react'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { harnessAppsApi } from '@/api/local/harnessApps'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { useWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { harnessAppInstallationIdFromPath } from './harnessAppLaunchState'
import { unregisterHarnessAppTab } from './harnessAppTabs'

export function ElectronWorkbenchTabBridge() {
  const workspaceTabs = useWorkspaceTabs()
  const previousInstallationIds = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!isElectronRuntime()) return
    const activeTab = workspaceTabs.tabs.find(tab => tab.id === workspaceTabs.activeTabId)
    const installationId = activeTab
      ? harnessAppInstallationIdFromPath(
          new URL(activeTab.contentRoute, window.location.origin).pathname
        )
      : null
    void invokeDesktopHost<void>('workbench.activate', { installationId }).catch(error => {
      console.warn('[Wework] failed to activate Electron workbench surface', error)
    })
  }, [workspaceTabs.activeTabId, workspaceTabs.tabs])

  useEffect(() => {
    if (!isElectronRuntime()) return
    const current = new Set(
      workspaceTabs.tabs.flatMap(tab => {
        const installationId = harnessAppInstallationIdFromPath(
          new URL(tab.contentRoute, window.location.origin).pathname
        )
        return installationId ? [installationId] : []
      })
    )
    for (const installationId of previousInstallationIds.current) {
      if (current.has(installationId)) continue
      unregisterHarnessAppTab(installationId)
      void harnessAppsApi.stop(installationId).catch(error => {
        console.warn(`[Wework] failed to stop closed Smart app ${installationId}`, error)
      })
    }
    previousInstallationIds.current = current
  }, [workspaceTabs.tabs])

  return null
}
