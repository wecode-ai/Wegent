export function rejectModelWebSocketUpgrade(server, socket) {
  // Upgraded sockets no longer belong to HTTP's error handling. Codex may reset
  // the rejected connection while switching to the model fixture's HTTP transport.
  socket.on('error', error => {
    socket.destroy()
    if (error.code !== 'ECONNRESET') server.emit('error', error)
  })
  socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
}
