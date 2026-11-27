import { retainAppshotReceiver } from '@/features/appshots/appshotReceiver'
import type { Attachment } from '@/types/api'
import { createWorkbenchOwnerObservations } from './workbenchOwnerObservations'
import { createWorkbenchRouteNavigation } from './workbenchRouteNavigation'
import { createHarnessAppLaunchActor } from '@/features/harness-apps/harnessAppLaunchActor'
import {
  createWorkbenchDebugPublisher,
  type WorkbenchDiagnosticInput,
} from './workbenchDebugPublisher'
import { createWorkbenchNotificationProducer } from './workbenchNotificationProducer'
import type { NotificationTaskRegistry } from '@/features/notifications/notificationTaskRegistry'
import { EMPTY_RUNTIME_TASK_REMINDERS, type RuntimeTaskReminderState } from './runtimeTaskReminders'
import { createCoreDshModelPublisher } from '@/features/dsh-models/coreDshModelPublisher'
import { createWorkbenchTelemetry } from './workbenchTelemetry'
import type { ExecutorClient } from '@/api/executorAccess'
import type { createWorkspaceTabsSession } from '@/features/workspace-tabs/workspaceTabsSession'
import type { WorkspaceTabActivity } from '@/features/workspace-tabs/workspaceTabsContextValue'
import type { AiGenerationTelemetryInput } from './aiGenerationTelemetryService'
import { createAiGenerationTelemetry } from './aiGenerationTelemetryService'
import {
  createWorkbenchSessionOperations,
  type WorkbenchSessionOperations,
} from './workbenchSessionOperations'
import { createWorkbenchSessionStreams, type WorkbenchStreamInput } from './workbenchSessionStreams'
import type { WorkbenchSessionState } from './workbenchSessionState'
import { createWorkbenchSessionProjects } from './workbenchSessionProjects'
import type {
  useGetRemoteProjectRegistrations,
  useEnqueueRemoteProjectStateMutation,
} from './useWorkbenchNavigationCallbacks'
import type { useListLocalApps } from './useWorkbenchPluginCallbacks'
import {
  bindComposerAppsSource,
  notifyComposerAppsListeners,
} from '@/components/chat/composer/composerAppsSnapshot'
import {
  getPluginMarketplaceCache,
  subscribePluginMarketplaceCache,
  type PluginMarketplaceCacheSnapshot,
} from '@/features/plugins/pluginMarketplaceCache'
import { selectComposerPluginApps } from '@/features/plugins/pluginInventory'
import { publishPluginInvocationCatalog } from '@/features/plugins/pluginInvocationTelemetry'
import { consumeWorkbenchNewChatRequest } from '@/lib/workbenchComposerFocus'
import type { LocalDeviceApp, UnifiedModel } from '@/types/api'

export interface WorkbenchSessionInput extends WorkbenchStreamInput {
  appshotReceiver?: { onOpenWework(): void }
  addAppshotAttachment: (attachment: Attachment) => void
  cloudConnected: boolean
  taskRouteActive?: boolean
  harnessAppLaunch: Parameters<ReturnType<typeof createHarnessAppLaunchActor>['observe']>[0]
  operations: WorkbenchSessionOperations
  notificationRegistry?: NotificationTaskRegistry | null
  debugSnapshot: WorkbenchDiagnosticInput | null
  coreDshModels: UnifiedModel[] | null
  telemetry: Omit<AiGenerationTelemetryInput, 'contextUsageByRuntimeTask'>
  executorClient: ExecutorClient
  getRemoteProjectRegistrations: ReturnType<typeof useGetRemoteProjectRegistrations>
  enqueueRemoteProjectStateMutation: ReturnType<typeof useEnqueueRemoteProjectStateMutation>
  isWorkspaceTabActive: WorkspaceTabActivity | null
  syncRuntimeTaskLifecycle: boolean
  syncRemoteProjects: boolean
  consumePluginTrials: boolean
  composerAppsSourceActive: boolean
  marketplaceCacheKey: string
  listLocalApps: ReturnType<typeof useListLocalApps>
  onStartupReadyChange?: (ready: boolean) => void
}
interface TabAccountOwner {
  ownershipKey: string
  sessions: Set<() => void>
}
const tabAccountOwners = new WeakMap<
  ReturnType<typeof createWorkspaceTabsSession>,
  Map<string, TabAccountOwner>
