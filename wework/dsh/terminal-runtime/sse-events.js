export function streamTerminalEvents(req, res, runtime, after) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
  })
  let dispose = () => {}
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    dispose()
  }
  const write = event => {
    if (closed || res.destroyed || res.writableEnded) return
    try {
      res.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`)
    } catch {
      close()
    }
  }
  for (const event of runtime.replay(after)) write(event)
  if (closed || res.destroyed || res.writableEnded) return
  dispose = runtime.listen(write)
  req.once('aborted', close)
  req.once('close', close)
  res.once('close', close)
  res.once('error', close)
  res.write(': connected\n\n')
}
