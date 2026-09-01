import { useEffect, useRef } from 'react'
import { harnessAppsApi } from '@/api/local/harnessApps'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { useWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { notifyHarnessAppInstallationsChanged } from './harnessAppInstallationsChanged'
import { harnessAppInstallationIdFromPath } from './harnessAppLaunchState'
import { unregisterHarnessAppTab } from './harnessAppTabs'

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
      void harnessAppsApi
        .stop(installationId)
        .then(() => {
          notifyHarnessAppInstallationsChanged({ type: 'stopped', installationId })
        })
        .catch(error => {
          console.warn(`[Wework] failed to stop closed Smart app ${installationId}`, error)
        })
    }
    previousInstallationIds.current = current
  }, [workspaceTabs.tabs])

  return null
}
