import { useCallback, useEffect, useMemo, useReducer, type ReactNode } from 'react'
import { navigateTo, toBrowserPath } from '@/lib/navigation'
import {
  closeWorkspaceTab,
  createWorkspaceTab,
  inferWorkspaceTabKind,
  moveWorkspaceTab,
  parseWorkspaceLocation,
  workspaceTabRoute,
  workspaceTabTitle,
  type WorkspaceTab,
  type WorkspaceTabKind,
  type WorkspaceTabLabels,
} from './workspaceTabs'
import { WorkspaceTabsContext, type WorkspaceTabsContextValue } from './workspaceTabsContextValue'

interface PersistedWorkspaceTabs {
  activeTabId: string
  tabs: WorkspaceTab[]
}

interface WorkspaceTabsState extends PersistedWorkspaceTabs {
  closedTabs: WorkspaceTab[]
}

type WorkspaceTabsAction =
  | { type: 'routeChanged'; pathname: string; search: string; labels: WorkspaceTabLabels }
  | { type: 'select'; tabId: string }
  | { type: 'open'; tab: WorkspaceTab }
  | { type: 'close'; tabId: string; fallback: WorkspaceTab }
  | { type: 'closeOthers'; tabId: string }
  | { type: 'restoreClosed'; restored: WorkspaceTab }
  | { type: 'move'; sourceId: string; targetId: string }
  | { type: 'updateActive'; updates: Partial<Pick<WorkspaceTab, 'title' | 'contentRoute'>> }

interface WorkspaceTabsProviderProps {
  pathname: string
  search: string
  storageScope: string
  labels: WorkspaceTabLabels
  children: ReactNode
}

function storageKey(scope: string): string {
  return `wework.workspaceTabs.v1:${scope}`
}

function validTab(value: unknown): value is WorkspaceTab {
  if (!value || typeof value !== 'object') return false
  const candidate = value as WorkspaceTab
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.contentRoute === 'string' &&
    ['task', 'board', 'agent', 'auxiliary'].includes(candidate.kind)
  )
}

function loadPersistedTabs(
  scope: string,
  pathname: string,
  search: string,
  labels: WorkspaceTabLabels
): WorkspaceTabsState {
  const location = parseWorkspaceLocation(pathname, search)
  try {
    const parsed = JSON.parse(
      localStorage.getItem(storageKey(scope)) ?? 'null'
    ) as PersistedWorkspaceTabs | null
    if (parsed && Array.isArray(parsed.tabs)) {
      const tabs = parsed.tabs.filter(validTab)
      if (tabs.length > 0) {
        const requested = location.tabId
          ? tabs.find(tab => tab.id === location.tabId)
          : tabs.find(tab => tab.contentRoute === location.contentRoute)
        return {
          tabs,
          activeTabId:
            requested?.id ?? tabs.find(tab => tab.id === parsed.activeTabId)?.id ?? tabs[0].id,
          closedTabs: [],
        }
      }
    }
  } catch {
    // Invalid persisted state is replaced by the route-derived tab below.
  }

  const kind = inferWorkspaceTabKind(pathname)
  const tab = createWorkspaceTab(kind, labels, {
    id: location.tabId ?? undefined,
    title: location.tabTitle ?? workspaceTabTitle(kind, location.contentRoute, labels),
    contentRoute: location.contentRoute,
  })
  return { tabs: [tab], activeTabId: tab.id, closedTabs: [] }
}

