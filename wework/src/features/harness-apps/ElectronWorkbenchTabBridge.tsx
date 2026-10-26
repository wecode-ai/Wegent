import { useEffect, useRef } from 'react'
import { harnessAppsApi } from '@/api/local/harnessApps'
import { createLocalAppServices } from '@/api/local/localServices'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { useWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { notifyHarnessAppInstallationsChanged } from './harnessAppInstallationsChanged'
import { harnessAppInstallationIdFromPath } from './harnessAppLaunchState'
import { unregisterHarnessAppTab } from './harnessAppTabs'
import { releaseHarnessAppRoutes } from './harnessAppRoutes'

export function ElectronWorkbenchTabBridge() {
  const workspaceTabs = useWorkspaceTabs()
  const previousInstallationIds = useRef<Set<string>>(new Set())

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
      const services = createLocalAppServices()
      void (async () => {
        let stopped = false
        try {
          await harnessAppsApi.stop(installationId)
          stopped = true
        } catch (error) {
          console.warn(`[Wework] failed to stop closed Smart app ${installationId}`, error)
        }
        await releaseHarnessAppRoutes(
          installationId,
          services.localHarnessModelApi,
          services.localDecisionRouterApi
        )
        if (stopped) {
          notifyHarnessAppInstallationsChanged({ type: 'stopped', installationId })
        }
      })()
    }
    previousInstallationIds.current = current
  }, [workspaceTabs.tabs])

  return null
}
