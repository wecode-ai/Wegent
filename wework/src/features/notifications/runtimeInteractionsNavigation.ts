import type { WorkspaceTabsContextValue } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { INTERACTIONS_PATH, INTERACTIONS_TAB_ID } from './RuntimeInteractionsContext'

export function openRuntimeInteractionsTab(
  tabs: Pick<WorkspaceTabsContextValue, 'tabs' | 'selectTab' | 'openTab'>,
  title: string,
  contentRoute = INTERACTIONS_PATH
) {
  const canonical = tabs.tabs.find(tab => tab.id === INTERACTIONS_TAB_ID)
  const existing =
    (canonical?.contentRoute.split('?', 1)[0] === INTERACTIONS_PATH ? canonical : null) ??
    tabs.tabs.find(tab => tab.contentRoute.split('?', 1)[0] === INTERACTIONS_PATH) ??
    canonical
  const destination = { title, contentRoute }
  if (existing) tabs.selectTab(existing.id, destination)
  else tabs.openTab('auxiliary', { id: INTERACTIONS_TAB_ID, ...destination })
}
