export type WorkspaceTabKind = 'task' | 'board' | 'agent' | 'auxiliary'

export interface WorkspaceTab {
  id: string
  kind: WorkspaceTabKind
  title: string
  contentRoute: string
}

export interface WorkspaceTabLabels {
  task: string
  board: string
  agent: string
  auxiliary: string
}

const WORKSPACE_TAB_PARAM = 'workspaceTab'
const WORKSPACE_TAB_TITLE_PARAM = 'workspaceTabTitle'

function newTabId(kind: WorkspaceTabKind): string {
  return `${kind}-${crypto.randomUUID()}`
}

export function defaultContentRoute(kind: WorkspaceTabKind): string {
  switch (kind) {
    case 'board':
      return '/todo'
    case 'agent':
      return '/app/wegent'
    case 'auxiliary':
      return '/'
    default:
      return '/'
  }
}

export function inferWorkspaceTabKind(pathname: string): WorkspaceTabKind {
  if (pathname === '/todo') return 'board'
  if (pathname === '/app/wegent') return 'agent'
  if (
    pathname === '/' ||
    pathname === '/runtime-tasks' ||
    pathname === '/settings' ||
    pathname.startsWith('/settings/')
  ) {
    return 'task'
  }
  return 'auxiliary'
}

export function workspaceTabTitle(
  kind: WorkspaceTabKind,
  contentRoute: string,
  labels: WorkspaceTabLabels
): string {
  const searchIndex = contentRoute.indexOf('?')
  const pathname = searchIndex >= 0 ? contentRoute.slice(0, searchIndex) : contentRoute
  if (kind !== 'auxiliary') return labels[kind]
  if (pathname === '/plugins') return 'Plugins'
  if (pathname === '/sites') return 'Sites'
  if (pathname === '/automations') return 'Automations'
  if (pathname === '/cloud-work') return 'Cloud'
  if (pathname === '/apps') return 'Apps'
  return labels.auxiliary
}

export function createWorkspaceTab(
  kind: WorkspaceTabKind,
  labels: WorkspaceTabLabels,
  overrides: Partial<WorkspaceTab> = {}
): WorkspaceTab {
  const contentRoute = overrides.contentRoute ?? defaultContentRoute(kind)
  return {
    id: overrides.id ?? newTabId(kind),
    kind,
    title: overrides.title ?? workspaceTabTitle(kind, contentRoute, labels),
    contentRoute,
  }
}

export function parseWorkspaceLocation(pathname: string, search: string) {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const tabId = params.get(WORKSPACE_TAB_PARAM)
  const tabTitle = params.get(WORKSPACE_TAB_TITLE_PARAM)
  params.delete(WORKSPACE_TAB_PARAM)
  params.delete(WORKSPACE_TAB_TITLE_PARAM)
  const query = params.toString()
  return {
    contentRoute: `${pathname}${query ? `?${query}` : ''}`,
    tabId: tabId?.trim() || null,
    tabTitle: tabTitle?.trim() || null,
  }
}

export function workspaceTabRoute(tab: WorkspaceTab): string {
  const separator = tab.contentRoute.includes('?') ? '&' : '?'
  const params = new URLSearchParams()
  params.set(WORKSPACE_TAB_PARAM, tab.id)
  params.set(WORKSPACE_TAB_TITLE_PARAM, tab.title)
  return `${tab.contentRoute}${separator}${params.toString()}`
}

export function moveWorkspaceTab(
  tabs: WorkspaceTab[],
  sourceId: string,
  targetId: string
): WorkspaceTab[] {
  const sourceIndex = tabs.findIndex(tab => tab.id === sourceId)
  const targetIndex = tabs.findIndex(tab => tab.id === targetId)
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return tabs
  const next = [...tabs]
  const [source] = next.splice(sourceIndex, 1)
  next.splice(targetIndex, 0, source)
  return next
}

export function closeWorkspaceTab(
  tabs: WorkspaceTab[],
  activeTabId: string,
  closingTabId: string,
  fallback: WorkspaceTab
): { tabs: WorkspaceTab[]; activeTabId: string } {
  const closingIndex = tabs.findIndex(tab => tab.id === closingTabId)
  if (closingIndex < 0) return { tabs, activeTabId }
  const remaining = tabs.filter(tab => tab.id !== closingTabId)
  if (remaining.length === 0) return { tabs: [fallback], activeTabId: fallback.id }
  if (activeTabId !== closingTabId) return { tabs: remaining, activeTabId }
  const nextActive = remaining[Math.min(closingIndex, remaining.length - 1)]
  return { tabs: remaining, activeTabId: nextActive.id }
}

export const workspaceTabParams = {
  id: WORKSPACE_TAB_PARAM,
  title: WORKSPACE_TAB_TITLE_PARAM,
}