function replaceTabRoute(tab: WorkspaceTab) {
  const browserPath = toBrowserPath(workspaceTabRoute(tab))
  window.history.replaceState({}, '', browserPath)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function workspaceTabsReducer(
  state: WorkspaceTabsState,
  action: WorkspaceTabsAction
): WorkspaceTabsState {
  switch (action.type) {
    case 'routeChanged': {
      const location = parseWorkspaceLocation(action.pathname, action.search)
      const requested = location.tabId
        ? state.tabs.find(tab => tab.id === location.tabId)
        : undefined
      const kind = inferWorkspaceTabKind(action.pathname)
      if (requested) {
        const updated = {
          ...requested,
          kind,
          title: location.tabTitle ?? workspaceTabTitle(kind, location.contentRoute, action.labels),
          contentRoute: location.contentRoute,
        }
        return {
          ...state,
          activeTabId: requested.id,
          tabs: state.tabs.map(tab => (tab.id === requested.id ? updated : tab)),
        }
      }
      if (!location.tabId) {
        const activeTab = state.tabs.find(tab => tab.id === state.activeTabId)
        if (activeTab) {
          const updated = {
            ...activeTab,
            kind,
            title: workspaceTabTitle(kind, location.contentRoute, action.labels),
            contentRoute: location.contentRoute,
          }
          return {
            ...state,
            tabs: state.tabs.map(tab => (tab.id === activeTab.id ? updated : tab)),
          }
        }
      }
      const next = createWorkspaceTab(kind, action.labels, {
        id: location.tabId ?? undefined,
        title: location.tabTitle ?? workspaceTabTitle(kind, location.contentRoute, action.labels),
        contentRoute: location.contentRoute,
      })
      return { ...state, tabs: [...state.tabs, next], activeTabId: next.id }
    }
    case 'select':
      return state.tabs.some(tab => tab.id === action.tabId)
        ? { ...state, activeTabId: action.tabId }
        : state
    case 'open':
      return { ...state, tabs: [...state.tabs, action.tab], activeTabId: action.tab.id }
    case 'close': {
      const closingTab = state.tabs.find(tab => tab.id === action.tabId)
      if (!closingTab) return state
      const next = closeWorkspaceTab(state.tabs, state.activeTabId, action.tabId, action.fallback)
      return {
        ...next,
        closedTabs: [closingTab, ...state.closedTabs].slice(0, 10),
      }
    }
    case 'closeOthers': {
      const tab = state.tabs.find(candidate => candidate.id === action.tabId)
      if (!tab) return state
      const closedTabs = state.tabs.filter(candidate => candidate.id !== action.tabId).reverse()
      return {
        tabs: [tab],
        activeTabId: tab.id,
        closedTabs: [...closedTabs, ...state.closedTabs].slice(0, 10),
      }
    }
    case 'restoreClosed': {
      if (state.closedTabs.length === 0) return state
      const [, ...closedTabs] = state.closedTabs
      return {
        tabs: [...state.tabs, action.restored],
        activeTabId: action.restored.id,
        closedTabs,
      }
    }
    case 'move':
      return {
        ...state,
        tabs: moveWorkspaceTab(state.tabs, action.sourceId, action.targetId),
      }
    case 'updateActive':
      return {
        ...state,
        tabs: state.tabs.map(tab =>
          tab.id === state.activeTabId ? { ...tab, ...action.updates } : tab
        ),
      }
  }
}

export function WorkspaceTabsProvider({
  pathname,
  search,
  storageScope,
  labels,
  children,
}: WorkspaceTabsProviderProps) {
  const [state, dispatch] = useReducer(
    workspaceTabsReducer,
    undefined,
    (): WorkspaceTabsState => loadPersistedTabs(storageScope, pathname, search, labels)
  )

  useEffect(() => {
    dispatch({ type: 'routeChanged', pathname, search, labels })
  }, [labels, pathname, search])

  useEffect(() => {
    try {
      const persisted: PersistedWorkspaceTabs = {
        activeTabId: state.activeTabId,
        tabs: state.tabs,
      }
      localStorage.setItem(storageKey(storageScope), JSON.stringify(persisted))
    } catch {
      // Tabs remain usable in memory when persistence is unavailable.
    }
  }, [state, storageScope])

  const selectTab = useCallback(
    (tabId: string) => {
      const tab = state.tabs.find(candidate => candidate.id === tabId)
      if (!tab) return
      dispatch({ type: 'select', tabId })
      navigateTo(workspaceTabRoute(tab))
    },
    [state.tabs]
  )

  const openTab = useCallback(
    (kind: WorkspaceTabKind, overrides: Partial<WorkspaceTab> = {}) => {
      const tab = createWorkspaceTab(kind, labels, overrides)
      dispatch({ type: 'open', tab })
      navigateTo(workspaceTabRoute(tab))
      return tab
    },
    [labels]
  )

  const closeTab = useCallback(
    (tabId: string) => {
      const fallback = createWorkspaceTab('task', labels)
      const next = closeWorkspaceTab(state.tabs, state.activeTabId, tabId, fallback)
      dispatch({ type: 'close', tabId, fallback })
      const nextActive = next.tabs.find(tab => tab.id === next.activeTabId) ?? next.tabs[0]
      navigateTo(workspaceTabRoute(nextActive))
    },
    [labels, state.activeTabId, state.tabs]
  )

  const closeOtherTabs = useCallback(
    (tabId: string) => {
      const tab = state.tabs.find(candidate => candidate.id === tabId)
      if (!tab) return
      dispatch({ type: 'closeOthers', tabId })
      navigateTo(workspaceTabRoute(tab))
    },
    [state.tabs]
  )

  const moveTab = useCallback((sourceId: string, targetId: string) => {
    dispatch({ type: 'move', sourceId, targetId })
  }, [])

  const restoreClosedTab = useCallback(() => {
    const tab = state.closedTabs[0]
    if (!tab) return
    const restored = state.tabs.some(candidate => candidate.id === tab.id)
      ? { ...tab, id: `${tab.kind}-${crypto.randomUUID()}` }
      : tab
    dispatch({ type: 'restoreClosed', restored })
    navigateTo(workspaceTabRoute(restored))
  }, [state.closedTabs, state.tabs])

  const updateActiveTab = useCallback(
    (updates: Partial<Pick<WorkspaceTab, 'title' | 'contentRoute'>>) => {
      const currentTab = state.tabs.find(tab => tab.id === state.activeTabId)
      if (!currentTab) return
      const updated = { ...currentTab, ...updates }
      dispatch({ type: 'updateActive', updates })
      replaceTabRoute(updated)
    },
    [state.activeTabId, state.tabs]
  )

  const activeTab =
    state.tabs.find(tab => tab.id === state.activeTabId) ??
    state.tabs[0] ??
    createWorkspaceTab('task', labels)
  const value = useMemo<WorkspaceTabsContextValue>(
    () => ({
      ...state,
      activeTab,
      openTab,
      selectTab,
      closeTab,
      closeOtherTabs,
      restoreClosedTab,
      moveTab,
      updateActiveTab,
    }),
    [
      activeTab,
      closeOtherTabs,
      closeTab,
      moveTab,
      openTab,
      restoreClosedTab,
      selectTab,
      state,
      updateActiveTab,
    ]
  )

  return <WorkspaceTabsContext.Provider value={value}>{children}</WorkspaceTabsContext.Provider>
}
