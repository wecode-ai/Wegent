import { createContext, useContext } from 'react'
import type { WorkspaceTab, WorkspaceTabKind } from './workspaceTabs'

export interface WorkspaceTabsContextValue {
  tabs: WorkspaceTab[]
  activeTabId: string
  activeTab: WorkspaceTab
  openTab: (kind: WorkspaceTabKind, overrides?: Partial<WorkspaceTab>) => WorkspaceTab
  selectTab: (
    tabId: string,
    updates?: Partial<Pick<WorkspaceTab, 'title' | 'contentRoute'>>
  ) => void
  closeTab: (tabId: string) => void
  closeOtherTabs: (tabId: string) => void
  restoreClosedTab: () => void
  moveTab: (sourceId: string, targetId: string) => void
  updateActiveTab: (updates: Partial<Pick<WorkspaceTab, 'title' | 'contentRoute'>>) => void
}

export const WorkspaceTabsContext = createContext<WorkspaceTabsContextValue | null>(null)

export function useWorkspaceTabs(): WorkspaceTabsContextValue {
  const context = useContext(WorkspaceTabsContext)
  if (!context) throw new Error('useWorkspaceTabs must be used inside WorkspaceTabsProvider')
  return context
}

export function useOptionalWorkspaceTabs(): WorkspaceTabsContextValue | null {
  return useContext(WorkspaceTabsContext)
}
