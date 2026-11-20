import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import {
  navigateTo,
  parseRuntimeTaskRoute,
  replaceTo,
  WORKSPACE_NAVIGATION_EVENT,
  type WorkspaceNavigationDetail,
} from '@/lib/navigation'
import {
  closeWorkspaceTab,
  createWorkspaceTab,
  dispatchWorkspaceTabsClosed,
  workspaceTabRoute,
  type WorkspaceTab,
  type WorkspaceTabKind,
} from './workspaceTabs'
import {
  WorkspaceTabActivityContext,
  WorkspaceTabsContext,
  WorkspaceTabsSessionContext,
  type WorkspaceTabsContextValue,
} from './workspaceTabsContextValue'
import {
  createWorkspaceTabsSession,
  validTab,
  type WorkspaceTabsProviderProps,
} from './workspaceTabsSession'
import { getDesktopWindowLabel, isElectronRuntime } from '@/lib/runtime-environment'
import { WORKSPACE_TAB_RETURN_PREFIX } from './workspaceWindow'
import { getAppPreferences } from '@/desktop/appPreferences'
import { fixedWorkspaceTabPreference, saveFixedWorkspaceTabs } from './fixedWorkspaceTabs'
import { findRuntimeTaskTab, navigateWorkspaceTab } from './workspaceNavigation'
import { acceptWorkspaceTabTransfer } from './workspaceTabTransfer'
import {
  COLLABORATION_EXP_TAB_ID,
  isCollaborationExpPath,
} from '@/features/collaboration-exp/collaborationExpFeature'

const EMPTY_HIDDEN_TAB_PATHS: readonly string[] = []

export function WorkspaceTabsProvider(props: WorkspaceTabsProviderProps) {
  return <WorkspaceTabsSession key={props.storageScope} {...props} />
}

