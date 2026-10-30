import { useWorkbenchPaneId } from '@/components/layout/workbenchPanePresentation'
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { McpUiDisplayMode } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { ToolBlock } from '@wegent/chat-core/runtime-conversation'
import type { RuntimeMcpAppsApi } from '@/api/mcpApps'
import type { RuntimeTaskAddress } from '@/types/api'
import { McpAppHost } from './McpAppHost'
import { registerMcpAppPanel } from './workspacePanels'

interface Entry {
  block: ToolBlock
  container: HTMLDivElement
  anchor: HTMLDivElement | null
  mode: McpUiDisplayMode
  dismiss?: () => void
  removePanel?: () => void
}
interface Registry {
  attach: (block: ToolBlock, anchor: HTMLDivElement) => () => void
}
const Context = createContext<Registry | null>(null)

/** Keep browsing contexts alive when a virtualized tool row leaves the viewport. */
export function McpAppsProvider({
  children,
  address,
  api,
  onMessage,
}: {
  children: ReactNode
  address: RuntimeTaskAddress
  api: RuntimeMcpAppsApi
  onMessage?: (text: string) => Promise<void>
}) {
  const paneId = useWorkbenchPaneId()
  const parking = useRef<HTMLDivElement>(null)
  const overlays = useRef<HTMLDivElement>(null)
  const entries = useRef(new Map<string, Entry>())
  const [rendered, setRendered] = useState<Entry[]>([])
  const [registry] = useState<Registry>(() => ({
    attach(block, anchor) {
      let entry = entries.current.get(block.id)
      if (!entry) {
        entry = { block, container: document.createElement('div'), anchor, mode: 'inline' }
        entries.current.set(block.id, entry)
        entry.container.className = 'flex min-h-0 flex-1 flex-col'
        anchor.append(entry.container)
        setRendered([...entries.current.values()])
      } else {
        entry.anchor = anchor
        if (entry.mode === 'inline') moveDocument(anchor, entry.container)
        if (entry.block !== block) {
          entry.block = block
          setRendered([...entries.current.values()])
        }
      }
      const attached = entry
      return () => {
        if (attached.anchor === anchor) attached.anchor = null
        if (
          attached.mode === 'inline' &&
          parking.current?.isConnected &&
          attached.container.isConnected
        )
          moveDocument(parking.current, attached.container)
      }
    },
  }))
  useLayoutEffect(
    () => () => {
      for (const entry of entries.current.values()) entry.removePanel?.()
    },
    []
  )
  return (
    <Context.Provider value={registry}>
      {children}
      <div ref={parking} hidden data-testid="mcp-app-parking" />
      {createPortal(<div ref={overlays} data-testid="mcp-app-overlays" />, document.body)}
      {rendered.map(entry =>
        createPortal(
          <McpAppHost
            block={entry.block}
            address={address}
            api={api}
            onMessage={onMessage}
            onDisplayModeChange={(mode: McpUiDisplayMode, dismiss) => {
              entry.dismiss = dismiss
              if (entry.mode === mode) return
              entry.removePanel?.()
              entry.removePanel = undefined
              entry.mode = mode
              if (mode === 'fullscreen') {
                entry.removePanel = registerMcpAppPanel({
                  id: `mcp-app:${encodeURIComponent(JSON.stringify([paneId, address.deviceId, address.taskId, entry.block.id]))}`,
                  address,
                  paneId,
                  title: entry.block.mcpServer ?? entry.block.toolName,
                  dismiss: () => entry.dismiss?.(),
                  attach: anchor => {
                    moveDocument(anchor, entry.container)
                    return () => {
                      if (entry.container.parentElement === anchor && parking.current)
                        moveDocument(parking.current, entry.container)
                    }
                  },
                })
              }
              const target =
                mode === 'pip'
                  ? overlays.current
                  : mode === 'inline'
                    ? (entry.anchor ?? parking.current)
                    : parking.current
              if (target && entry.container.parentElement !== target)
                moveDocument(target, entry.container)
            }}
            onContext={async (params, sessionId) => {
              await api.requestMcpApp({
                address,
                callId: entry.block.id,
                sessionId,
                method: 'ui/update-model-context',
                params,
              })
            }}
          />,
          entry.container,
          entry.block.id
        )
      )}
    </Context.Provider>
  )
}

function moveDocument(parent: HTMLElement, child: HTMLElement): void {
  // Task removal can detach both portal roots before nested layout effects finish.
  // Only live documents need state-preserving relocation; detached ones are tearing down.
  if (!parent.isConnected || !child.isConnected) return
  // Electron's state-preserving DOM move retains iframe sessions and in-flight RPCs.
  parent.moveBefore(child, null)
}

export function McpAppSlot({ block }: { block: ToolBlock }) {
  const registry = useContext(Context)
  const anchor = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (anchor.current && registry) return registry.attach(block, anchor.current)
  }, [block, registry])
  return <div ref={anchor} data-testid="mcp-app-slot" />
}
