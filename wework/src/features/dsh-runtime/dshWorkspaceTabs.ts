import type { WorkspaceTab } from '@/features/workspace-tabs/workspaceTabs'
import { getDshSlotEntries, subscribeDshSlot, WEWORK_DSH_SLOTS } from './dshUiSlots'

export const WEWORK_WORKSPACE_TAB_SLOT = 'wework.workspace.tab' as const
const DSH_WORKSPACE_ROUTE_PREFIX = '/dsh/workspace/'
const EMPTY_TABS: readonly WeworkDshWorkspaceTabDescriptor[] = []
let cachedEntries: readonly { id: string; label?: string; order?: number }[] = []
let cachedTabs: readonly WeworkDshWorkspaceTabDescriptor[] = EMPTY_TABS

export interface WeworkDshWorkspaceTabDescriptor {
  id: string
  title: string
  order?: number
}

export interface WeworkDshWorkspaceTabProps {
  tab: WorkspaceTab
  visible: boolean
}

export function dshWorkspaceTabRoute(id: string): string {
  return `${DSH_WORKSPACE_ROUTE_PREFIX}${encodeURIComponent(id)}`
}

export function dshWorkspaceTabIdFromPath(path: string): string | null {
  if (!path.startsWith(DSH_WORKSPACE_ROUTE_PREFIX)) return null
  const encoded = path.slice(DSH_WORKSPACE_ROUTE_PREFIX.length)
  if (!encoded || encoded.includes('/')) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    return null
  }
}

export const dshWorkspaceTabs = {
  getTabs(): readonly WeworkDshWorkspaceTabDescriptor[] {
    const entries = getDshSlotEntries(WEWORK_DSH_SLOTS.workspaceTab)
    if (entries === cachedEntries) return cachedTabs
    cachedEntries = entries
    cachedTabs = entries.map(entry => ({
      id: entry.id,
      title: entry.label ?? entry.id,
      order: entry.order,
    }))
    return cachedTabs
  },
  getTab(id: string): WeworkDshWorkspaceTabDescriptor | undefined {
    return this.getTabs().find(tab => tab.id === id)
  },
  subscribe(listener: () => void): () => void {
    return subscribeDshSlot(WEWORK_DSH_SLOTS.workspaceTab, listener)
  },
}
