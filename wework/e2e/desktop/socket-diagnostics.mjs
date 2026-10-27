import { channel } from 'node:diagnostics_channel'
import { errorMonitor } from 'node:events'
import { writeSync } from 'node:fs'

// Observe failures without handling them: an unhandled socket error must still
// terminate the checkpoint, including failures after its business assertions.
export function installSocketDiagnostics() {
  const sockets = new WeakMap()
  const servers = new WeakMap()
  let phase = 'setup'
  const observe = (socket, owner) => {
    if (!socket) return
    const existing = sockets.get(socket)
    if (existing) {
      Object.assign(existing, owner)
      return
    }
    const metadata = { ...owner, createdAt: new Error().stack }
    const captureEndpoints = () => {
      metadata.localPort = socket.localPort ?? null
      metadata.remotePort = socket.remotePort ?? null
    }
    captureEndpoints()
    socket.on('connect', captureEndpoints)
    sockets.set(socket, metadata)
    socket.on(errorMonitor, error => {
      if (socket.listenerCount('error') > 0) return
      const record = {
        ...metadata,
        code: error.code ?? null,
        syscall: error.syscall ?? null,
        readyState: socket.readyState,
        phase,
      }
      try {
        writeSync(2, `[desktop-e2e] Unhandled socket error ${JSON.stringify(record)}\n`)
      } catch {
        // A diagnostic write must not replace the original fatal socket error.
      }
    })
  }
  const subscribe = (name, callback) => {
    channel(name).subscribe(callback)
  }
  subscribe('net.client.socket', ({ socket }) => observe(socket, { owner: 'net.client' }))
  subscribe('net.server.socket', ({ socket }) => observe(socket, { owner: 'net.server' }))
  subscribe('tracing:net.server.listen:asyncStart', ({ server }) => {
    let metadata = servers.get(server)
    if (!metadata) {
      metadata = {}
      servers.set(server, metadata)
      server.prependListener('connection', socket => {
        observe(socket, { owner: 'net.server', ...metadata })
      })
    }
    metadata.serverListenStack = new Error().stack
  })
  subscribe('child_process', ({ process: child }) => {
    child.once('spawn', () => {
      for (const [index, stream] of (child.stdio ?? []).entries()) {
        observe(stream, { owner: 'child.stdio', childPid: child.pid, fd: index })
      }
    })
  })
  return nextPhase => {
    phase = nextPhase
  }
}
