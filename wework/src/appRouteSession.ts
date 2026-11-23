import { createRuntimeTaskLifecycleStream } from '@/features/workbench/runtimeTaskLifecycle/runtimeTaskLifecycleStream'
import {
  createWeworkSchemeService,
  type WeworkSchemeInput,
} from '@/features/notifications/weworkSchemeService'
import { createWorkspaceMenuService, type WorkspaceMenuInput } from '@/desktop/workspaceMenuService'
import {
  createPluginAutoUpdateActor,
  type PluginAutoUpdateProfile,
} from '@/features/plugins/pluginAutoUpdateActor'
import {
  createRouteNotificationEvents,
  type RouteNotificationInput,
} from '@/features/notifications/routeNotificationEvents'
import { retainRuntimeTaskSystemSleep } from '@/features/workbench/runtimeTaskSystemSleep'
import type { createWorkspaceTabsSession } from '@/features/workspace-tabs/workspaceTabsSession'
import type { WorkspaceTab } from '@/features/workspace-tabs/workspaceTabs'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { retainWorkbenchServiceConnections } from '@/features/workbench/workbenchServiceConnections'
import {
  registerRuntimeTaskLifecycleAutomation,
  type RuntimeTaskLifecycleStore,
} from '@/features/workbench/runtimeTaskLifecycle'
import { listenHarnessAppLaunchProgress } from '@/api/local/harnessApps'
import { updateHarnessAppLaunchPhase } from '@/features/harness-apps/harnessAppLaunchState'
import { setActiveWorkspaceTabPortalOwner } from '@/components/topnav/workspaceTabPortalOwnership'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { resolveTelemetryRoute } from '@/telemetry/routeRegistry'
import { telemetryFeatureForLocation } from '@/telemetry/routes'
import { track } from '@/telemetry/client'

type AppRouteConnections = Pick<WorkbenchServices, 'socketClient' | 'projectChatClient'>

let launchOwners = 0
let releaseLaunchProgress: (() => void) | undefined
let launchGeneration = 0
let launchListening = false
function retainLaunchProgress() {
  launchOwners += 1
  if (!launchListening && isElectronRuntime()) {
    launchListening = true
    const generation = ++launchGeneration
    void listenHarnessAppLaunchProgress(progress => {
      if (generation === launchGeneration && launchOwners > 0)
        updateHarnessAppLaunchPhase(progress.installationId, progress.phase)
    })
      .then(release => {
        if (generation !== launchGeneration || !launchOwners) release()
        else releaseLaunchProgress = release
      })
      .catch(error => {
        if (generation === launchGeneration) launchListening = false
        console.error('[Wework] failed to listen for Smart app launch progress', error)
      })
  }
  return () => {
    launchOwners -= 1
    queueMicrotask(() => {
      if (launchOwners) return
      launchListening = false
      launchGeneration += 1
      releaseLaunchProgress?.()
      releaseLaunchProgress = undefined
    })
  }
}