>()

/** State, native services and parser ownership live as long as the actual tab remains in its session. */
export function createWorkbenchSession(
  state: WorkbenchSessionState,
  ownershipKey: string,
  tabs: ReturnType<typeof createWorkspaceTabsSession> | null,
  tabId?: string
) {
  let accountOwner: TabAccountOwner | null = null
  let input: WorkbenchSessionInput | null = null
  let taskReminders = EMPTY_RUNTIME_TASK_REMINDERS
  let releaseAppshots: (() => void) | undefined
  const suspendAppshots = () => {
    releaseAppshots?.()
    releaseAppshots = undefined
  }
  let observers = 0
  let observerVersion = 0
  let running = false
  let streams: ReturnType<typeof createWorkbenchSessionStreams> | null = null
  let stopTabs: (() => void) | null = null
  let stopState: (() => void) | null = null
  let stopInventory: (() => void) | null = null
  let unbindApps: (() => void) | null = null
  let appsKey = ''
  let appsSnapshot: PluginMarketplaceCacheSnapshot | null | undefined
  let appsProjectKey: string | null | undefined
  let projectedApps: LocalDeviceApp[] = []
  let previousActive = false
  let previousTrials = false
  let previousReady: boolean | undefined
  let previousReadyCallback: WorkbenchSessionInput['onStartupReadyChange']
  let scheduled = false
  const inputs = () => {
    if (!input) throw new Error('Workbench capabilities are not committed')
    return input
  }
  const isHeld = () => {
    if (tabs && tabId) {
      if (!accountOwner || tabAccountOwners.get(tabs)?.get(tabId) !== accountOwner) return false
      const snapshot = tabs.getSessionSnapshot()
      return snapshot.active && snapshot.state.tabs.some(tab => tab.id === tabId)
    }
    return observers > 0
  }
  const canNavigate = () => {
    if (!isHeld()) return false
    if (tabs && tabId) return tabs.getSessionSnapshot().state.activeTabId === tabId
    return !tabId || !input?.isWorkspaceTabActive || input.isWorkspaceTabActive(tabId)
  }
  const canSyncLifecycle = () =>
    isHeld() && Boolean(input?.syncRuntimeTaskLifecycle) && (!tabs || !tabId || canNavigate())
  const operations = createWorkbenchSessionOperations(() => {
    if (!isHeld()) throw new Error('Workbench owner has closed')
    return inputs().operations
  })
  const notifications = createWorkbenchNotificationProducer(
    state,
    ownershipKey,
    tabId,
    operations.stableRefreshWorkLists
  )
  const telemetry = createAiGenerationTelemetry(() => ({
    ...inputs().telemetry,
    contextUsageByRuntimeTask: state.getSnapshot().contextUsageByRuntimeTask,
  }))
  const owner = {
    state,
    operations,
    telemetry,
    inputs,
    isHeld,
    canNavigate,
    canSyncLifecycle,
    ownershipKey,
    canSyncRemote: () => isHeld() && Boolean(input?.syncRemoteProjects) && canNavigate(),
  }
  const routeNavigation = createWorkbenchRouteNavigation(state, operations.stableOpenRuntimeTask)
  const harnessLauncher = createHarnessAppLaunchActor()
  const diagnostics = createWorkbenchDebugPublisher(state.lifecycleStore.subscribe)
  const coreDshModels = createCoreDshModelPublisher()
  const workbenchTelemetry = createWorkbenchTelemetry(state)
  const ownerObservations = createWorkbenchOwnerObservations(state, tabId)
  const projects = createWorkbenchSessionProjects(owner)
  function schedule() {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (input && running) reconcile()
    })
  }
  function stop() {
    routeNavigation.stop()
    harnessLauncher.dispose()
    diagnostics.suspend()
    notifications.release()
    suspendAppshots()
    if (!running) return
    running = false
    ownerObservations.suspend()
    workbenchTelemetry.deactivate()
    coreDshModels.suspend()
    state.dispose()
    projects.suspend()
    streams?.dispose()
    streams = null
    stopState?.()
    stopState = null
    stopInventory?.()
    stopInventory = null
    unbindApps?.()
    unbindApps = null
    appsKey = ''
    telemetry.dispose()
  }
  function retire() {
    if (tabs && tabId && accountOwner) {
      accountOwner.sessions.delete(retire)
      const owners = tabAccountOwners.get(tabs)
      if (!accountOwner.sessions.size && owners?.get(tabId) === accountOwner) owners.delete(tabId)
      accountOwner = null
    }
    stop()
    stopTabs?.()
    stopTabs = null
  }
  function claimAccount() {
    if (!tabs || !tabId) return
    let owners = tabAccountOwners.get(tabs)
    if (!owners) {
      owners = new Map()
      tabAccountOwners.set(tabs, owners)
    }
    const previous = owners.get(tabId)
    if (!previous || previous.ownershipKey !== ownershipKey) {
      const next: TabAccountOwner = { ownershipKey, sessions: new Set([retire]) }
      accountOwner = next
      owners.set(tabId, next)
      // Invalidate old handlers before releasing their native connections.
      if (previous) for (const release of [...previous.sessions]) release()
    } else {
      accountOwner = previous
      previous.sessions.add(retire)
    }
  }
  function reconcile() {
    if (!input) return
    if (!isHeld()) {
      stop()
      if (!observers) {
        retire()
        stopTabs?.()
        stopTabs = null
      }
      return
    }
    state.setLifecycleEnabled(canSyncLifecycle())
    if (!running) {
      running = true
      state.activate()
      streams = createWorkbenchSessionStreams(owner, tabId)
      stopState = state.subscribe(schedule)
      stopInventory = subscribePluginMarketplaceCache(snapshot => {
        if (snapshot && snapshot.cacheKey !== inputs().marketplaceCacheKey) return
        if (snapshot)
          publishPluginInvocationCatalog(snapshot.deviceId, snapshot.installedPlugins, [])
        notifyComposerAppsListeners()
      })
    } else streams?.update()
    if (observers) {
      ownerObservations.observe(input.services, input.cloudConnected)
      workbenchTelemetry.activate()
      coreDshModels.update(input.coreDshModels, input.services.localHarnessModelApi)
    } else {
      workbenchTelemetry.deactivate()
      coreDshModels.suspend()
    }
    harnessLauncher.observe(input.harnessAppLaunch)
    const active = canNavigate()
    const desiredApps = active && input.composerAppsSourceActive ? input.marketplaceCacheKey : ''
    if (desiredApps !== appsKey) {
      unbindApps?.()
      unbindApps = null
      appsKey = desiredApps
      appsSnapshot = undefined
      appsProjectKey = undefined
      if (desiredApps)
        unbindApps = bindComposerAppsSource(() => {
          if (!state.resources.localAppsRequestedRef.current) return projectedApps
          const snapshot = getPluginMarketplaceCache(desiredApps)
          const names = state.resources.projectPluginNamesRef.current
          const key = names === null ? null : JSON.stringify([...names])
          if (snapshot !== appsSnapshot || key !== appsProjectKey) {
            appsSnapshot = snapshot
            appsProjectKey = key
            projectedApps = snapshot ? selectComposerPluginApps(snapshot, names ?? undefined) : []
          }
          return projectedApps
        })
    }
    if (active !== previousActive) {
      previousActive = active
      notifyComposerAppsListeners()
      if (active) startRequestedChat()
    }
    const trials = active && input.consumePluginTrials
    if (trials && !previousTrials)
      queueMicrotask(() => {
        if (isHeld() && canNavigate() && inputs().consumePluginTrials)
          operations.stableConsumeQueuedPluginTrial()
      })
    previousTrials = trials
    const ready = !state.getSnapshot().state.isBootstrapping
    if (previousReady !== ready || previousReadyCallback !== input.onStartupReadyChange) {
      previousReady = ready
      previousReadyCallback = input.onStartupReadyChange
      input.onStartupReadyChange?.(ready)
    }
    routeNavigation.update(observers > 0 && active && input.taskRouteActive === true, taskReminders)
    if (observers && active && input.appshotReceiver) {
      releaseAppshots ??= retainAppshotReceiver(
        () => {
          if (observers && canNavigate()) inputs().appshotReceiver?.onOpenWework()
        },
        attachment => {
          if (observers && canNavigate()) inputs().addAppshotAttachment(attachment)
        }
      )
    } else suspendAppshots()
    notifications.setActive(observers > 0 && active)
    projects.reconcile()
  }
  function startRequestedChat() {
    if (!canNavigate()) return
    const requested = consumeWorkbenchNewChatRequest()
    if (requested) operations.stableStartNewChat(requested)
  }
  function updateNotificationSource() {
    if (!input || !isHeld()) return
    notifications.update(
      input.notificationRegistry ?? null,
      taskReminders,
      input.services,
      canNavigate()
    )
  }
  /** Committed child readers hold the same native owner as the Provider state observer. */
  function acquire(next: WorkbenchSessionInput) {
    const previous = input
    input = next
    claimAccount()
    observers += 1
    observerVersion += 1
    if (!stopTabs && tabs) stopTabs = tabs.subscribeSession(reconcile)
    if (
      previous &&
      (previous.marketplaceCacheKey !== next.marketplaceCacheKey ||
        previous.services !== next.services)
    ) {
      state.resources.localAppsLoadGenerationRef.current += 1
      state.resources.localAppsInflightRef.current = null
    }
    reconcile()
    diagnostics.update(isHeld() ? next.debugSnapshot : null)
    updateNotificationSource()
    let released = false
    return () => {
      if (released) return
      released = true
      observers -= 1
      const version = ++observerVersion
      if (!observers)
        queueMicrotask(() => {
          if (observerVersion !== version || observers) return
          routeNavigation.stop()
          diagnostics.suspend()
          notifications.release()
          suspendAppshots()
          workbenchTelemetry.deactivate()
          coreDshModels.suspend()
          if (!tabs || !tabId || !isHeld()) {
            retire()
            stopTabs?.()
            stopTabs = null
          }
        })
    }
  }

  return {
    operations,
    resources: state.resources,
    state,
    canNavigate,
    canSyncLifecycle,
    isHeld,
    startRequestedChat,
    getTaskReminders: () => taskReminders,
    publishTaskReminders(next: RuntimeTaskReminderState) {
      if (taskReminders === next) return
      taskReminders = next
      if (!input || !observers || !isHeld()) return
      routeNavigation.update(canNavigate() && input.taskRouteActive === true, taskReminders)
      diagnostics.update(input.debugSnapshot)
      updateNotificationSource()
    },
    consumeQueuedPluginTrial: () => {
      if (canNavigate() && input?.consumePluginTrials) operations.stableConsumeQueuedPluginTrial()
    },
    invalidatePluginCatalog: () => {
      if (!isHeld() || !input) return
      const resources = state.resources
      resources.localSkillsCacheRef.current.clear()
      resources.localAppsLoadGenerationRef.current += 1
      resources.localAppsInflightRef.current = null
      if (!resources.localAppsRequestedRef.current) return
      if (resources.localAppsRefreshTimerRef.current !== null)
        window.clearTimeout(resources.localAppsRefreshTimerRef.current)
      resources.localAppsRefreshTimerRef.current = window.setTimeout(() => {
        resources.localAppsRefreshTimerRef.current = null
        if (isHeld())
          void inputs()
            .listLocalApps({ supersedeInstalledRequest: true })
            .catch(error => console.error('[Wework] Failed to refresh composer plugins.', error))
      }, 250)
    },
    observe(next: WorkbenchSessionInput) {
      return {
        retain: () => acquire(next),
        subscribe(listener: () => void) {
          const unsubscribe = state.subscribe(listener)
          const release = acquire(next)
          return () => {
            unsubscribe()
            release()
          }
        },
      }
    },
  }
}
export type WorkbenchSession = ReturnType<typeof createWorkbenchSession>
