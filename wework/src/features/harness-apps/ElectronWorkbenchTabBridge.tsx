import { useEffect, useLayoutEffect, useRef } from 'react'
import { subscribeDesktopHostEvents } from '@/api/dsh/desktopHost'
import { harnessAppsApi, type HarnessAppInstallation } from '@/api/local/harnessApps'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { useWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { notifyHarnessAppInstallationsChanged } from './harnessAppInstallationsChanged'
import { harnessAppInstallationIdFromPath } from './harnessAppLaunchState'
import {
  harnessAppRoute,
  openHarnessAppTab,
  registerHarnessAppTab,
  unregisterHarnessAppTab,
} from './harnessAppTabs'

export function ElectronWorkbenchTabBridge() {
  const workspaceTabs = useWorkspaceTabs()
  const previousInstallationIds = useRef<Set<string>>(new Set())
  const hostClosedIds = useRef(new Set<string>())
  const tabsRef = useRef(workspaceTabs)
  useLayoutEffect(() => {
    tabsRef.current = workspaceTabs
  }, [workspaceTabs])

  useEffect(() => {
    if (!isElectronRuntime()) return
    const pending = new Map<
      string,
      { installation: HarnessAppInstallation; activateTab: boolean } | null
    >()
    let scheduled = false
    let disposed = false
    const flush = () => {
      scheduled = false
      if (disposed) return
      for (const [installationId, request] of pending) {
        if (request) {
          const { installation, activateTab } = request
          const route = harnessAppRoute(installationId)
          const existing = tabsRef.current.tabs.find(tab => tab.contentRoute === route)
          if (!activateTab && !existing) continue
          hostClosedIds.current.delete(installationId)
          registerHarnessAppTab(installation)
          notifyHarnessAppInstallationsChanged({ type: 'updated', installationId, installation })
          if (activateTab) openHarnessAppTab(tabsRef.current, installation)
          else if (existing)
            tabsRef.current.updateTab(existing.id, {
              title: installation.manifest.displayName,
              contentRoute: route,
            })
        } else {
          unregisterHarnessAppTab(installationId)
          const route = harnessAppRoute(installationId)
          const tabs = tabsRef.current.tabs.filter(tab => tab.contentRoute === route)
          if (tabs.length > 0) hostClosedIds.current.add(installationId)
          tabs.forEach(tab => tabsRef.current.closeTab(tab.id))
        }
      }
      pending.clear()
    }
    const unsubscribe = subscribeDesktopHostEvents(
      event => {
        if (event.type === 'workbench.open-tab') {
          const installation = event.payload.installation as HarnessAppInstallation | undefined
          if (!installation?.id || !installation.webUrl) return
          const activateTab = event.payload.activateTab !== false
          if (!activateTab && pending.has(installation.id) && pending.get(installation.id) === null)
            return
          pending.set(installation.id, {
            installation,
            activateTab: activateTab || Boolean(pending.get(installation.id)?.activateTab),
          })
        } else if (event.type === 'workbench.close-tab') {
          const installationId = event.payload.installationId
          if (typeof installationId !== 'string') return
          pending.set(installationId, null)
        } else return
        if (!scheduled) {
          scheduled = true
          queueMicrotask(flush)
        }
      },
      {
        replay: event =>
          event.type === 'workbench.open-tab' || event.type === 'workbench.close-tab',
      }
    )
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])

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
      if (hostClosedIds.current.delete(installationId)) continue
      void (async () => {
        try {
          const installation = (await harnessAppsApi.list()).find(
            item => item.id === installationId
          )
          // A switch to an independent window also removes the old tab.
          if (installation?.presentation !== 'tab') return
          await harnessAppsApi.closeView(installationId)
          const closed = (await harnessAppsApi.list()).find(item => item.id === installationId)
          if (closed)
            notifyHarnessAppInstallationsChanged({
              type: 'updated',
              installationId,
              installation: closed,
            })
        } catch (error) {
          console.warn(`[Wework] failed to hide closed workbench ${installationId}`, error)
        }
      })()
    }
    previousInstallationIds.current = current
  }, [workspaceTabs.tabs])

  return null
}
