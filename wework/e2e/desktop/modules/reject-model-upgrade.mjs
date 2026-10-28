export function rejectModelWebSocketUpgrade(server, socket) {
  // Upgraded sockets no longer belong to HTTP's error handling. Codex may reset
  // the rejected connection while switching to the model fixture's HTTP transport.
  let closingForFallback = false
  socket.on('error', error => {
    const peerDisconnected = ['ECONNRESET', 'EPIPE'].includes(error.code)
    socket.destroy()
    if (!(closingForFallback && peerDisconnected)) server.emit('error', error)
  })
  closingForFallback = true
  socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
}
