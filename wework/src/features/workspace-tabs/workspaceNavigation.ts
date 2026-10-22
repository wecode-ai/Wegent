import { parseRuntimeTaskRoute } from '@/lib/navigation'
import type { WorkspaceTabsContextValue } from './workspaceTabsContextValue'
import type { WorkspaceTabKind } from './workspaceTabs'

function comparableRoute(route: string): string {
  const [path, search] = route.split('?')
  const params = new URLSearchParams(search)
  params.delete('focusRequest')
  return `${path}${params.size ? `?${params}` : ''}`
}

export function navigateWorkspaceTab(
  tabs: Pick<WorkspaceTabsContextValue, 'tabs' | 'activeTabId' | 'selectTab' | 'openTab'>,
  kind: WorkspaceTabKind,
  contentRoute: string
) {
  const [pathname, search] = contentRoute.split('?')
  const target = parseRuntimeTaskRoute(pathname, search)
  const candidates = tabs.tabs.filter(tab => tab.kind === kind)
  const matching = candidates.find(tab => {
    if (!target) return comparableRoute(tab.contentRoute) === comparableRoute(contentRoute)
    const [tabPath, tabSearch] = tab.contentRoute.split('?')
    const task = parseRuntimeTaskRoute(tabPath, tabSearch)
    return task?.deviceId === target.deviceId && task.taskId === target.taskId
  })
  const existing =
    matching ??
    candidates.find(tab => tab.id === tabs.activeTabId) ??
    candidates.find(tab => tab.fixed) ??
    candidates[0]
  if (existing) tabs.selectTab(existing.id, { contentRoute })
  else tabs.openTab(kind, { contentRoute })
}
