import { parseRuntimeTaskRoute, type RuntimeTaskRoute } from '@/lib/navigation'
import type { WorkspaceTabsContextValue } from './workspaceTabsContextValue'
import type { WorkspaceTab, WorkspaceTabKind } from './workspaceTabs'

function comparableRoute(route: string): string {
  const [path, search] = route.split('?')
  const params = new URLSearchParams(search)
  params.delete('focusRequest')
  return `${path}${params.size ? `?${params}` : ''}`
}

export function findRuntimeTaskTab(tabs: readonly WorkspaceTab[], target: RuntimeTaskRoute) {
  return tabs.find(tab => {
    if (tab.kind !== 'task') return false
    const [path, search] = tab.contentRoute.split('?')
    const task = parseRuntimeTaskRoute(path, search)
    return task?.deviceId === target.deviceId && task.taskId === target.taskId
  })
}

export function navigateWorkspaceTab(
  tabs: Pick<WorkspaceTabsContextValue, 'tabs' | 'activeTabId' | 'selectTab' | 'openTab'>,
  kind: WorkspaceTabKind,
  contentRoute: string
) {
  const [pathname, search] = contentRoute.split('?')
  const target = parseRuntimeTaskRoute(pathname, search)
  const candidates = tabs.tabs.filter(tab => tab.kind === kind)
  const matching = target
    ? findRuntimeTaskTab(candidates, target)
    : candidates.find(tab => comparableRoute(tab.contentRoute) === comparableRoute(contentRoute))
  const existing =
    matching ??
    candidates.find(tab => tab.id === tabs.activeTabId) ??
    candidates.find(tab => tab.fixed) ??
    candidates[0]
  if (existing) tabs.selectTab(existing.id, { contentRoute })
  else tabs.openTab(kind, { contentRoute })
}