interface MountedTabsSnapshot {
  ids: Set<string>
  nativeWorkbenchKinds: Map<string, 'task' | 'board'>
}
function projectMountedTabs(previous: MountedTabsSnapshot, tabs: WorkspaceTab[], activeId: string) {
  const open = new Set(tabs.map(tab => tab.id))
  const ids = new Set([...previous.ids].filter(id => open.has(id)))
  if (activeId) ids.add(activeId)
  const nativeWorkbenchKinds = new Map(
    [...previous.nativeWorkbenchKinds].filter(([id]) => open.has(id))
  )
  for (const tab of tabs)
    if (tab.kind === 'task' || tab.kind === 'board') nativeWorkbenchKinds.set(tab.id, tab.kind)
  if (
    ids.size === previous.ids.size &&
    [...ids].every(id => previous.ids.has(id)) &&
    nativeWorkbenchKinds.size === previous.nativeWorkbenchKinds.size &&
    [...nativeWorkbenchKinds].every(([id, kind]) => previous.nativeWorkbenchKinds.get(id) === kind)
  )
    return previous
  return { ids, nativeWorkbenchKinds }
}
/** The window/account route owner retains mounted surfaces and their runtime services. */
export function createAppRouteSession({
  tabs,
  lifecycleStore,
}: {
  tabs: ReturnType<typeof createWorkspaceTabsSession> | null
  lifecycleStore: RuntimeTaskLifecycleStore
}) {
  const notificationEvents = createRouteNotificationEvents()
  const workspaceMenu = createWorkspaceMenuService()
  const schemes = createWeworkSchemeService()
  const lifecycleStream = createRuntimeTaskLifecycleStream(lifecycleStore)
  const pluginUpdates = createPluginAutoUpdateActor()
  let snapshot: MountedTabsSnapshot = { ids: new Set(), nativeWorkbenchKinds: new Map() }
  const initial = tabs?.getSnapshot()
  if (initial) snapshot = projectMountedTabs(snapshot, initial.tabs, initial.activeTabId)
  const listeners = new Set<() => void>()
  let release: (() => void) | undefined
  let serviceOwner: AppRouteConnections | undefined
  let releaseConnections: (() => void) | undefined
  let releaseTaskActivity: (() => void) | undefined
  let routeKey: string | undefined
  const synchronize = () => {
    const state = tabs?.getSessionSnapshot()
    if (!state?.active) return
    setActiveWorkspaceTabPortalOwner(state.state.activeTabId)
    const next = projectMountedTabs(snapshot, state.state.tabs, state.state.activeTabId)
    if (next === snapshot) return
    snapshot = next
    listeners.forEach(listener => listener())
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(
      listener: () => void,
      location: { pathname: string; search: string },
      popout: boolean,
      services: AppRouteConnections,
      taskActivityEnabled: boolean,
      notifications?: RouteNotificationInput,
      pluginUpdateInput?: PluginAutoUpdateProfile,
      menuInput?: WorkspaceMenuInput,
      schemeInput?: WeworkSchemeInput,
      lifecycleServices?: WorkbenchServices
    ) {
      listeners.add(listener)
      if (!release) {
        const unregister = registerRuntimeTaskLifecycleAutomation(lifecycleStore)

        const stopProgress = retainLaunchProgress()
        const unsubscribe = tabs?.subscribeSession(synchronize)
        release = () => {
          lifecycleStream.disconnect()
          schemes.disconnect()
          workspaceMenu.disconnect()
          pluginUpdates.disconnect()
          notificationEvents.disconnect()
          unsubscribe?.()
          releaseTaskActivity?.()
          releaseTaskActivity = undefined
          stopProgress()
          releaseConnections?.()
          releaseConnections = undefined
          serviceOwner = undefined
          unregister()
        }
      }
      if (schemeInput) schemes.observe(schemeInput)
      else schemes.disconnect()
      if (menuInput) workspaceMenu.observe(menuInput)
      else workspaceMenu.disconnect()
      if (pluginUpdateInput) pluginUpdates.observe(pluginUpdateInput)
      else pluginUpdates.disconnect()
      if (taskActivityEnabled && lifecycleServices) lifecycleStream.observe(lifecycleServices)
      else lifecycleStream.disconnect()
      if (taskActivityEnabled && notifications) notificationEvents.observe(notifications)
      else notificationEvents.disconnect()
      if (taskActivityEnabled && !releaseTaskActivity) {
        releaseTaskActivity = retainRuntimeTaskSystemSleep(lifecycleStore)
      } else if (!taskActivityEnabled && releaseTaskActivity) {
        releaseTaskActivity()
        releaseTaskActivity = undefined
      }
      if (serviceOwner !== services) {
        const previous = releaseConnections
        releaseConnections = retainWorkbenchServiceConnections(services)
        serviceOwner = services
        previous?.()
      }
      synchronize()
      const nextRouteKey = JSON.stringify([location.pathname, location.search, popout])
      if (routeKey !== nextRouteKey) {
        routeKey = nextRouteKey
        if (!resolveTelemetryRoute(location.pathname, location.search))
          track('feature_opened', {
            feature: popout
              ? 'popout'
              : telemetryFeatureForLocation(location.pathname, location.search),
          })
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          notificationEvents.suspend()
          schemes.suspend()
        }
        queueMicrotask(() => {
          if (listeners.size) return
          release?.()
          release = undefined
        })
      }
    },
  }
}
