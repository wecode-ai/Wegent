import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { useWorkbenchPaneId } from '@/components/layout/workbenchPanePresentation'
import type { RuntimeTaskAddress } from '@/types/api'

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

export function useMcpAppWorkspacePanels({
  address,
  openTab,
  closeTab,
}: {
  address: RuntimeTaskAddress | null | undefined
  openTab: (tab: McpAppPanelTab) => void
  closeTab: (tab: McpAppPanelTab) => void
}) {
  const available = useMcpAppPanels(address)
  const previous = useRef(new Set<McpAppPanelTab>())
  useEffect(() => {
    const current = new Set(available.map(panel => panel.id))
    for (const id of previous.current) if (!current.has(id)) closeTab(id)
    for (const id of current) if (!previous.current.has(id)) openTab(id)
    previous.current = current
  }, [available, openTab, closeTab])
}
