import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { HostCapabilityRouter } from '../dist/host/capability-router.js'
import { HostPipeServer } from '../dist/host/host-pipe.js'
import { DesktopRuntime } from '../dist/runtime/desktop-runtime.js'

const runtimeRoot = process.argv[2]
const executorPath = process.argv[3]
if (!runtimeRoot || !executorPath) {
  throw new Error(
    'Usage: pnpm verify:core-runtime <materialized-core-runtime-root> <executor-binary>'
  )
}

const root = await mkdtemp(join(tmpdir(), 'wework-managed-runtime-'))
const router = new HostCapabilityRouter()
router.register('app.getVersion', () => ({ version: 'managed-runtime-smoke' }))
router.grant('@wegent/dsh-app-wework', ['app.getVersion'])
const runtime = new DesktopRuntime({
  environment: {
    ...process.env,
    DSH_TELEMETRY_DISABLED: '1',
    WEWORK_EXECUTOR_PATH: resolve(executorPath),
    WEWORK_HARNESS_RUNTIME_ROOT: resolve(runtimeRoot),
    WEWORK_NODE_PATH: process.execPath,
    WEGENT_EXECUTOR_HOME: join(root, 'executor-home'),
  },
  dataDirectory: join(root, 'user-data'),
  logDirectory: join(root, 'logs'),
  hostPipe: new HostPipeServer(router),
})

try {
  await runtime.start()
  const appUrl = runtime.coreDshUrl()
  const origin = runtime.coreDshOrigin()
  const description = await fetchJson(new URL('/wework/executor/v1', origin))
  if (description.protocolVersion !== 1 || description.executor?.protocol_version !== 1) {
    throw new Error(`Unexpected executor description: ${JSON.stringify(description)}`)
  }
  const health = await fetchJson(new URL('/wework/executor/v1/rpc', origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'executor.health', params: {} }),
  })
  if (
    health.ok !== true ||
    (health.result?.healthy !== true && health.result?.status !== 'healthy')
  ) {
    throw new Error(`Unexpected executor health: ${JSON.stringify(health)}`)
  }
  const host = await fetchJson(new URL('/wework/electron-host/v1/invoke', origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capability: 'app.getVersion', params: {} }),
  })
  if (host.result?.version !== 'managed-runtime-smoke') {
    throw new Error(`Unexpected Electron host response: ${JSON.stringify(host)}`)
  }
  const terminal = await verifyTerminalRuntime(origin, root)
  const appHtml = await fetchText(appUrl)
  if (
    !appHtml.includes('window.__WEWORK_RUNTIME_CONFIG__') ||
    !appHtml.includes('/wework/app/assets/')
  ) {
    throw new Error('Core DSH did not serve the packaged Wework application')
  }
  console.log(
    JSON.stringify(
      {
        coreDshOrigin: origin,
        coreDshUrl: appUrl,
        appHtmlBytes: Buffer.byteLength(appHtml),
        executorDeviceId: description.executor.device_id,
        executorTransports: description.executor.transports,
        health,
        host,
        terminal,
      },
      null,
      2
    )
  )
} catch (error) {
  let logNames = []
  try {
    logNames = await readdir(join(root, 'logs'))
  } catch {
    // The failed runtime may not have created its log directory yet.
  }
  for (const name of logNames) {
    try {
      console.error(`--- ${name} ---`)
      console.error(await readFile(join(root, 'logs', name), 'utf8'))
    } catch {
      // The failed runtime may not have created its log yet.
    }
  }
  throw error
} finally {
  await runtime.stop()
  await rm(root, { recursive: true, force: true })
}

async function fetchJson(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(
      `Invalid JSON from ${url}: HTTP ${response.status}, ${text || '<empty response>'}`
    )
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} at ${url}: ${JSON.stringify(body)}`)
  }
  return body
}

async function fetchText(url, init) {
  const response = await fetch(url, init)
  const body = await response.text()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} at ${url}: ${body}`)
  }
  return body
}

async function verifyTerminalRuntime(origin, cwd) {
  const description = await fetchJson(new URL('/wework/terminal/v1', origin))
  if (description.protocolVersion !== 1 || !description.capabilities?.includes('terminal.start')) {
    throw new Error(`Unexpected terminal description: ${JSON.stringify(description)}`)
  }
  const sessionId = `core-runtime-smoke-${process.pid}`
  const marker = `core-dsh-terminal-ready-${process.pid}`
  const events = []
  const controller = new AbortController()
  const eventReader = readServerSentEvents(
    new URL('/wework/terminal/v1/events', origin),
    event => events.push(event),
    controller.signal
  )
  try {
    await terminalRpc(origin, 'terminal.start', {
      session_id: sessionId,
      cwd,
      rows: 24,
      cols: 80,
    })
    await terminalRpc(origin, 'terminal.input', {
      session_id: sessionId,
      data: process.platform === 'win32' ? `Write-Output '${marker}'\r` : `printf '${marker}\\n'\r`,
    })
    await waitFor(() =>
      events.some(
        event =>
          event.event === 'terminal.output' && String(event.payload?.data ?? '').includes(marker)
      )
    )
    const snapshot = await terminalRpc(origin, 'terminal.snapshot', {
      session_id: sessionId,
    })
    if (!snapshot.data.includes(marker) || snapshot.sequence < 1) {
      throw new Error(`Unexpected terminal snapshot: ${JSON.stringify(snapshot)}`)
    }
    return {
      description,
      outputEventCount: events.filter(event => event.event === 'terminal.output').length,
      snapshotSequence: snapshot.sequence,
    }
  } finally {
    await terminalRpc(origin, 'terminal.close', { session_id: sessionId }).catch(() => {})
    controller.abort()
    await eventReader.catch(error => {
      if (error?.name !== 'AbortError') throw error
    })
  }
}

async function terminalRpc(origin, method, params) {
  const response = await fetchJson(new URL('/wework/terminal/v1/rpc', origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, params }),
  })
  if (response.ok !== true) {
    throw new Error(`Terminal RPC failed: ${JSON.stringify(response)}`)
  }
  return response.result
}

async function readServerSentEvents(url, onEvent, signal) {
  const response = await fetch(url, { signal })
  if (!response.ok || !response.body) {
    throw new Error(`Failed to connect terminal events: HTTP ${response.status}`)
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let pending = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    pending += value
    let boundary
    while ((boundary = pending.indexOf('\n\n')) >= 0) {
      const frame = pending.slice(0, boundary)
      pending = pending.slice(boundary + 2)
      const data = frame
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => line.slice(6))
        .join('\n')
      if (data) onEvent(JSON.parse(data))
    }
  }
}

async function waitFor(predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`)
}
