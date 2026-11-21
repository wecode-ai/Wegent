import { WebSocketServer, WebSocket } from 'ws'

/** Event delivery uses an upgraded socket, leaving the browser HTTP pool for commands. */
export function registerHostEventStream(ctx, security, client, path) {
  const server = new WebSocketServer({ noServer: true, maxPayload: 1024 })
  const unregister = ctx.webServer.registerUpgrade({
    path,
    handler: security.wrapUpgrade((req, socket, head) => {
      server.handleUpgrade(req, socket, head, connection => {
        const cursor = Number(new URL(req.url, 'http://localhost').searchParams.get('after') ?? 0)
        if (!Number.isSafeInteger(cursor) || cursor < 0) {
          connection.close(1008, 'Invalid event cursor')
          return
        }
        connection.on('error', () => connection.terminate())
        void deliver(connection, client, cursor).catch(() => connection.terminate())
      })
    }),
  })
  return () => {
    unregister()
    for (const connection of server.clients) connection.terminate()
    server.close()
  }
}

async function deliver(connection, client, cursor) {
  while (connection.readyState === WebSocket.OPEN) {
    const batch = await client.invoke('desktop.events', { after: cursor, wait: true })
    if (connection.readyState !== WebSocket.OPEN) return
    await new Promise((resolve, reject) => {
      connection.send(JSON.stringify(batch), error => (error ? reject(error) : resolve()))
    })
    cursor = batch.latestSequence
    if (batch.historyLost) {
      connection.close(1008, 'Event history lost')
      return
    }
  }
}
