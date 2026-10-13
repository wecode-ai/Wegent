export function streamTerminalEvents(req, res, runtime, after, onLifecycle = () => {}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
  })
  onLifecycle('opened')
  let dispose = () => {}
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    dispose()
    onLifecycle('closed')
  }
  const write = event => {
    if (closed) return
    if (res.destroyed || res.writableEnded) {
      close()
      return
    }
    try {
      res.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`)
    } catch {
      close()
    }
  }
  for (const event of runtime.replay(after)) write(event)
  if (closed || res.destroyed || res.writableEnded) {
    close()
    return
  }
  dispose = runtime.listen(write)
  req.once('aborted', close)
  res.once('finish', close)
  res.once('close', close)
  res.once('error', close)
  res.write(': connected\n\n')
}
