import {
  buildIssueMentionRoute,
  issueMentionProjectStore,
  type IssueMentionAddress,
} from '@/lib/issue-mentions'
import type { WorkspaceTabsContextValue } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { projectSpaceRouteParam } from './projectSpaceRoute'

/** Opens an Issue reference in the matching board tab without losing the
 * existing project-space tab when one is available. */
export function openIssueReference({
  issue,
  label,
  activeRoute,
  workspaceTabs,
  navigate,
}: {
  issue: IssueMentionAddress
  label?: string
  activeRoute: string
  workspaceTabs: WorkspaceTabsContextValue | null
  navigate: (route: string) => void
}): void {
  const matchingRoute = [
    activeRoute,
    ...(workspaceTabs?.tabs.map(tab => tab.contentRoute) ?? []),
  ].find(route => projectSpaceRouteParam(route, 'projectId') === issue.projectId)
  const projectStore = issueMentionProjectStore(issue, matchingRoute ?? activeRoute)
  const contentRoute = buildIssueMentionRoute(issue, projectStore)
  if (!workspaceTabs) {
    navigate(contentRoute)
    return
  }

  const existingBoardTab = workspaceTabs.tabs.find(
    tab =>
      tab.kind === 'board' &&
      !tab.fixed &&
      projectSpaceRouteParam(tab.contentRoute, 'projectStore') === projectStore &&
      projectSpaceRouteParam(tab.contentRoute, 'projectId') === issue.projectId
  )
  if (existingBoardTab) {
    workspaceTabs.selectTab(existingBoardTab.id, {
      title: label?.trim() || existingBoardTab.title,
      contentRoute,
    })
    return
  }

  workspaceTabs.openTab('board', {
    title: label?.trim() || issue.issueId,
    contentRoute,
  })
}
