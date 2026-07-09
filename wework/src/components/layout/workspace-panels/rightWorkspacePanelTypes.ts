export type RightWorkspaceChatTab = `chat:${string}`
export type RightWorkspacePanelTab =
  | 'review'
  | 'terminal'
  | 'browser'
  | 'files'
  | 'plan'
  | RightWorkspaceChatTab
export type RightWorkspacePanelView = 'launcher' | RightWorkspacePanelTab

export function isRightWorkspaceChatTab(
  tab: RightWorkspacePanelView
): tab is RightWorkspaceChatTab {
  return tab.startsWith('chat:')
}

export function getRightWorkspaceChatTabSuffix(tab: RightWorkspaceChatTab) {
  return tab.slice('chat:'.length)
}
