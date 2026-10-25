import { channel } from 'node:diagnostics_channel'
import { errorMonitor } from 'node:events'
import { writeSync } from 'node:fs'

// Observe failures without handling them: an unhandled socket error must still
// terminate the checkpoint, including failures after its business assertions.
export function installSocketDiagnostics() {
  const sockets = new WeakMap()
  const observe = (socket, owner) => {
    if (!socket) return
    const existing = sockets.get(socket)
    if (existing) {
      Object.assign(existing, owner)
      return
    }
    const metadata = { ...owner, createdAt: new Error().stack }
    sockets.set(socket, metadata)
    socket.on(errorMonitor, error => {
      if (socket.listenerCount('error') > 0) return
      const record = {
        ...metadata,
        code: error.code ?? null,
        syscall: error.syscall ?? null,
        localPort: socket.localPort ?? null,
        remotePort: socket.remotePort ?? null,
        readyState: socket.readyState,
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
  subscribe('child_process', ({ process: child }) => {
    child.once('spawn', () => {
      for (const [index, stream] of (child.stdio ?? []).entries()) {
        observe(stream, { owner: 'child.stdio', childPid: child.pid, fd: index })
      }
    })
  })
}
