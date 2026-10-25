export function trackModelServerConnections(server) {
  const sockets = new Set()
  let shuttingDown = false
  const ownShutdownErrors = socket => {
    socket.on('error', error => {
      if (error.code !== 'ECONNRESET') throw error
      socket.destroy()
    })
  }
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    if (shuttingDown) ownShutdownErrors(socket)
  })
  return () => {
    if (shuttingDown) return
    shuttingDown = true
    // Killing Electron can reset model connections after HTTP removes its handlers.
    // Keep ownership until the socket itself is collected, including late errors.
    for (const socket of sockets) ownShutdownErrors(socket)
  }
}
