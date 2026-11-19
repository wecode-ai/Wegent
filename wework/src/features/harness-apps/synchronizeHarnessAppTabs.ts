import { harnessAppsApi } from '@/api/local/harnessApps'
import { createLocalAppServices } from '@/api/local/localServices'
import { isElectronRuntime } from '@/lib/runtime-environment'
import type { WorkspaceTab } from '@/features/workspace-tabs/workspaceTabs'
import { notifyHarnessAppInstallationsChanged } from './harnessAppInstallationsChanged'
import { harnessAppInstallationIdFromPath } from './harnessAppLaunchState'
import { unregisterHarnessAppTab } from './harnessAppTabs'
import { releaseHarnessAppRoutes } from './harnessAppRoutes'
import { runHarnessAppRuntimeOperation } from './harnessAppRuntimeOperations'

function installationIds(tabs: WorkspaceTab[]): Set<string> {
  return new Set(
    tabs.flatMap(tab => {
      const installationId = harnessAppInstallationIdFromPath(
        new URL(tab.contentRoute, window.location.origin).pathname
      )
      return installationId ? [installationId] : []
    })
  )
}

export function synchronizeHarnessAppTabs(previous: WorkspaceTab[], next: WorkspaceTab[]): void {
  if (!isElectronRuntime() || previous === next) return
  const current = installationIds(next)
  for (const installationId of installationIds(previous)) {
    if (current.has(installationId)) continue
    unregisterHarnessAppTab(installationId)
    const services = createLocalAppServices()
    void runHarnessAppRuntimeOperation(installationId, async () => {
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
      if (stopped) notifyHarnessAppInstallationsChanged({ type: 'stopped', installationId })
    })
  }
}
