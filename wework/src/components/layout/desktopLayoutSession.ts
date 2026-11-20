import { subscribeArchivedCleanupError } from '@/components/settings/archivedConversationsSettingsState'
import type { DesktopLayoutState } from './desktopLayoutState'
import { SIDEBAR_AUTO_COLLAPSE_WINDOW_WIDTH } from './desktopLayoutState'
import {
  createDesktopLayoutConversations,
  type DesktopLayoutConversationInput,
} from './desktopLayoutConversations'
import type { createWorkspaceTabsSession } from '@/features/workspace-tabs/workspaceTabsSession'
import type { WorkbenchContextValue } from '@/features/workbench/workbenchContextTypes'
import { stripAppBasePath } from '@/config/runtime'
import { isSettingsRoute, navigateTo } from '@/lib/navigation'
import { writeSettingsReturnPath } from '@/features/workspace-tabs/settingsReturnPath'
import { consumeNewChatComposerRequest } from '@/lib/workbenchComposerFocus'
import { isLocalHarnessAvailable, listLocalHarnessSessions } from '@/lib/local-terminal'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { LocalHarnessWorkbenchSession } from './localHarnessWorkbench'

export interface DesktopLayoutInput extends DesktopLayoutConversationInput {
  routeActive: boolean
  surfaceKind?: 'task' | 'board'
  ownedRoute: string
  workItemSurfaceOpen: boolean
  sidebarCollapsed: boolean
  blankPaneKey: string
  activatePane(paneKey: string): void
  getImSettings: WorkbenchContextValue['getImNotificationSettings'] | undefined
  services: WorkbenchServices
}
interface AccountOwner {
  ownershipKey: string
  entries: Map<string, { retire(): void }>
}
const owners = new WeakMap<
  ReturnType<typeof createWorkspaceTabsSession>,
  Map<string, AccountOwner>
>()

