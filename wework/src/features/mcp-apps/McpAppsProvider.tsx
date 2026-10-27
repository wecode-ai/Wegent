import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ToolBlock } from '@wegent/chat-core/runtime-conversation'
import type { RuntimeMcpAppsApi } from '@/api/mcpApps'
import type { RuntimeTaskAddress } from '@/types/api'
import { McpAppHost } from './McpAppHost'

interface Entry {
  block: ToolBlock
  container: HTMLDivElement
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
  const entries = useRef(new Map<string, Entry>())
  const [rendered, setRendered] = useState<Entry[]>([])
  const [registry] = useState<Registry>(() => ({
    attach(block, anchor) {
      let entry = entries.current.get(block.id)
      if (!entry) {
        entry = { block, container: document.createElement('div') }
        entries.current.set(block.id, entry)
        anchor.append(entry.container)
        setRendered([...entries.current.values()])
      } else {
        moveDocument(anchor, entry.container)
        if (entry.block !== block) {
          entry.block = block
          setRendered([...entries.current.values()])
        }
      }
      const container = entry.container
      return () => {
        if (parking.current?.isConnected && container.isConnected)
          moveDocument(parking.current, container)
      }
    },
  }))
  return (
    <Context.Provider value={registry}>
      {children}
      <div ref={parking} hidden data-testid="mcp-app-parking" />
      {rendered.map(entry =>
        createPortal(
          <McpAppHost
            block={entry.block}
            address={address}
            api={api}
            onMessage={onMessage}
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
