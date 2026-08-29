import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'
import { flushSync } from 'react-dom'
import { navigateTo, replaceTo } from '@/lib/navigation'
import {
  closeWorkspaceTab,
  createWorkspaceTab,
  dispatchWorkspaceTabsClosed,
  inferWorkspaceTabKind,
  moveWorkspaceTab,
  parseWorkspaceLocation,
  persistWorkspaceTabs,
  workspaceTabRoute,
  workspaceTabsStorageKey,
  workspaceTabTitle,
  type WorkspaceTab,
  type WorkspaceTabKind,
  type WorkspaceTabLabels,
} from './workspaceTabs'
import { WorkspaceTabsContext, type WorkspaceTabsContextValue } from './workspaceTabsContextValue'
import { resolveDshRoute } from '@/features/dsh-runtime/dshRoutes'

interface PersistedWorkspaceTabs {
  activeTabId: string
  tabs: WorkspaceTab[]
}

interface WorkspaceTabsState extends PersistedWorkspaceTabs {
  closedTabs: WorkspaceTab[]
}

type WorkspaceTabsAction =
  | { type: 'routeChanged'; pathname: string; search: string; labels: WorkspaceTabLabels }
  | {
      type: 'select'
      tabId: string
      updates?: Partial<Pick<WorkspaceTab, 'title' | 'contentRoute'>>
    }
  | { type: 'open'; tab: WorkspaceTab }
  | { type: 'close'; tabId: string; fallback: WorkspaceTab }
  | { type: 'closeOthers'; tabId: string }
  | { type: 'restoreClosed'; restored: WorkspaceTab }
  | { type: 'move'; sourceId: string; targetId: string }
  | { type: 'syncFixed'; tabs: WorkspaceTab[] }
  | { type: 'updateActive'; updates: Partial<Pick<WorkspaceTab, 'title' | 'contentRoute'>> }

