import { once } from 'node:events'

/** Read the connected host identity through the native snapshot shipped by historical packages. */
export async function readConnectedApplicationPid(control) {
  const { applicationPid } = JSON.parse(
    await control.command('getProcessExplorerWindowSnapshot', 'body')
  )
  if (!Number.isSafeInteger(applicationPid) || applicationPid <= 0)
    throw new Error('The connected workbench has no valid application process ID')
  return applicationPid
}

/** Discover only the loopback endpoint announced by this driver's fresh child. */
export function readInspectorEndpoint(child) {
  return new Promise((accept, reject) => {
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
}

/** Attach only to the fresh child paused by this driver's --inspect-brk argument. */
export async function inspectBeforeStart(child, expression, log = console.log) {
  const socketUrl = await readInspectorEndpoint(child)
  await withInspector(
    socketUrl,
    async (command, socket) => {
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
      await evaluate(command, typeof expression === 'function' ? expression(socketUrl) : expression)
      // Disabling removes the driver-owned pause state and resumes the child.
      await command('Debugger.disable')
      await command('Runtime.disable')
    },
    log
  )
  return socketUrl
}

/** Reconnect only to the current host belonging to this isolated release store. */
export async function inspectRunningApp(port, expectedPid, expression, log = console.log) {
  log('[desktop-e2e-inspector] identify host', { expectedPid, ports: port })
  if (Array.isArray(port)) port = await currentInspectorPort(port, expectedPid, log)
  log('[desktop-e2e-inspector] selected host', { expectedPid, port })
  const socketUrl = await inspectorTarget(port)
  return withInspector(
    socketUrl,
    async command => {
      const pid = await evaluate(command, 'process.pid')
      if (pid !== expectedPid)
        throw new Error('The inspector is connected to another release process')
      log('[desktop-e2e-inspector] execute assertion', { expectedPid, port })
      return evaluate(
        command,
        typeof expression === 'function' ? expression(port) : expression,
        true
      )
    },
    log
  )
}

/** Supervisors can retain an earlier handoff's arguments after a driver restart. */
async function currentInspectorPort(ports, expectedPid, log) {
  const matches = []
  for (const port of new Set(ports)) {
    const target = await inspectorTarget(port, true)
    if (!target) continue
    let pid
    try {
      pid = await withInspector(target, command => evaluate(command, 'process.pid'), log)
    } catch (error) {
      if (await inspectorTarget(port, true)) throw error
      log('[desktop-e2e-inspector] endpoint closed during identity check', { port })
      continue
    }
    log('[desktop-e2e-inspector] endpoint identity', { port, pid, expectedPid })
    if (pid === expectedPid) matches.push(port)
  }
  if (matches.length !== 1)
    throw new Error(
      `Expected exactly one registered inspector for host PID ${expectedPid}; found ${matches.length}`
    )
  return matches[0]
}

async function inspectorTarget(port, allowClosed = false) {
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535)
    throw new Error('The isolated inspector requires a registered TCP port')
  const origin = `http://127.0.0.1:${port}`
  let response
  try {
    response = await fetch(`${origin}/json/list`, { signal: AbortSignal.timeout(10_000) })
  } catch (cause) {
    if (allowClosed && cause.cause?.code === 'ECONNREFUSED') return null
    throw new Error(`The isolated inspector at port ${port} is unavailable`, { cause })
  }
  if (!response.ok) throw new Error(`The isolated inspector returned HTTP ${response.status}`)
  const targets = await response.json()
  if (targets.length !== 1) throw new Error('The isolated inspector must identify exactly one host')
  const socketUrl = targets[0].webSocketDebuggerUrl
  const target = new URL(socketUrl)
  if (target.protocol !== 'ws:' || target.hostname !== '127.0.0.1' || target.port !== String(port))
    throw new Error('The isolated inspector escaped its loopback endpoint')
  return socketUrl
}

async function evaluate(command, expression, awaitPromise = false) {
  const result = await command('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
  })
  if (result.exceptionDetails)
    throw new Error(`Inspector setup failed: ${result.exceptionDetails.text}`)
  return result.result?.value
}

async function withInspector(socketUrl, operation, log) {
  log('[desktop-e2e-inspector] connecting', socketUrl)
  const socket = new WebSocket(socketUrl)
  socket.addEventListener('close', () => log('[desktop-e2e-inspector] disconnected'))
  socket.addEventListener('message', event => {
    const { method, params } = JSON.parse(event.data)
    if (method === 'Debugger.paused') log('[desktop-e2e-inspector] paused', params.reason)
    else if (method === 'Debugger.resumed') log('[desktop-e2e-inspector] resumed')
  })
  let setupError
  try {
    await once(socket, 'open', { signal: AbortSignal.timeout(10_000) })
    let id = 0
    async function command(method, params = {}) {
      log('[desktop-e2e-inspector] command', method)
      const requestId = ++id
      const response = new Promise((accept, reject) => {
        const timer = setTimeout(
          () => finish(new Error(`Inspector command timed out: ${method}`)),
          10_000
        )
        const received = event => {
          const message = JSON.parse(event.data)
          if (message.id !== requestId) return
          log('[desktop-e2e-inspector] response', method, message.error ? 'error' : 'ok')
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
    return await operation(command, socket)
  } catch (error) {
    setupError = error
    throw error
  } finally {
    log('[desktop-e2e-inspector] disconnecting')
    if (socket.readyState !== WebSocket.CLOSED) {
      const disconnected = once(socket, 'close', { signal: AbortSignal.timeout(10_000) })
      socket.close()
      try {
        await disconnected
      } catch (error) {
        if (!setupError) throw error
        log('[desktop-e2e-inspector] disconnect failed', error.message)
      }
    }
  }
}