function WorkspaceTabsSession({ children, ...options }: WorkspaceTabsProviderProps) {
  const { labels, hiddenTabPaths = EMPTY_HIDDEN_TAB_PATHS } = options
  const [store] = useState(() => createWorkspaceTabsSession(options))
  const observation = useMemo(
    () =>
      store.observe({
        pathname: options.pathname,
        search: options.search,
        storageScope: options.storageScope,
        labels: options.labels,
        fixedTabs: options.fixedTabs,
        startupTabId: options.startupTabId,
        startupTabKind: options.startupTabKind,
        restoreSessionTabs: options.restoreSessionTabs,
        hiddenTabPaths: options.hiddenTabPaths,
        retainedTabPaths: options.retainedTabPaths,
      }),
    [
      store,
      options.pathname,
      options.search,
      options.storageScope,
      options.labels,
      options.fixedTabs,
      options.startupTabId,
      options.startupTabKind,
      options.restoreSessionTabs,
      options.hiddenTabPaths,
      options.retainedTabPaths,
    ]
  )
  const state = useSyncExternalStore(
    observation.subscribe,
    observation.getSnapshot,
    observation.getSnapshot
  )
  const dispatch = store.dispatch
  const hiddenPaths = useMemo(() => new Set(hiddenTabPaths), [hiddenTabPaths])
  const visibleTabs = useMemo(
    () => state.tabs.filter(tab => !hiddenPaths.has(tab.contentRoute.split('?', 1)[0])),
    [hiddenPaths, state.tabs]
  )
  const activeTab =
    visibleTabs.find(tab => tab.id === state.activeTabId) ?? visibleTabs[0] ?? state.tabs[0]

  useDOMEvent<StorageEvent>(
    'window',
    'storage',
    event => {
      if (!event.key?.startsWith(WORKSPACE_TAB_RETURN_PREFIX) || !event.newValue) return
      let tab: unknown
      try {
        tab = JSON.parse(event.newValue)
      } catch {
        return
      }
      if (!validTab(tab)) return
      const key = event.key
      const receivedTab = tab
      void (async () => {
        if (receivedTab.fixed) {
          const preferences = await getAppPreferences()
          if (!store.isObserved()) return
          await saveFixedWorkspaceTabs(
            preferences.fixedWorkspaceTabs.map(preference =>
              preference.id === receivedTab.id
                ? fixedWorkspaceTabPreference(receivedTab)
                : preference
            ),
            preferences.startupWorkspaceTabId
          )
        }
        // An expired request must not move a tab whose source is still open.
        if (!store.isObserved() || !localStorage.getItem(key)) return
        flushSync(() => {
          dispatch({ type: 'receive', tab: receivedTab })
        })
        navigateTo(workspaceTabRoute(receivedTab))
        // Preference synchronization may have mounted this tab before its return.
        // Commit its received drafts before acknowledging the source window.
        flushSync(() => acceptWorkspaceTabTransfer(receivedTab.id))
        localStorage.removeItem(key)
      })().catch(error => {
        console.error('Failed to accept returned workspace tab', error)
        if (store.isObserved() && localStorage.getItem(key)) {
          localStorage.setItem(key, JSON.stringify({ error: String(error) }))
        }
      })
    },
    { enabled: isElectronRuntime() && getDesktopWindowLabel() === 'main' }
  )

  const isWorkspaceTabActive = useCallback(
    (tabId: string) => store.getSnapshot().activeTabId === tabId,
    [store]
  )

  const selectTab = useCallback(
    (tabId: string, updates?: Partial<Pick<WorkspaceTab, 'title' | 'contentRoute'>>) => {
      const tab = state.tabs.find(candidate => candidate.id === tabId)
      if (!tab) return
      const updated = { ...tab, ...updates }
      flushSync(() => dispatch({ type: 'select', tabId, updates }))
      navigateTo(workspaceTabRoute(updated))
    },
    [dispatch, state.tabs]
  )

  const openTab = useCallback(
    (kind: WorkspaceTabKind, overrides: Partial<WorkspaceTab> = {}) => {
      const tab = createWorkspaceTab(kind, labels, overrides)
      if (hiddenPaths.has(tab.contentRoute.split('?', 1)[0])) {
        throw new Error('This workspace route is unavailable')
      }
      const existing = isCollaborationExpPath(tab.contentRoute)
        ? store.getSnapshot().tabs.find(candidate => isCollaborationExpPath(candidate.contentRoute))
        : undefined
      if (existing) {
        const updates = {
          contentRoute: tab.contentRoute.includes('?') ? tab.contentRoute : existing.contentRoute,
          title: overrides.title ?? existing.title,
        }
        selectTab(existing.id, updates)
        return { ...existing, ...updates }
      }
      flushSync(() => dispatch({ type: 'open', tab }))
      navigateTo(workspaceTabRoute(tab))
      return tab
    },
    [dispatch, hiddenPaths, labels, selectTab, store]
  )

  useDOMEvent<CustomEvent<WorkspaceNavigationDetail>>(
    'window',
    WORKSPACE_NAVIGATION_EVENT,
    event => {
      const { kind, contentRoute } = (event as CustomEvent<WorkspaceNavigationDetail>).detail
      const activeTab = store
        .getSnapshot()
        .tabs.find(tab => tab.id === store.getSnapshot().activeTabId)
      const [path, search] = contentRoute.split('?')
      if (hiddenPaths.has(path)) {
        event.preventDefault()
        return
      }
      if (isCollaborationExpPath(path)) {
        event.preventDefault()
        openTab('auxiliary', { contentRoute })
        return
      }
      if (activeTab?.id === COLLABORATION_EXP_TAB_ID) {
        event.preventDefault()
        navigateWorkspaceTab(
          {
            ...store.getSnapshot(),
            tabs: store.getSnapshot().tabs.filter(tab => tab.id !== COLLABORATION_EXP_TAB_ID),
            selectTab,
            openTab,
          },
          kind,
          contentRoute
        )
        return
      }
      const target = parseRuntimeTaskRoute(path, search)
      const matching = target ? findRuntimeTaskTab(store.getSnapshot().tabs, target) : null
      const isTaskSurface = (value: WorkspaceTabKind) => value === 'task' || value === 'auxiliary'
      if (
        activeTab &&
        (!matching || matching.id === activeTab.id) &&
        (activeTab.kind === kind || (isTaskSurface(activeTab.kind) && isTaskSurface(kind)))
      ) {
        return
      }
      event.preventDefault()
      navigateWorkspaceTab({ ...store.getSnapshot(), selectTab, openTab }, kind, contentRoute)
    }
  )

  const closeTab = useCallback(
    (tabId: string) => {
      const currentState = store.getSnapshot()
      const closingTab = currentState.tabs.find(tab => tab.id === tabId)
      if (!closingTab || closingTab.fixed) return
      const fallback = createWorkspaceTab('task', labels)
      const next = closeWorkspaceTab(currentState.tabs, currentState.activeTabId, tabId, fallback)
      flushSync(() => dispatch({ type: 'close', tabId, fallback }))
      dispatchWorkspaceTabsClosed([tabId])
      const nextActive = next.tabs.find(tab => tab.id === next.activeTabId) ?? next.tabs[0]
      navigateTo(workspaceTabRoute(nextActive))
    },
    [dispatch, labels, store]
  )

  const detachTab = useCallback(
    (tabId: string) => {
      const currentState = store.getSnapshot()
      if (!currentState.tabs.some(tab => tab.id === tabId)) return
      const fallback = createWorkspaceTab('task', labels)
      const next = closeWorkspaceTab(currentState.tabs, currentState.activeTabId, tabId, fallback)
      flushSync(() => dispatch({ type: 'detach', tabId, fallback }))
      dispatchWorkspaceTabsClosed([tabId])
      const nextActive = next.tabs.find(tab => tab.id === next.activeTabId) ?? next.tabs[0]
      navigateTo(workspaceTabRoute(nextActive))
    },
    [dispatch, labels, store]
  )

  const closeOtherTabs = useCallback(
    (tabId: string) => {
      const tab = state.tabs.find(candidate => candidate.id === tabId)
      if (!tab) return
      const closedTabIds = state.tabs
        .filter(
          candidate =>
            !candidate.fixed &&
            candidate.id !== tabId &&
            !hiddenPaths.has(candidate.contentRoute.split('?', 1)[0])
        )
        .map(candidate => candidate.id)
      flushSync(() => dispatch({ type: 'closeOthers', tabId, closeTabIds: closedTabIds }))
      dispatchWorkspaceTabsClosed(closedTabIds)
      navigateTo(workspaceTabRoute(tab))
    },
    [dispatch, hiddenPaths, state.tabs]
  )

  const moveTab = useCallback(
    (sourceId: string, targetId: string) => {
      dispatch({ type: 'move', sourceId, targetId })
    },
    [dispatch]
  )

  const restoreClosedTab = useCallback(() => {
    const tab = state.closedTabs.find(tab => !hiddenPaths.has(tab.contentRoute.split('?', 1)[0]))
    if (!tab) return
    const existingExperiment = isCollaborationExpPath(tab.contentRoute)
      ? state.tabs.find(candidate => isCollaborationExpPath(candidate.contentRoute))
      : undefined
    const restored =
      existingExperiment ??
      (state.tabs.some(candidate => candidate.id === tab.id)
        ? { ...tab, id: `${tab.kind}-${crypto.randomUUID()}` }
        : tab)
    flushSync(() => dispatch({ type: 'restoreClosed', restored, originalTabId: tab.id }))
    navigateTo(workspaceTabRoute(restored))
  }, [dispatch, hiddenPaths, state.closedTabs, state.tabs])

  const updateTab = useCallback(
    (tabId: string, updates: Partial<Pick<WorkspaceTab, 'title' | 'contentRoute'>>) => {
      const current = store.getSnapshot()
      const currentTab = current.tabs.find(tab => tab.id === tabId)
      if (!currentTab) return
      const updated = { ...currentTab, ...updates }
      flushSync(() => dispatch({ type: 'update', tabId, updates }))
      if (tabId === current.activeTabId) replaceTo(workspaceTabRoute(updated))
    },
    [dispatch, store]
  )
  const updateActiveTab = useCallback(
    (updates: Partial<Pick<WorkspaceTab, 'title' | 'contentRoute'>>) =>
      updateTab(state.activeTabId, updates),
    [state.activeTabId, updateTab]
  )

  const value = useMemo<WorkspaceTabsContextValue>(
    () => ({
      ...state,
      tabs: visibleTabs,
      closedTabs: state.closedTabs.filter(
        tab => !hiddenPaths.has(tab.contentRoute.split('?', 1)[0])
      ),
      activeTabId: activeTab.id,
      activeTab,
      openTab,
      selectTab,
      closeTab,
      detachTab,
      closeOtherTabs,
      restoreClosedTab,
      moveTab,
      updateTab,
      updateActiveTab,
    }),
    [
      activeTab,
      hiddenPaths,
      closeOtherTabs,
      closeTab,
      detachTab,
      moveTab,
      openTab,
      restoreClosedTab,
      selectTab,
      state,
      updateTab,
      updateActiveTab,
      visibleTabs,
    ]
  )

  return (
    <WorkspaceTabActivityContext.Provider value={isWorkspaceTabActive}>
      <WorkspaceTabsSessionContext.Provider value={store}>
        <WorkspaceTabsContext.Provider value={value}>{children}</WorkspaceTabsContext.Provider>
      </WorkspaceTabsSessionContext.Provider>
    </WorkspaceTabActivityContext.Provider>
  )
}