interface WorkspaceTabsProviderProps {
  pathname: string
  search: string
  storageScope: string
  labels: WorkspaceTabLabels
  startupTabKind?: Exclude<WorkspaceTabKind, 'auxiliary'>
  fixedTabs?: WorkspaceTab[]
  startupTabId?: string
  restoreSessionTabs?: boolean
  children: ReactNode
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

function normalizePersistedTab(tab: WorkspaceTab, labels: WorkspaceTabLabels): WorkspaceTab {
  const isLegacyDefaultBoard =
    tab.kind === 'board' &&
    tab.contentRoute === '/todo' &&
    ['工作项', '项目空间', 'Work items', 'Project spaces'].includes(tab.title)
  const normalized = { ...tab, fixed: tab.fixed === true }
  return isLegacyDefaultBoard ? { ...normalized, title: labels.board } : normalized
}

function loadPersistedTabs(
  scope: string,
  pathname: string,
  search: string,
  labels: WorkspaceTabLabels,
  fixedTabs: WorkspaceTab[],
  restoreSessionTabs: boolean
): WorkspaceTabsState {
  const location = parseWorkspaceLocation(pathname, search)
  if (restoreSessionTabs) {
    try {
      const parsed = JSON.parse(
        localStorage.getItem(workspaceTabsStorageKey(scope)) ?? 'null'
      ) as PersistedWorkspaceTabs | null
      if (parsed && Array.isArray(parsed.tabs)) {
        const tabs = parsed.tabs.filter(validTab).map(tab => normalizePersistedTab(tab, labels))
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
  }

  const kind = inferWorkspaceTabKind(pathname)
  const defaultTabs =
    fixedTabs.length > 0
      ? fixedTabs
      : (['task', 'board', 'agent'] as const).map(defaultKind =>
          createWorkspaceTab(defaultKind, labels)
        )
  const matchingDefault = defaultTabs.find(tab => tab.kind === kind)
  const routeTab = createWorkspaceTab(kind, labels, {
    id: location.tabId ?? matchingDefault?.id,
    title: location.tabTitle ?? workspaceTabTitle(kind, location.contentRoute, labels),
    contentRoute: location.contentRoute,
    fixed: matchingDefault?.fixed,
  })
  const tabs = matchingDefault
    ? defaultTabs.map(tab => (tab.id === matchingDefault.id ? routeTab : tab))
    : [...defaultTabs, routeTab]
  return { tabs, activeTabId: routeTab.id, closedTabs: [] }
}

function sessionRestorableTabs(tabs: WorkspaceTab[]): WorkspaceTab[] {
  return tabs.filter(tab => {
    const pathname = tab.contentRoute.split('?', 1)[0]
    return resolveDshRoute(pathname)?.restorePolicy !== 'none'
  })
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
        ? {
            ...state,
            activeTabId: action.tabId,
            tabs: action.updates
              ? state.tabs.map(tab =>
                  tab.id === action.tabId ? { ...tab, ...action.updates } : tab
                )
              : state.tabs,
          }
        : state
    case 'open':
      return { ...state, tabs: [...state.tabs, action.tab], activeTabId: action.tab.id }
    case 'close': {
      const closingTab = state.tabs.find(tab => tab.id === action.tabId)
      if (!closingTab || closingTab.fixed) return state
      const next = closeWorkspaceTab(state.tabs, state.activeTabId, action.tabId, action.fallback)
      return {
        ...next,
        closedTabs: [closingTab, ...state.closedTabs].slice(0, 10),
      }
    }
    case 'closeOthers': {
      const tab = state.tabs.find(candidate => candidate.id === action.tabId)
      if (!tab) return state
      const retainedTabs = state.tabs.filter(
        candidate => candidate.fixed || candidate.id === tab.id
      )
      const closedTabs = state.tabs
        .filter(candidate => !candidate.fixed && candidate.id !== action.tabId)
        .reverse()
      return {
        tabs: retainedTabs,
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
    case 'syncFixed': {
      const fixedIds = new Set(action.tabs.map(tab => tab.id))
      const currentById = new Map(state.tabs.map(tab => [tab.id, tab]))
      const bootstrapReplacementById = new Map<string, string>()
      const bootstrapByFixedId = new Map<string, WorkspaceTab>()
      if (!state.tabs.some(tab => tab.fixed)) {
        const availableBootstrapTabs = state.tabs.filter(tab => !tab.fixed && !fixedIds.has(tab.id))
        for (const fixedTab of action.tabs) {
          if (currentById.has(fixedTab.id)) continue
          const bootstrapTab = availableBootstrapTabs.find(
            tab =>
              !bootstrapReplacementById.has(tab.id) &&
              tab.kind === fixedTab.kind &&
              (fixedTab.kind !== 'auxiliary' || tab.contentRoute === fixedTab.contentRoute)
          )
          if (bootstrapTab) {
            bootstrapReplacementById.set(bootstrapTab.id, fixedTab.id)
            bootstrapByFixedId.set(fixedTab.id, bootstrapTab)
          }
        }
      }
      const syncedFixedTabs = action.tabs.map(tab => {
        const current = currentById.get(tab.id)
        if (current && !tab.contentRoute.startsWith('/app/harness-')) {
          return {
            ...tab,
            kind: current.kind,
            title: current.title,
            contentRoute: current.contentRoute,
          }
        }
        const bootstrap = bootstrapByFixedId.get(tab.id)
        return bootstrap ? { ...tab, contentRoute: bootstrap.contentRoute } : tab
      })
      const ordinaryTabs = state.tabs
        .filter(tab => !fixedIds.has(tab.id) && !bootstrapReplacementById.has(tab.id))
        .map(tab => (tab.fixed ? { ...tab, fixed: false } : tab))
      const tabs = [...syncedFixedTabs, ...ordinaryTabs]
      const replacedActiveTabId = bootstrapReplacementById.get(state.activeTabId)
      return {
        ...state,
        tabs,
        activeTabId: tabs.some(tab => tab.id === (replacedActiveTabId ?? state.activeTabId))
          ? (replacedActiveTabId ?? state.activeTabId)
          : (tabs[0]?.id ?? state.activeTabId),
      }
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
  startupTabKind,
  fixedTabs = [],
  startupTabId,
  restoreSessionTabs = true,
  children,
}: WorkspaceTabsProviderProps) {
  const startupTabApplied = useRef(false)
  const [state, dispatch] = useReducer(
    workspaceTabsReducer,
    undefined,
    (): WorkspaceTabsState =>
      loadPersistedTabs(storageScope, pathname, search, labels, fixedTabs, restoreSessionTabs)
  )
  const stateRef = useRef(state)

  useLayoutEffect(() => {
    stateRef.current = state
  }, [state])

  useEffect(() => {
    if (fixedTabs.length > 0) dispatch({ type: 'syncFixed', tabs: fixedTabs })
  }, [fixedTabs])

  useLayoutEffect(() => {
    dispatch({ type: 'routeChanged', pathname, search, labels })
  }, [labels, pathname, search])

  useEffect(() => {
    if (startupTabApplied.current || (!startupTabKind && !startupTabId)) return
    const location = parseWorkspaceLocation(pathname, search)
    if (pathname !== '/' || location.tabId || location.contentRoute !== '/') return
    if (
      startupTabId &&
      fixedTabs.some(tab => tab.id === startupTabId) &&
      !state.tabs.some(tab => tab.id === startupTabId)
    ) {
      return
    }
    startupTabApplied.current = true
    const existingStartupTab =
      state.tabs.find(tab => tab.id === startupTabId) ??
      state.tabs.find(tab => tab.kind === startupTabKind)
    if (existingStartupTab?.id === state.activeTabId) return
    const startupTab = existingStartupTab ?? createWorkspaceTab(startupTabKind ?? 'task', labels)
    flushSync(() =>
      dispatch(
        existingStartupTab
          ? { type: 'select', tabId: existingStartupTab.id }
          : { type: 'open', tab: startupTab }
      )
    )
    navigateTo(workspaceTabRoute(startupTab))
  }, [
    fixedTabs,
    labels,
    pathname,
    search,
    startupTabId,
    startupTabKind,
    state.activeTabId,
    state.tabs,
  ])

  useEffect(() => {
    if (!restoreSessionTabs) return
    try {
      const tabs = sessionRestorableTabs(state.tabs)
      const persisted: PersistedWorkspaceTabs = {
        activeTabId: tabs.some(tab => tab.id === state.activeTabId)
          ? state.activeTabId
          : (tabs[0]?.id ?? ''),
        tabs,
      }
      persistWorkspaceTabs(storageScope, persisted.tabs, persisted.activeTabId)
    } catch {
      // Tabs remain usable in memory when persistence is unavailable.
    }
  }, [restoreSessionTabs, state, storageScope])

  const selectTab = useCallback(
    (tabId: string, updates?: Partial<Pick<WorkspaceTab, 'title' | 'contentRoute'>>) => {
      const tab = state.tabs.find(candidate => candidate.id === tabId)
      if (!tab) return
      const updated = { ...tab, ...updates }
      flushSync(() => dispatch({ type: 'select', tabId, updates }))
      navigateTo(workspaceTabRoute(updated))
    },
    [state.tabs]
  )

  const openTab = useCallback(
    (kind: WorkspaceTabKind, overrides: Partial<WorkspaceTab> = {}) => {
      const tab = createWorkspaceTab(kind, labels, overrides)
      flushSync(() => dispatch({ type: 'open', tab }))
      navigateTo(workspaceTabRoute(tab))
      return tab
    },
    [labels]
  )

  const closeTab = useCallback(
    (tabId: string) => {
      const currentState = stateRef.current
      const closingTab = currentState.tabs.find(tab => tab.id === tabId)
      if (!closingTab || closingTab.fixed) return
      const fallback = createWorkspaceTab('task', labels)
      const next = closeWorkspaceTab(currentState.tabs, currentState.activeTabId, tabId, fallback)
      flushSync(() => dispatch({ type: 'close', tabId, fallback }))
      dispatchWorkspaceTabsClosed([tabId])
      const nextActive = next.tabs.find(tab => tab.id === next.activeTabId) ?? next.tabs[0]
      navigateTo(workspaceTabRoute(nextActive))
    },
    [labels]
  )

  const closeOtherTabs = useCallback(
    (tabId: string) => {
      const tab = state.tabs.find(candidate => candidate.id === tabId)
      if (!tab) return
      const closedTabIds = state.tabs
        .filter(candidate => !candidate.fixed && candidate.id !== tabId)
        .map(candidate => candidate.id)
      flushSync(() => dispatch({ type: 'closeOthers', tabId }))
      dispatchWorkspaceTabsClosed(closedTabIds)
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
    flushSync(() => dispatch({ type: 'restoreClosed', restored }))
    navigateTo(workspaceTabRoute(restored))
  }, [state.closedTabs, state.tabs])

  const updateActiveTab = useCallback(
    (updates: Partial<Pick<WorkspaceTab, 'title' | 'contentRoute'>>) => {
      const currentTab = state.tabs.find(tab => tab.id === state.activeTabId)
      if (!currentTab) return
      const updated = { ...currentTab, ...updates }
      flushSync(() => dispatch({ type: 'updateActive', updates }))
      replaceTo(workspaceTabRoute(updated))
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
