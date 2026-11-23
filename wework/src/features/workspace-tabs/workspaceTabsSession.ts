import type { ReactNode } from 'react'
import { isSettingsRoute, navigateTo, replaceTo } from '@/lib/navigation'
import { resolveDshRoute } from '@/features/dsh-runtime/dshRoutes'
import { projectSpaceRouteRequestsDefaultProject } from '@/features/todo/projectSpaceRoute'
import {
  COLLABORATION_EXP_TAB_ID,
  isCollaborationExpPath,
} from '@/features/collaboration-exp/collaborationExpFeature'
import {
  closeWorkspaceTab,
  createWorkspaceTab,
  defaultContentRoute,
  inferWorkspaceTabKind,
  moveWorkspaceTab,
  parseWorkspaceLocation,
  persistWorkspaceTabs,
  workspaceTabsStorageKey,
  workspaceTabTitle,
  workspaceTabRoute,
  type WorkspaceTab,
  type WorkspaceTabKind,
  type WorkspaceTabLabels,
} from './workspaceTabs'
import { createWorkspaceTabsStore } from './workspaceTabsStore'
import { writeSettingsReturnPath } from './settingsReturnPath'
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

export interface WorkspaceTabsProviderProps {
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

export function validTab(value: unknown): value is WorkspaceTab {
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

type SessionOptions = Omit<WorkspaceTabsProviderProps, 'children'>

function persistSession(state: WorkspaceTabsState, options: SessionOptions): void {
  const {
    restoreSessionTabs = true,
    retainedTabPaths = EMPTY_HIDDEN_TAB_PATHS,
    storageScope,
  } = options
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
    const activeTabId = tabs.some(tab => tab.id === state.activeTabId)
      ? state.activeTabId
      : (previous?.activeTabId ?? tabs[0]?.id ?? '')
    persistWorkspaceTabs(storageScope, tabs, activeTabId)
  } catch {
    // Tabs remain usable in memory when persistence is unavailable.
  }
}

function projectSession(
  state: WorkspaceTabsState,
  options: SessionOptions,
  previous: SessionOptions | null,
  startupApplied: boolean
) {
  const {
    pathname,
    search,
    labels,
    startupTabId,
    startupTabKind,
    hiddenTabPaths = EMPTY_HIDDEN_TAB_PATHS,
  } = options
  const fixedTabs = (options.fixedTabs ?? EMPTY_FIXED_TABS).map(tab =>
    normalizePersistedTab(tab, labels)
  )
  let next = state
  if (!previous || previous.fixedTabs !== options.fixedTabs || previous.labels !== labels) {
    next = workspaceTabsReducer(next, { type: 'syncFixed', tabs: fixedTabs })
  }
  if (
    (!previous ||
      previous.pathname !== pathname ||
      previous.search !== search ||
      previous.labels !== labels) &&
    !hiddenTabPaths.includes(pathname)
  ) {
    next = workspaceTabsReducer(next, { type: 'routeChanged', pathname, search, labels })
  }
  const visibleTabs = next.tabs.filter(
    tab => !hiddenTabPaths.includes(tab.contentRoute.split('?', 1)[0])
  )
  const activeTab =
    visibleTabs.find(tab => tab.id === next.activeTabId) ??
    visibleTabs[0] ??
    createWorkspaceTab('task', labels)
  if (activeTab.id !== next.activeTabId) {
    next = workspaceTabsReducer(
      next,
      next.tabs.some(tab => tab.id === activeTab.id)
        ? { type: 'select', tabId: activeTab.id }
        : { type: 'open', tab: activeTab }
    )
  }
  let navigationRoute = hiddenTabPaths.includes(pathname) ? workspaceTabRoute(activeTab) : null
  let applied = startupApplied
  if (!applied) {
    const location = parseWorkspaceLocation(pathname, search)
    if (pathname !== '/' || location.tabId || location.contentRoute !== '/') applied = true
    else if (startupTabId || startupTabKind) {
      if (
        !(
          startupTabId &&
          fixedTabs.some(tab => tab.id === startupTabId) &&
          !next.tabs.some(tab => tab.id === startupTabId)
        )
      ) {
        applied = true
        const existing =
          next.tabs.find(tab => tab.id === startupTabId) ??
          next.tabs.find(tab => tab.kind === startupTabKind)
        if (existing?.id !== next.activeTabId) {
          const tab = existing ?? createWorkspaceTab(startupTabKind ?? 'task', labels)
          next = workspaceTabsReducer(
            next,
            existing ? { type: 'select', tabId: tab.id } : { type: 'open', tab }
          )
          navigationRoute = workspaceTabRoute(tab)
        }
      }
    }
  }
  return { state: next, startupApplied: applied, navigationRoute }
}

/** Own configuration, persistence and navigation for one window/account session. */
export function createWorkspaceTabsSession(initial: SessionOptions) {
  let options = initial
  let committedOptions: SessionOptions | null = null
  let startupApplied = false
  const hidden = initial.hiddenTabPaths ?? EMPTY_HIDDEN_TAB_PATHS
  let sessionObservers = 0
  let sessionActive = true
  const sessionListeners = new Set<() => void>()
  let sessionSnapshot: { active: boolean; state: WorkspaceTabsState } | null = null
  const publishSession = () => {
    for (const listener of sessionListeners) listener()
  }
  const store = createWorkspaceTabsStore(
    loadPersistedTabs(
      initial.storageScope,
      hidden.includes(initial.pathname) ? '/' : initial.pathname,
      hidden.includes(initial.pathname) ? '' : initial.search,
      initial.labels,
      (initial.fixedTabs ?? EMPTY_FIXED_TABS).map(tab =>
        normalizePersistedTab(tab, initial.labels)
      ),
      initial.restoreSessionTabs ?? true,
      initial.retainedTabPaths ?? EMPTY_HIDDEN_TAB_PATHS
    ),
    workspaceTabsReducer,
    state => {
      persistSession(state, options)
      publishSession()
    }
  )
  const visibilityObservers = new Set<() => void>()
  let visibilityOwner: object | null = null
  return {
    getSessionSnapshot: () => {
      const state = store.getSnapshot()
      if (
        !sessionSnapshot ||
        sessionSnapshot.state !== state ||
        sessionSnapshot.active !== sessionActive
      )
        sessionSnapshot = { state, active: sessionActive }
      return sessionSnapshot
    },
    subscribeSession: (listener: () => void) => {
      sessionListeners.add(listener)
      return () => {
        sessionListeners.delete(listener)
      }
    },
    observeAvailableTabs: (kinds: readonly WorkspaceTabKind[]) => {
      const owner = {}
      let base: WorkspaceTabsState | null = null
      let configuration: SessionOptions | null = null
      let projected: WorkspaceTabsState
      let snapshot: { tabs: WorkspaceTab[]; activeTabId: string }
      const read = () => {
        const current = store.getSnapshot()
        if (current !== base || configuration !== options) {
          base = current
          configuration = options
          const hiddenPaths = options.hiddenTabPaths ?? EMPTY_HIDDEN_TAB_PATHS
          const tabs = current.tabs.filter(
            tab =>
              kinds.includes(tab.kind) && !hiddenPaths.includes(tab.contentRoute.split('?', 1)[0])
          )
          const active = tabs.find(tab => tab.id === current.activeTabId) ?? tabs[0]
          const fallbackKind =
            kinds.find(kind => kind !== 'auxiliary' && kind !== 'board') ?? kinds[0]
          const selected =
            active ?? (fallbackKind && createWorkspaceTab(fallbackKind, options.labels))
          projected =
            selected && selected.id !== current.activeTabId
              ? workspaceTabsReducer(
                  current,
                  active ? { type: 'select', tabId: selected.id } : { type: 'open', tab: selected }
                )
              : current
          snapshot = {
            tabs: active || !selected ? tabs : [...tabs, selected],
            activeTabId: selected?.id ?? current.activeTabId,
          }
        }
        return { state: projected, snapshot }
      }
      return {
        getSnapshot: () => read().snapshot,
        subscribe: (listener: () => void) => {
          let active = true
          let scheduled = false
          visibilityOwner = owner
          // Reconcile after the originating action has completed its own navigation.
          const reconcile = () => {
            if (scheduled) return
            scheduled = true
            queueMicrotask(() => {
              scheduled = false
              if (!active || visibilityOwner !== owner) return
              const current = store.getSnapshot()
              const next = read().state
              if (next === current) return
              store.replaceState(next)
              const selected = next.tabs.find(tab => tab.id === next.activeTabId)
              if (selected) navigateTo(workspaceTabRoute(selected))
            })
          }
          const changed = () => {
            reconcile()
            listener()
          }
          const unsubscribe = store.subscribe(changed)
          visibilityObservers.add(changed)
          reconcile()
          return () => {
            active = false
            if (visibilityOwner === owner) visibilityOwner = null
            visibilityObservers.delete(changed)
            unsubscribe()
          }
        },
      }
    },
    dispatch: store.dispatch,
    getSnapshot: store.getSnapshot,
    isObserved: store.isObserved,
    observe: (requested: SessionOptions) => {
      let base: WorkspaceTabsState | null = null
      let projection: ReturnType<typeof projectSession> | null = null
      const read = () => {
        const current = store.getSnapshot()
        if (current !== base || !projection) {
          base = current
          projection =
            requested === committedOptions
              ? { state: current, startupApplied, navigationRoute: null }
              : projectSession(current, requested, committedOptions, startupApplied)
        }
        return projection
      }
      return {
        getSnapshot: () => read().state,
        subscribe: (listener: () => void) => {
          sessionObservers += 1
          sessionActive = true
          const projected = read()
          const previous = committedOptions
          const before = store.getSnapshot()
          options = requested
          committedOptions = requested
          startupApplied = projected.startupApplied
          base = projected.state
          projection = { ...projected, navigationRoute: null }
          const unsubscribe = store.subscribe(listener)
          store.replaceState(projected.state)
          visibilityObservers.forEach(listener => listener())
          publishSession()
          if (
            isSettingsRoute(requested.pathname) &&
            previous &&
            !isSettingsRoute(previous.pathname)
          ) {
            const active = before.tabs.find(tab => tab.id === before.activeTabId)
            if (active) writeSettingsReturnPath(active.contentRoute)
          }
          if (before === projected.state) persistSession(projected.state, requested)
          if (projected.navigationRoute) {
            if ((requested.hiddenTabPaths ?? EMPTY_HIDDEN_TAB_PATHS).includes(requested.pathname))
              replaceTo(projected.navigationRoute)
            else navigateTo(projected.navigationRoute)
          }
          return () => {
            unsubscribe()
            sessionObservers -= 1
            if (!sessionObservers) {
              // Same-commit configuration changes keep their original session ownership.
              queueMicrotask(() => {
                if (sessionObservers) return
                sessionActive = false
                publishSession()
              })
            }
          }
        },
      }
    },
  }
}