/** Layout snapshots, native exports and restoration queries belong to the actual window/tab owner. */
export function createDesktopLayoutSession(
  state: DesktopLayoutState,
  ownershipKey: string,
  tabs: ReturnType<typeof createWorkspaceTabsSession> | null,
  tabId?: string
) {
  let input: DesktopLayoutInput | null = null
  let accountOwner: AccountOwner | null = null
  let entryKey = ''
  let uiDetached = true
  let observers = 0
  let observationVersion = 0
  let retired = false
  let stopTabs: (() => void) | null = null
  let stopArchived: (() => void) | null = null
  let stopState: (() => void) | null = null
  let previousWorkItems: boolean | undefined
  let previousIm: DesktopLayoutInput['getImSettings']
  let previousServices: WorkbenchServices | null = null
  let previousBlankKey: string | null = null
  let harnessGeneration = 0
  let imGeneration = 0
  let scheduled = false
  let previousPath = stripAppBasePath(window.location.pathname)
  let settingsReturnPath = previousPath === '/todo' ? '/todo' : '/'
  const key = tabId ?? 'main'
  const inputs = () => {
    if (!input) throw new Error('Layout owner is not committed')
    return input
  }
  const isHeld = () => {
    if (retired || !input) return false
    if (!tabs) return observers > 0
    const snapshot = tabs.getSessionSnapshot()
    return (
      owners.get(tabs)?.get(key) === accountOwner &&
      snapshot.active &&
      (!tabId || snapshot.state.tabs.some(tab => tab.id === tabId))
    )
  }
  const isActive = () =>
    isHeld() &&
    Boolean(input?.routeActive) &&
    (!tabs || !tabId || tabs.getSessionSnapshot().state.activeTabId === tabId)
  const conversations = createDesktopLayoutConversations({
    ownershipKey,
    inputs,
    isHeld,
    isActive: () => isActive() && input?.surfaceKind !== 'board',
  })
  const currentRoute = () => {
    if (tabs && tabId)
      return (
        tabs.getSessionSnapshot().state.tabs.find(tab => tab.id === tabId)?.contentRoute ??
        inputs().ownedRoute
      )
    return inputs().ownedRoute
  }
  async function queryHarness(openSessionId?: string | null) {
    const generation = ++harnessGeneration
    const mutationRevision = state.getHarnessRevision()
    try {
      const rows = await listLocalHarnessSessions()
      if (
        !isHeld() ||
        generation !== harnessGeneration ||
        mutationRevision !== state.getHarnessRevision()
      )
        return
      const sessions: LocalHarnessWorkbenchSession[] = rows.map(session => ({
        sessionId: session.session_id,
        harnessId: session.harness_id,
        title: session.title,
        cwd: session.cwd,
        createdAt: session.created_at,
        isPrimary: session.is_primary,
        projectId: session.project_id,
        active: session.active,
        modelKey: session.model_key,
        pluginRoots: session.plugin_roots?.length ? session.plugin_roots : undefined,
        proxyToken: session.proxy_token,
      }))
      state.replaceRestoredHarnessSessions(sessions)
      if (openSessionId && sessions.some(session => session.sessionId === openSessionId)) {
        state.setActiveLocalHarnessSessionId(openSessionId)
        navigateTo('/')
      }
    } catch (error) {
      if (isHeld() && generation === harnessGeneration)
        console.error('Failed to restore local harness sessions:', error)
    }
  }
  async function refreshImSettings() {
    const generation = ++imGeneration
    const requested = inputs()
    const settings = (await requested.getImSettings?.()) ?? null
    if (isHeld() && generation === imGeneration && inputs().services === requested.services)
      state.setImNotificationSettings(settings)
    return settings
  }
  function activateBlankComposer() {
    if (!isHeld()) return
    state.setTaskView('workbench')
    state.setActiveLocalHarnessSessionId(null)
    inputs().activatePane(inputs().blankPaneKey)
  }
  function consumeComposer() {
    if (isHeld() && consumeNewChatComposerRequest(tabId)) activateBlankComposer()
  }
  function retire() {
    if (retired) return
    retired = true
    state.retire()
    harnessGeneration += 1
    imGeneration += 1
    conversations.retire()
    stopTabs?.()
    stopTabs = null
    stopArchived?.()
    stopArchived = null
    stopState?.()
    stopState = null
    if (accountOwner?.entries.get(entryKey)?.retire === retire)
      accountOwner.entries.delete(entryKey)
    if (
      tabs &&
      accountOwner &&
      !accountOwner.entries.size &&
      owners.get(tabs)?.get(key) === accountOwner
    )
      owners.get(tabs)?.delete(key)
  }
  function schedule() {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (isHeld()) reconcile(false)
    })
  }
  function synchronizeRoute(path: string) {
    previousPath = path
    state.setCurrentPath(path)
    state.setSettingsOpen(isSettingsRoute(path))
  }
  function reconcile(attached: boolean) {
    if (!isHeld() || !input) {
      retire()
      return
    }
    if (attached) synchronizeRoute(stripAppBasePath(window.location.pathname))
    const changedServices = previousServices !== input.services
    const changedSurface = previousWorkItems !== input.workItemSurfaceOpen
    if (attached || changedServices || changedSurface) {
      harnessGeneration += 1
      if (!input.workItemSurfaceOpen && isLocalHarnessAvailable()) void queryHarness()
    }
    if (attached || changedServices || changedSurface || previousIm !== input.getImSettings) {
      imGeneration += 1
      if (!input.workItemSurfaceOpen && input.getImSettings)
        void refreshImSettings().catch(() => undefined)
    }
    previousServices = input.services
    previousWorkItems = input.workItemSurfaceOpen
    previousIm = input.getImSettings
    conversations.reconcile()
    if (attached || previousBlankKey !== input.blankPaneKey) consumeComposer()
    previousBlankKey = input.blankPaneKey
    if (
      !input.sidebarCollapsed &&
      !state.getSnapshot().sidebarAutoCollapsed &&
      state.getSnapshot().sidebarPreviewOpen
    )
      state.setSidebarPreviewOpen(false)
  }
  return {
    state,
    isHeld,
    isActive,
    refreshImSettings,
    consumeComposer,
    activateBlankComposer,
    captureOwner() {
      const services = inputs().services
      return { isCurrent: () => isHeld() && inputs().services === services }
    },
    onHarnessSessionsChanged(event: CustomEvent<{ openSessionId?: string | null }>) {
      if (isHeld() && !input?.workItemSurfaceOpen && isLocalHarnessAvailable())
        void queryHarness(event.detail?.openSessionId)
    },
    onResize() {
      if (isHeld())
        state.setSidebarAutoCollapsed(window.innerWidth <= SIDEBAR_AUTO_COLLAPSE_WINDOW_WIDTH)
    },
    onLocation() {
      if (!isHeld()) return
      const path = stripAppBasePath(window.location.pathname)
      if (isSettingsRoute(path) && !isSettingsRoute(previousPath) && isActive()) {
        settingsReturnPath = currentRoute()
        if (!tabs) writeSettingsReturnPath(settingsReturnPath)
      }
      synchronizeRoute(path)
    },
    rememberSettingsReturnPath() {
      if (!isHeld()) return
      settingsReturnPath = currentRoute()
      writeSettingsReturnPath(settingsReturnPath)
    },
    getSettingsReturnPath: () => settingsReturnPath,
    observe(next: DesktopLayoutInput) {
      return {
        subscribe(listener: () => void) {
          const attached = uiDetached
          uiDetached = false
          input = next
          retired = false
          if (tabs) {
            let entries = owners.get(tabs)
            if (!entries) {
              entries = new Map()
              owners.set(tabs, entries)
            }
            let group = entries.get(key)
            if (group && group.ownershipKey !== ownershipKey) {
              entries.delete(key)
              for (const previous of [...group.entries.values()]) previous.retire()
              group = undefined
            }
            if (!group) {
              group = { ownershipKey, entries: new Map() }
              entries.set(key, group)
            }
            const nextEntry = next.surfaceKind ?? 'legacy'
            const previous = group.entries.get(nextEntry)
            if (previous?.retire !== retire) previous?.retire()
            if (
              accountOwner &&
              entryKey !== nextEntry &&
              accountOwner.entries.get(entryKey)?.retire === retire
            )
              accountOwner.entries.delete(entryKey)
            entryKey = nextEntry
            accountOwner = group
            entries.set(key, group)
            group.entries.set(entryKey, { retire })
          }
          observers += 1
          observationVersion += 1
          state.activate()
          const unsubscribe = state.subscribe(listener)
          if (!stopTabs && tabs) stopTabs = tabs.subscribeSession(() => reconcile(false))
          if (!stopState) stopState = state.subscribe(schedule)
          if (!stopArchived)
            stopArchived = subscribeArchivedCleanupError(state.setArchivedCleanupError)
          reconcile(attached)
          return () => {
            unsubscribe()
            observers -= 1
            const version = ++observationVersion
            queueMicrotask(() => {
              if (observationVersion !== version || observers) return
              uiDetached = true
              if (!isHeld()) retire()
            })
          }
        },
      }
    },
  }
}
export type DesktopLayoutSession = ReturnType<typeof createDesktopLayoutSession>
