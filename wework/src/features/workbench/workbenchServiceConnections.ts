import { useEffect } from 'react'
import type { WorkbenchServices } from './workbenchServices'

interface Connection {
  dispose(): void
  ensureConnected?: () => Promise<unknown>
}

interface Ownership {
  references: number
}

const connections = new WeakMap<Connection, Ownership>()

function retainConnection(connection: Connection | undefined): () => void {
  if (!connection) return () => undefined
  let ownership = connections.get(connection)
  if (!ownership) {
    ownership = { references: 0 }
    connections.set(connection, ownership)
    const current = ownership
    void connection.ensureConnected?.().catch(error => {
      if (current.references > 0) console.error('[Workbench] Failed to connect chat socket', error)
    })
  }
  ownership.references += 1
  const current = ownership
  let released = false
  return () => {
    if (released) return
    released = true
    current.references -= 1
    // React may replay effects or transfer active workspace ownership in one commit.
    queueMicrotask(() => {
      if (current.references || connections.get(connection) !== current) return
      connections.delete(connection)
      connection.dispose()
    })
  }
}

export function retainWorkbenchServiceConnections(
  services: Pick<WorkbenchServices, 'socketClient' | 'projectChatClient'>
): () => void {
  const releaseSocket = retainConnection(services.socketClient)
  const releaseProjectChat = retainConnection(services.projectChatClient)
  return () => {
    releaseSocket()
    releaseProjectChat()
  }
}

export function useWorkbenchServiceConnections(
  services: Pick<WorkbenchServices, 'socketClient' | 'projectChatClient'>
): void {
  const { socketClient, projectChatClient } = services
  useEffect(
    () => retainWorkbenchServiceConnections({ socketClient, projectChatClient }),
    [socketClient, projectChatClient]
  )
}
