import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { McpUiDisplayMode } from '@modelcontextprotocol/ext-apps/app-bridge'
import type { ToolBlock } from '@wegent/chat-core/runtime-conversation'
import type { RuntimeMcpAppsApi } from '@/api/mcpApps'
import type { RuntimeTaskAddress } from '@/types/api'
import { McpAppHost } from './McpAppHost'

interface Entry {
  block: ToolBlock
  container: HTMLDivElement
  anchor: HTMLDivElement | null
  overlay: boolean
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
  const parking = useRef<HTMLDivElement>(null)
  const overlays = useRef<HTMLDivElement>(null)
  const entries = useRef(new Map<string, Entry>())
  const [rendered, setRendered] = useState<Entry[]>([])
  const [registry] = useState<Registry>(() => ({
    attach(block, anchor) {
      let entry = entries.current.get(block.id)
      if (!entry) {
        entry = { block, container: document.createElement('div'), anchor, overlay: false }
        entries.current.set(block.id, entry)
        anchor.append(entry.container)
        setRendered([...entries.current.values()])
      } else {
        entry.anchor = anchor
        if (!entry.overlay) moveDocument(anchor, entry.container)
        if (entry.block !== block) {
          entry.block = block
          setRendered([...entries.current.values()])
        }
      }
      const attached = entry
      return () => {
        if (attached.anchor === anchor) attached.anchor = null
        if (!attached.overlay && parking.current?.isConnected && attached.container.isConnected)
          moveDocument(parking.current, attached.container)
      }
    },
  }))
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
            onDisplayModeChange={(mode: McpUiDisplayMode) => {
              entry.overlay = mode !== 'inline'
              const target = entry.overlay ? overlays.current : (entry.anchor ?? parking.current)
              if (target && entry.container.parentElement !== target)
                moveDocument(target, entry.container)
            }}
            onContext={async params => {
              await api.requestMcpApp({
                address,
                callId: entry.block.id,
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
