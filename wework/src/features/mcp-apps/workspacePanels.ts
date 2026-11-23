import { useMemo, useSyncExternalStore } from 'react'
import { useWorkbenchPaneId } from '@/components/layout/workbenchPanePresentation'
import type { RuntimeTaskAddress } from '@/types/api'
import { track } from '@/telemetry/client'

export type McpAppPanelTab = `mcp-app:${string}`
export interface McpAppPanel {
  id: McpAppPanelTab
  address: RuntimeTaskAddress
  paneId: string
  title: string
  attach: (anchor: HTMLDivElement) => () => void
  dismiss: () => void
}

const panels = new Map<McpAppPanelTab, McpAppPanel>()
const listeners = new Set<() => void>()
let snapshot: readonly McpAppPanel[] = []
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const getSnapshot = () => snapshot
function notify() {
  snapshot = [...panels.values()]
  for (const listener of [...listeners]) listener()
}

export function isMcpAppPanelTab(tab: string): tab is McpAppPanelTab {
  return tab.startsWith('mcp-app:')
}

export function getMcpAppPanel(tab: McpAppPanelTab) {
  return panels.get(tab)
}

export function registerMcpAppPanel(panel: McpAppPanel) {
  panels.set(panel.id, panel)
  notify()
  return () => {
    if (panels.get(panel.id) !== panel) return
    panels.delete(panel.id)
    track('workspace_panel_removed', { panel: 'other' })
    notify()
  }
}

export function useMcpAppPanels(address: RuntimeTaskAddress | null | undefined) {
  const paneId = useWorkbenchPaneId()
  const current = useSyncExternalStore(subscribe, getSnapshot)
  return useMemo(
    () =>
      current.filter(
        panel =>
          panel.paneId === paneId &&
          panel.address.deviceId === address?.deviceId &&
          panel.address.taskId === address?.taskId
      ),
    [current, paneId, address?.deviceId, address?.taskId]
  )
}

export function reconcileMcpAppWorkspacePanels<Tab extends string>(
  previous: readonly McpAppPanel[],
  current: readonly McpAppPanel[],
  tabs: readonly Tab[],
  selected: Tab | 'launcher'
) {
  const currentIds = new Set(current.map(panel => panel.id))
  const previousIds = new Set(previous.map(panel => panel.id))
  const removed = new Set(
    previous.filter(panel => !currentIds.has(panel.id)).map(panel => panel.id)
  )
  const added = current.filter(panel => !previousIds.has(panel.id)).map(panel => panel.id)
  const retainedTabs = tabs.filter(tab => !removed.has(tab as McpAppPanelTab))
  const nextTabs: (Tab | McpAppPanelTab)[] = [...retainedTabs]
  for (const id of added) if (!nextTabs.includes(id)) nextTabs.push(id)
  const lastAdded = added[added.length - 1]
  const collapsed = removed.size > 0 && retainedTabs.length === 0
  const view =
    lastAdded ??
    (collapsed
      ? 'launcher'
      : removed.has(selected as McpAppPanelTab)
        ? (nextTabs[nextTabs.length - 1] ?? 'launcher')
        : selected)
  return {
    tabs: nextTabs,
    view,
    opened: added.length > 0,
    collapsed,
    emptied: removed.size > 0 && nextTabs.length === 0,
  }
}
