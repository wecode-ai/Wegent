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
import {
  isSettingsRoute,
  navigateTo,
  parseRuntimeTaskRoute,
  replaceTo,
  WORKSPACE_NAVIGATION_EVENT,
  type WorkspaceNavigationDetail,
} from '@/lib/navigation'
import {
  closeWorkspaceTab,
  createWorkspaceTab,
  defaultContentRoute,
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
import {
  WorkspaceTabActivityContext,
  WorkspaceTabsContext,
  type WorkspaceTabsContextValue,
} from './workspaceTabsContextValue'
import { resolveDshRoute } from '@/features/dsh-runtime/dshRoutes'
import { projectSpaceRouteRequestsDefaultProject } from '@/features/todo/projectSpaceRoute'
import { writeSettingsReturnPath } from './settingsReturnPath'
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

interface PersistedWorkspaceTabs {
  activeTabId: string
  tabs: WorkspaceTab[]
}

interface WorkspaceTabsState extends PersistedWorkspaceTabs {
  closedTabs: WorkspaceTab[]
}

const EMPTY_FIXED_TABS: WorkspaceTab[] = []
const EMPTY_HIDDEN_TAB_PATHS: readonly string[] = []

type WorkspaceTabsAction =
  | { type: 'routeChanged'; pathname: string; search: string; labels: WorkspaceTabLabels }
  | {
      type: 'select'
      tabId: string
      updates?: Partial<Pick<WorkspaceTab, 'title' | 'contentRoute'>>
    }
  | { type: 'open'; tab: WorkspaceTab }
  | { type: 'receive'; tab: WorkspaceTab }
  | { type: 'close'; tabId: string; fallback: WorkspaceTab }
  | { type: 'detach'; tabId: string; fallback: WorkspaceTab }
  | { type: 'closeOthers'; tabId: string; closeTabIds: string[] }
  | { type: 'restoreClosed'; restored: WorkspaceTab; originalTabId: string }
  | { type: 'move'; sourceId: string; targetId: string }
  | { type: 'syncFixed'; tabs: WorkspaceTab[] }
  | {
      type: 'update'
      tabId: string
      updates: Partial<Pick<WorkspaceTab, 'title' | 'contentRoute'>>
    }

interface WorkspaceTabsProviderProps {
  pathname: string
  search: string
  storageScope: string
  labels: WorkspaceTabLabels
  startupTabKind?: Exclude<WorkspaceTabKind, 'auxiliary'>
  fixedTabs?: WorkspaceTab[]
  startupTabId?: string
  restoreSessionTabs?: boolean
  hiddenTabPaths?: readonly string[]
  retainedTabPaths?: readonly string[]
  children: ReactNode
}

function validTab(value: unknown): value is WorkspaceTab {
  if (!value || typeof value !== 'object') return false
  const candidate = value as WorkspaceTab
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.contentRoute === 'string' &&
    !isSettingsRoute(candidate.contentRoute.split('?', 1)[0]) &&
    ['task', 'board', 'agent', 'auxiliary'].includes(candidate.kind)
  )
}

function normalizePersistedTab(tab: WorkspaceTab, labels: WorkspaceTabLabels): WorkspaceTab {
  const isLegacyDefaultBoard =
    tab.kind === 'board' &&
    (tab.contentRoute === '/todo' || projectSpaceRouteRequestsDefaultProject(tab.contentRoute)) &&
    [
      '工作项',
      '项目空间',
      '工作空间',
      '协作',
      '协作 (Beta)',
      'Work items',
      'Project spaces',
      'Workspaces',
      'Collaboration',
      'Collaboration (Beta)',
    ].includes(tab.title)
  const normalized = { ...tab, fixed: tab.fixed === true }
  if (
    normalized.fixed &&
    tab.kind !== 'auxiliary' &&
    tab.contentRoute === defaultContentRoute(tab.kind)
  ) {
    return { ...normalized, title: labels[tab.kind] }
  }
  return isLegacyDefaultBoard
    ? { ...normalized, title: labels.board, contentRoute: '/todo' }
    : normalized
}

