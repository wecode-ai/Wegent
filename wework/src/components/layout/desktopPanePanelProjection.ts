import {
  reconcileQuestionDiscussionPanels,
  type QuestionDiscussionPanelSnapshot,
} from '@/features/notifications/questionDiscussionPanels'
import {
  reconcileMcpAppWorkspacePanels,
  type McpAppPanel,
} from '@/features/mcp-apps/workspacePanels'
import type { DesktopPaneWorkspaceSnapshot } from './desktopPaneWorkspaceState'
export interface DesktopPanePanelProjectionInput {
  questionPanels: QuestionDiscussionPanelSnapshot
  mcpAppPanels: readonly McpAppPanel[]
}
export function projectDesktopPanePanels(
  state: DesktopPaneWorkspaceSnapshot,
  previous: DesktopPanePanelProjectionInput | null,
  next: DesktopPanePanelProjectionInput
): DesktopPaneWorkspaceSnapshot {
  if (
    previous?.questionPanels === next.questionPanels &&
    previous?.mcpAppPanels === next.mcpAppPanels
  )
    return state
  const discussion = reconcileQuestionDiscussionPanels(
    previous?.questionPanels ?? null,
    next.questionPanels,
    state.rightPanelTabs,
    state.rightPanelView
  )
  const mcp = reconcileMcpAppWorkspacePanels(
    previous?.mcpAppPanels ?? [],
    next.mcpAppPanels,
    discussion.tabs,
    discussion.view
  )
  return {
    ...state,
    rightPanelTabs: mcp.tabs,
    rightPanelView: mcp.view,
    rightPanelOpen:
      discussion.opened || mcp.opened
        ? true
        : (discussion.emptied || mcp.emptied) && !mcp.tabs.length
          ? false
          : state.rightPanelOpen,
    rightPanelExpanded: discussion.collapsed || mcp.collapsed ? false : state.rightPanelExpanded,
  }
}
