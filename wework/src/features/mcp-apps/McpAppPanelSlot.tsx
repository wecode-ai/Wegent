import { useLayoutEffect, useRef } from 'react'
import type { McpAppPanel } from './workspacePanels'

export function McpAppPanelSlot({ panel }: { panel: McpAppPanel }) {
  const anchor = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => (anchor.current ? panel.attach(anchor.current) : undefined), [panel])
  return (
    <div
      ref={anchor}
      data-testid="mcp-app-workspace-panel"
      className="flex min-h-0 flex-1 flex-col"
    />
  )
}