function loadPersistedTabs(
  scope: string,
  pathname: string,
  search: string,
  labels: WorkspaceTabLabels,
  fixedTabs: WorkspaceTab[],
  restoreSessionTabs: boolean,
  retainedTabPaths: readonly string[]
): WorkspaceTabsState {
  const location = parseWorkspaceLocation(pathname, search)
  let retainedTabs: WorkspaceTab[] = []
  if (restoreSessionTabs || retainedTabPaths.length) {
    try {
      const parsed = JSON.parse(
        localStorage.getItem(workspaceTabsStorageKey(scope)) ?? 'null'
      ) as PersistedWorkspaceTabs | null
      if (parsed && Array.isArray(parsed.tabs)) {
        const tabs = parsed.tabs.filter(validTab).map(tab => normalizePersistedTab(tab, labels))
        retainedTabs = tabs.filter(tab =>
          retainedTabPaths.includes(tab.contentRoute.split('?', 1)[0])
        )
        if (restoreSessionTabs && tabs.length > 0) {
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

  const configuredTabs =
    fixedTabs.length > 0
      ? fixedTabs
      : (['task', 'board', 'agent'] as const).map(defaultKind =>
          createWorkspaceTab(defaultKind, labels)
        )
  const defaultTabs = [
    ...configuredTabs.map(tab => {
      const retained = retainedTabs.find(candidate => candidate.id === tab.id)
      return retained ? { ...retained, fixed: tab.fixed } : tab
    }),
    ...retainedTabs.filter(tab => !configuredTabs.some(candidate => candidate.id === tab.id)),
  ]
  if (isSettingsRoute(pathname)) {
    return { tabs: defaultTabs, activeTabId: defaultTabs[0].id, closedTabs: [] }
  }
  const kind = inferWorkspaceTabKind(pathname)
  const matchingDefault = defaultTabs.find(
    tab =>
      tab.kind === kind && (kind !== 'auxiliary' || tab.contentRoute.split('?', 1)[0] === pathname)
  )
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
      if (isSettingsRoute(action.pathname)) return state
      const location = parseWorkspaceLocation(action.pathname, action.search)
      const dedicatedRoute = isCollaborationExpPath(action.pathname)
      const kind = inferWorkspaceTabKind(action.pathname)
      const requested = dedicatedRoute
        ? state.tabs.find(tab => isCollaborationExpPath(tab.contentRoute))
        : location.tabId
          ? state.tabs.find(tab => tab.id === location.tabId && tab.id !== COLLABORATION_EXP_TAB_ID)
          : state.activeTabId === COLLABORATION_EXP_TAB_ID
            ? state.tabs.find(
                tab => tab.kind === kind && tab.contentRoute === location.contentRoute
              )
            : undefined
      if (requested) {
        const title =
          location.tabTitle ?? workspaceTabTitle(kind, location.contentRoute, action.labels)
        if (
          state.activeTabId === requested.id &&
          requested.kind === kind &&
          requested.title === title &&
          requested.contentRoute === location.contentRoute
        ) {
          return state
        }
        const updated = {
          ...requested,
          kind,
          title,
          contentRoute: location.contentRoute,
        }
        return {
          ...state,
          activeTabId: requested.id,
          tabs: state.tabs.map(tab => (tab.id === requested.id ? updated : tab)),
        }
      }
      if (!location.tabId && !dedicatedRoute) {
        const activeTab = state.tabs.find(tab => tab.id === state.activeTabId)
        if (activeTab && activeTab.id !== COLLABORATION_EXP_TAB_ID) {
          const title = workspaceTabTitle(kind, location.contentRoute, action.labels)
          if (
            activeTab.kind === kind &&
            activeTab.title === title &&
            activeTab.contentRoute === location.contentRoute
          ) {
            return state
          }
          const updated = {
            ...activeTab,
            kind,
            title,
            contentRoute: location.contentRoute,
          }
          return {
            ...state,
            tabs: state.tabs.map(tab => (tab.id === activeTab.id ? updated : tab)),
          }
        }
      }
      const next = createWorkspaceTab(kind, action.labels, {
        id: dedicatedRoute
          ? COLLABORATION_EXP_TAB_ID
          : location.tabId === COLLABORATION_EXP_TAB_ID
            ? undefined
            : (location.tabId ?? undefined),
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
    case 'receive':
      return {
        ...state,
        tabs: [...state.tabs.filter(tab => tab.id !== action.tab.id), action.tab],
        activeTabId: action.tab.id,
      }
    case 'close': {
      const closingTab = state.tabs.find(tab => tab.id === action.tabId)
      if (!closingTab || closingTab.fixed) return state
      const next = closeWorkspaceTab(state.tabs, state.activeTabId, action.tabId, action.fallback)
      return {
        ...next,
        closedTabs: [closingTab, ...state.closedTabs].slice(0, 10),
      }
    }
    case 'detach': {
      const next = closeWorkspaceTab(state.tabs, state.activeTabId, action.tabId, action.fallback)
      return {
        ...next,
        closedTabs: state.closedTabs,
      }
    }
    case 'closeOthers': {
      const tab = state.tabs.find(candidate => candidate.id === action.tabId)
      if (!tab) return state
      const closingIds = new Set(action.closeTabIds)
      const retainedTabs = state.tabs.filter(candidate => !closingIds.has(candidate.id))
      const closedTabs = state.tabs.filter(candidate => closingIds.has(candidate.id)).reverse()
      return {
        tabs: retainedTabs,
        activeTabId: tab.id,
        closedTabs: [...closedTabs, ...state.closedTabs].slice(0, 10),
      }
    }
    case 'restoreClosed': {
      if (state.closedTabs.length === 0) return state
      return {
        tabs: state.tabs.some(tab => tab.id === action.restored.id)
          ? state.tabs
          : [...state.tabs, action.restored],
        activeTabId: action.restored.id,
        closedTabs: state.closedTabs.filter(tab => tab.id !== action.originalTabId),
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
            title:
              current.kind === tab.kind &&
              current.kind !== 'auxiliary' &&
              current.contentRoute === defaultContentRoute(current.kind)
                ? tab.title
                : current.title,
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
    case 'update':
      return {
        ...state,
        tabs: state.tabs.map(tab =>
          tab.id === action.tabId ? { ...tab, ...action.updates } : tab
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
  fixedTabs: restoredFixedTabs = EMPTY_FIXED_TABS,
  startupTabId,
  restoreSessionTabs = true,
  hiddenTabPaths = EMPTY_HIDDEN_TAB_PATHS,
  retainedTabPaths = EMPTY_HIDDEN_TAB_PATHS,
  children,
}: WorkspaceTabsProviderProps) {
  const fixedTabs = useMemo(
    () => restoredFixedTabs.map(tab => normalizePersistedTab(tab, labels)),
    [restoredFixedTabs, labels]
  )
  const startupTabApplied = useRef(false)
  const previousPathnameRef = useRef(pathname)
  const [state, dispatch] = useReducer(
    workspaceTabsReducer,
    undefined,
    (): WorkspaceTabsState =>
      loadPersistedTabs(
        storageScope,
        hiddenTabPaths.includes(pathname) ? '/' : pathname,
        hiddenTabPaths.includes(pathname) ? '' : search,
        labels,
        fixedTabs,
        restoreSessionTabs,
        retainedTabPaths
      )
  )
  const stateRef = useRef(state)
  const hiddenPaths = useMemo(() => new Set(hiddenTabPaths), [hiddenTabPaths])
  const visibleTabs = useMemo(
    () => state.tabs.filter(tab => !hiddenPaths.has(tab.contentRoute.split('?', 1)[0])),
    [hiddenPaths, state.tabs]
  )
  const fallbackTab = useMemo(
    () => visibleTabs[0] ?? createWorkspaceTab('task', labels),
    [labels, visibleTabs]
  )
  const activeTab =
    visibleTabs.find(tab => tab.id === state.activeTabId) ?? visibleTabs[0] ?? fallbackTab

  useLayoutEffect(() => {
    if (hiddenPaths.has(pathname)) replaceTo(workspaceTabRoute(activeTab))
    if (state.activeTabId === activeTab.id) return
    dispatch(
      state.tabs.some(tab => tab.id === activeTab.id)
        ? { type: 'select', tabId: activeTab.id }
        : { type: 'open', tab: activeTab }
    )
  }, [activeTab, hiddenPaths, pathname, state.activeTabId, state.tabs])

  useEffect(() => {
    if (!isElectronRuntime() || getDesktopWindowLabel() !== 'main') return
    const receive = (event: StorageEvent) => {
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
        if (!localStorage.getItem(key)) return
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
        if (localStorage.getItem(key)) {
          localStorage.setItem(key, JSON.stringify({ error: String(error) }))
        }
      })
    }
    window.addEventListener('storage', receive)
    return () => window.removeEventListener('storage', receive)
  }, [])

  useLayoutEffect(() => {
    stateRef.current = state
  }, [state])

  const isWorkspaceTabActive = useCallback(
    (tabId: string) => stateRef.current.activeTabId === tabId,
    []
  )

  useEffect(() => {
    dispatch({ type: 'syncFixed', tabs: fixedTabs })
  }, [fixedTabs])

  useLayoutEffect(() => {
    const enteringSettings =
      isSettingsRoute(pathname) && !isSettingsRoute(previousPathnameRef.current)
    if (enteringSettings) {
      const activeTab = stateRef.current.tabs.find(tab => tab.id === stateRef.current.activeTabId)
      if (activeTab) writeSettingsReturnPath(activeTab.contentRoute)
    }
    previousPathnameRef.current = pathname
    if (!hiddenPaths.has(pathname)) {
      dispatch({ type: 'routeChanged', pathname, search, labels })
    }
  }, [hiddenPaths, labels, pathname, search])

  useEffect(() => {
    if (startupTabApplied.current) return
    const location = parseWorkspaceLocation(pathname, search)
    if (pathname !== '/' || location.tabId || location.contentRoute !== '/') {
      startupTabApplied.current = true
      return
    }
    if (!startupTabKind && !startupTabId) return
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
    if (!restoreSessionTabs && !retainedTabPaths.length) return
    try {
      const restorable = sessionRestorableTabs(state.tabs)
      const previous = restoreSessionTabs
        ? null
        : (JSON.parse(
            localStorage.getItem(workspaceTabsStorageKey(storageScope)) ?? 'null'
          ) as PersistedWorkspaceTabs | null)
      const retained = restorable.filter(tab =>
        retainedTabPaths.includes(tab.contentRoute.split('?', 1)[0])
      )
      if (
        !restoreSessionTabs &&
        !retained.length &&
        !previous?.tabs?.some(tab => retainedTabPaths.includes(tab.contentRoute.split('?', 1)[0]))
      )
        return
      const tabs = restoreSessionTabs
        ? restorable
        : [
            ...(previous?.tabs ?? []).filter(
              tab => !retainedTabPaths.includes(tab.contentRoute.split('?', 1)[0])
            ),
            ...retained,
          ]
      const persisted: PersistedWorkspaceTabs = {
        activeTabId: tabs.some(tab => tab.id === state.activeTabId)
          ? state.activeTabId
          : (previous?.activeTabId ?? tabs[0]?.id ?? ''),
        tabs,
      }
      persistWorkspaceTabs(storageScope, persisted.tabs, persisted.activeTabId)
    } catch {
      // Tabs remain usable in memory when persistence is unavailable.
    }
  }, [restoreSessionTabs, retainedTabPaths, state, storageScope])

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
      if (hiddenPaths.has(tab.contentRoute.split('?', 1)[0])) {
        throw new Error('This workspace route is unavailable')
      }
      const existing = isCollaborationExpPath(tab.contentRoute)
        ? stateRef.current.tabs.find(candidate => isCollaborationExpPath(candidate.contentRoute))
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
    [hiddenPaths, labels, selectTab]
  )

  useEffect(() => {
    const onNavigate = (event: Event) => {
      const { kind, contentRoute } = (event as CustomEvent<WorkspaceNavigationDetail>).detail
      const activeTab = stateRef.current.tabs.find(tab => tab.id === stateRef.current.activeTabId)
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
            ...stateRef.current,
            tabs: stateRef.current.tabs.filter(tab => tab.id !== COLLABORATION_EXP_TAB_ID),
            selectTab,
            openTab,
          },
          kind,
          contentRoute
        )
        return
      }
      const target = parseRuntimeTaskRoute(path, search)
      const matching = target ? findRuntimeTaskTab(stateRef.current.tabs, target) : null
      const isTaskSurface = (value: WorkspaceTabKind) => value === 'task' || value === 'auxiliary'
      if (
        activeTab &&
        (!matching || matching.id === activeTab.id) &&
        (activeTab.kind === kind || (isTaskSurface(activeTab.kind) && isTaskSurface(kind)))
      ) {
        return
      }
      event.preventDefault()
      navigateWorkspaceTab({ ...stateRef.current, selectTab, openTab }, kind, contentRoute)
    }
    window.addEventListener(WORKSPACE_NAVIGATION_EVENT, onNavigate)
    return () => window.removeEventListener(WORKSPACE_NAVIGATION_EVENT, onNavigate)
  }, [hiddenPaths, selectTab, openTab])

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

  const detachTab = useCallback(
    (tabId: string) => {
      const currentState = stateRef.current
      if (!currentState.tabs.some(tab => tab.id === tabId)) return
      const fallback = createWorkspaceTab('task', labels)
      const next = closeWorkspaceTab(currentState.tabs, currentState.activeTabId, tabId, fallback)
      flushSync(() => dispatch({ type: 'detach', tabId, fallback }))
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
    [hiddenPaths, state.tabs]
  )

  const moveTab = useCallback((sourceId: string, targetId: string) => {
    dispatch({ type: 'move', sourceId, targetId })
  }, [])

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
  }, [hiddenPaths, state.closedTabs, state.tabs])

  const updateTab = useCallback(
    (tabId: string, updates: Partial<Pick<WorkspaceTab, 'title' | 'contentRoute'>>) => {
      const current = stateRef.current
      const currentTab = current.tabs.find(tab => tab.id === tabId)
      if (!currentTab) return
      const updated = { ...currentTab, ...updates }
      flushSync(() => dispatch({ type: 'update', tabId, updates }))
      if (tabId === current.activeTabId) replaceTo(workspaceTabRoute(updated))
    },
    []
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
      <WorkspaceTabsContext.Provider value={value}>{children}</WorkspaceTabsContext.Provider>
    </WorkspaceTabActivityContext.Provider>
  )
}
