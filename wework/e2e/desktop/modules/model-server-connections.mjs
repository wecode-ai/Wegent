export function trackModelServerConnections(server) {
  server.on('connection', socket => {
    // Model clients can disconnect on completion, reload, or process termination.
    // HTTP removes its own error handler before a late peer reset can arrive.
    socket.on('error', error => {
      if (error.code !== 'ECONNRESET') throw error
      socket.destroy()
    })
  })
}
