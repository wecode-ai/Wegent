import { once } from 'node:events'

/** Attach only to the fresh child paused by this driver's --inspect-brk argument. */
export async function inspectBeforeStart(child, expression) {
  const socketUrl = await new Promise((accept, reject) => {
    let output = ''
    const timer = setTimeout(
      () => finish(new Error('The isolated app inspector did not start')),
      10_000
    )
    const failed = () => finish(new Error('The isolated app exited before its inspector started'))
    const received = chunk => {
      output = (output + chunk.toString()).slice(-8192)
      const match = output.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[a-f0-9-]+)/)
      if (match) finish(null, match[1])
    }
    function finish(error, url) {
      clearTimeout(timer)
      child.stderr.off('data', received)
      child.off('exit', failed)
      child.off('error', finish)
      if (error) reject(error)
      else accept(url)
    }
    child.stderr.on('data', received)
    child.once('exit', failed)
    child.once('error', finish)
  })
  const socket = new WebSocket(socketUrl)
  try {
    await once(socket, 'open', { signal: AbortSignal.timeout(10_000) })
    let id = 0
    async function command(method, params = {}) {
      const requestId = ++id
      const response = new Promise((accept, reject) => {
        const timer = setTimeout(
          () => finish(new Error(`Inspector command timed out: ${method}`)),
          10_000
        )
        const received = event => {
          const message = JSON.parse(event.data)
          if (message.id !== requestId) return
          finish(message.error && new Error(message.error.message), message.result)
        }
        function finish(error, result) {
          clearTimeout(timer)
          socket.removeEventListener('message', received)
          if (error) reject(error)
          else accept(result)
        }
        socket.addEventListener('message', received)
      })
      socket.send(JSON.stringify({ id: requestId, method, params }))
      return response
    }
    await command('Runtime.enable')
    await command('Debugger.enable')
    const paused = new Promise((accept, reject) => {
      const timer = setTimeout(
        () => finish(new Error('The isolated app did not pause at entry')),
        10_000
      )
      const received = event => {
        if (JSON.parse(event.data).method === 'Debugger.paused') finish()
      }
      function finish(error) {
        clearTimeout(timer)
        socket.removeEventListener('message', received)
        if (error) reject(error)
        else accept()
      }
      socket.addEventListener('message', received)
    })
    await command('Runtime.runIfWaitingForDebugger')
    await paused
    const result = await command('Runtime.evaluate', { expression, returnByValue: true })
    if (result.exceptionDetails)
      throw new Error(`Inspector setup failed: ${result.exceptionDetails.text}`)
    await command('Debugger.resume')
  } finally {
    socket.close()
  }
}
